const {
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_TIMEOUT_SUGGESTIONS_MS
} = require("../config");

const {
  compactarBloque,
  limpiarSalidaHumana,
  normalizarTexto,
  normalizarEspacios,
  dedupeStrings,
  contarCaracteres
} = require("../lib/utils");

const {
  META_MISFIRE_RESPONSE_REGEX,
  limpiarTextoIA,
  esRespuestaBasura,
  contieneTemaEncuentro,
  violaReglasApertura,
  violaPropiedadHechosCliente,
  violaReglaContinuidad,
  esSugerenciaDebil,
  detectarElementosClave,
  analizarCliente,
  analizarMensajeOperador,
  construirLecturaCliente,
  construirLecturaOperador,
  filtrarContextoRelevante,
  limitarContexto,
  construirEstadoConversacion,
  detectarPermisosApertura,
  detectarIntencionOperador,
  construirGuiaIntencion,
  detectarTemaPropioOperador,
  parsearPerfilEstructurado,
  construirGuiaPerfil,
  detectarHechosClienteSensibles,
  extraerMencionesGeograficasOperador,
  esSolicitudContacto
} = require("../lib/text");

const { construirSystemPrompt } = require("../prompts/systemPrompt");
const { construirUserPrompt } = require("../prompts/userPrompt");
const { llamarOpenAI } = require("./openai");

const LENGTH_PROFILES = {
  corto: { min: 55, max: 120, ideal: 85 },
  medio: { min: 90, max: 180, ideal: 130 },
  largo: { min: 150, max: 280, ideal: 210 }
};

const CONTACTO_REGEX =
  /\b(whatsapp|telegram|phone|number|numero|telefono|instagram|facebook|snapchat|snap|discord|mail|correo|email|contact|wechat|line|kik|skype|intercambiar numeros|pasarte mi numero|darte mi numero|hablar por fuera|escribir por fuera)\b/i;

const GHOSTING_REGEX =
  /\b(visto|me dejaste en visto|me has dejado en visto|no respondes|no me respondes|no me contestas|desapareciste|te perdi|sigues ahi|por que no respondes|sinfin de mensajes|sinfIn de mensajes|no he obtenido respuesta)\b/i;

const MEDIA_REGEX =
  /\b(foto|selfie|imagen|video|audio|voz|pic|picture|photo|snapshot|voice note)\b/i;

const CONFLICT_REGEX =
  /\b(discutir|discutiendo|discusion|pelea|malentendido|si esto va a ser asi|frustrante|cortamos|relacion aqui|bothering|boring you|sorry for bothering|dinamica|tension)\b/i;

const MULETILLA_REGEX =
  /\b(me gustaria saber mas de ti|mas sobre ti|me encantaria hablar contigo|podemos encontrar un terreno comun|lo que te inspira|lo que te apasiona|seguir conversando|me gustaria conocer mas de ti)\b/i;

const FRASES_ROBOTICAS_REGEX =
  /\b(no queria dejarte algo frio ni comun|preferi escribirte mejor|me quede pensando en lo ultimo que compartiste|responderte con mas intencion|con mas calma|con mas naturalidad|lo reformulo mejor|piloto automatico|tu mejor energia|tu mejor vibra|forma de ver las cosas)\b/i;

const STOPWORDS_ANCLA = new Set([
  "hola", "como", "estas", "esta", "pero", "porque", "por", "para", "quiero",
  "saber", "gustaria", "hablar", "conversar", "mensaje", "mensajes", "respuesta",
  "respuestas", "quieres", "quiero", "tengo", "tiene", "tener", "buen", "buena",
  "sobre", "algo", "este", "esta", "esto", "esas", "esos", "aqui", "alla",
  "muy", "poco", "mucho", "tambien", "solo", "igual", "donde", "cuando"
]);

const STATUS_OR_DATE_REGEX =
  /\b(married|not married|widowed|divorced|people aged|looking for|bio|present requests|newsfeed|icebreakers|manage media|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

function sumarUsage(...datas) {
  const usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  datas.forEach((data) => {
    const u = data?.usage || {};
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.total_tokens += u.total_tokens || 0;
  });

  return { usage };
}

function extraerPrimerJson(texto = "") {
  const raw = String(texto || "").trim();
  if (!raw) return null;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

function palabrasCount(texto = "") {
  return normalizarEspacios(texto).split(/\s+/).filter(Boolean).length;
}

function tokenizarAnchor(anchor = "") {
  return normalizarTexto(anchor)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_ANCLA.has(w));
}

function tieneAnclaReal(sugerencia = "", anchor = "") {
  const tokens = tokenizarAnchor(anchor);
  if (!tokens.length) return true;

  const salida = new Set(normalizarTexto(sugerencia).split(/\s+/).filter(Boolean));
  return tokens.some((t) => salida.has(t));
}

function extraerUbicacionVisiblePerfil(perfilEstructurado = {}) {
  const intereses = new Set([
    ...(perfilEstructurado?.interesesEnComun || []),
    ...(perfilEstructurado?.interesesClienta || [])
  ].map((x) => normalizarTexto(x)));

  const datos = perfilEstructurado?.datosClienta || [];

  for (const raw of datos) {
    const limpio = limpiarSalidaHumana(raw || "");
    const norm = normalizarTexto(limpio);

    if (!norm) continue;
    if (intereses.has(norm)) continue;
    if (/\d/.test(norm)) continue;
    if (STATUS_OR_DATE_REGEX.test(norm)) continue;
    if (limpio.length > 36) continue;

    return limpio;
  }

  return "";
}

function construirObjetivoLongitud(caso = {}) {
  const palabras = palabrasCount(caso.textoPlano || "");
  const textoLen = contarCaracteres(caso.textoPlano || "");
  const clienteLen = contarCaracteres(caso.clientePlano || "");

  const hasInterest =
    Boolean(caso.perfilEstructurado?.interesesEnComun?.length) ||
    Boolean(caso.perfilEstructurado?.interesesClienta?.length);

  const hasLocation = Boolean(extraerUbicacionVisiblePerfil(caso.perfilEstructurado));
  const simpleDirect = Boolean(caso.analisisOperador?.preguntaSimpleDirecta);

  const complexMode = ["GHOSTING", "CONFLICT_REFRAME", "CONTACT_BLOCK"].includes(caso.mode);
  const complexDraft =
    Boolean(caso.analisisOperador?.metaEdicion) ||
    Boolean(caso.analisisOperador?.reclamo) ||
    Boolean(caso.analisisOperador?.mezclaDeIdeas) ||
    textoLen > 135;

  const shortByProfile = simpleDirect && (hasInterest || hasLocation);
  const shortByReply =
    caso.anclarEnUltimoMensajeCliente &&
    palabras <= 8 &&
    clienteLen <= 120;

  let profile = "medio";

  if (complexMode || complexDraft) {
    profile = "largo";
  } else if (shortByProfile || shortByReply || (simpleDirect && palabras <= 10)) {
    profile = "corto";
  } else if (textoLen <= 60 && (hasInterest || hasLocation)) {
    profile = "corto";
  }

  const shapeMap = {
    corto: "observacion breve + pregunta corta",
    medio: "reaccion concreta + una pregunta o remate ligero",
    largo: "reconocimiento breve + punto concreto + cierre ligero"
  };

  const instructionMap = {
    corto: "Si el caso es simple, no lo conviertas en discurso. Responde directo.",
    medio: "Desarrolla lo justo. Que se sienta natural y no relleno.",
    largo: "Solo en casos complejos vale desarrollar un poco mas, pero sin sonar pesado."
  };

  return {
    profile,
    ...LENGTH_PROFILES[profile],
    shape: shapeMap[profile],
    instruction: instructionMap[profile]
  };
}

function normalizarSugerenciaPremium(texto = "") {
  return limpiarSalidaHumana(String(texto || "").replace(/\n+/g, " ").trim());
}

function extraerPrimeraSugerenciaPremium(raw = "") {
  const limpias = limpiarTextoIA(raw)
    .map(normalizarSugerenciaPremium)
    .filter((s) => !esRespuestaBasura(s));

  if (limpias.length) {
    return limpias[0];
  }

  return normalizarSugerenciaPremium(raw);
}

function cumpleLongitudPremium(texto = "", objetivoLongitud = LENGTH_PROFILES.medio) {
  const total = contarCaracteres(texto);
  const min = objetivoLongitud?.min || LENGTH_PROFILES.medio.min;
  const max = objetivoLongitud?.max || LENGTH_PROFILES.medio.max;

  return total >= min && total <= max;
}

function esMetaRobotica(texto = "") {
  return FRASES_ROBOTICAS_REGEX.test(normalizarTexto(texto || ""));
}

function violaReglaContactoExterno(sugerencia = "", caso = {}) {
  if (!caso.temaContactoExterno) return false;

  const t = normalizarTexto(sugerencia);
  if (CONTACTO_REGEX.test(t)) return true;

  return !/\b(aqui|por aqui|seguir aqui|mejor aqui|prefiero aqui|aqui mismo)\b/.test(t);
}

function violaReglaModo(sugerencia = "", caso = {}) {
  const t = normalizarTexto(sugerencia);

  if (caso.mode === "MEDIA_REPLY" && !tieneAnclaReal(sugerencia, caso.anchor)) {
    return true;
  }

  if (caso.mode === "GHOSTING" && /\b(inspir|apasion|terreno comun|mas sobre ti)\b/.test(t)) {
    return true;
  }

  if (caso.mode === "CONTACT_BLOCK" && !/\b(aqui|por aqui|mejor aqui|prefiero aqui)\b/.test(t)) {
    return true;
  }

  return false;
}

function filtrarSugerenciasFinales(sugerencias = [], caso = {}) {
  return (Array.isArray(sugerencias) ? sugerencias : [])
    .map(normalizarSugerenciaPremium)
    .filter(Boolean)
    .filter((s) => cumpleLongitudPremium(s, caso.objetivoLongitud))
    .filter((s) => !esMetaRobotica(s))
    .filter((s) => !contieneTemaEncuentro(s))
    .filter((s) => !violaReglasApertura(s, caso.permisosApertura))
    .filter((s) => !violaPropiedadHechosCliente(s, caso.hechosClienteSensibles, caso.textoPlano))
    .filter((s) => !violaReglaContinuidad(s, caso.estadoConversacion, caso.operadorTraeTemaPropio))
    .filter((s) => !violaReglaContactoExterno(s, caso))
    .filter((s) => !violaReglaModo(s, caso))
    .filter((s) => !MULETILLA_REGEX.test(normalizarTexto(s)))
    .filter((s) => !META_MISFIRE_RESPONSE_REGEX.test(normalizarTexto(s)))
    .filter((s) => !esSugerenciaDebil(
      s,
      caso.textoPlano,
      caso.elementosClave,
      caso.permisosApertura,
      caso.estadoConversacion,
      caso.operadorTraeTemaPropio
    ));
}

function detectarModeHeuristico(caso = {}) {
  const bloque = [
    caso.textoPlano || "",
    caso.clientePlano || "",
    ...(caso.lineasClienteRecientes || []),
    ...(caso.lineasOperadorRecientes || [])
  ].join(" \n ");

  if (caso.temaContactoExterno) return "CONTACT_BLOCK";
  if (MEDIA_REGEX.test(bloque)) return "MEDIA_REPLY";
  if (GHOSTING_REGEX.test(caso.textoPlano || "")) return "GHOSTING";
  if (CONFLICT_REGEX.test(bloque)) return "CONFLICT_REFRAME";
  if (!caso.estadoConversacion?.hayConversacionReal) return "NEW_CHAT";
  if (caso.anclarEnUltimoMensajeCliente) return "REPLY_LAST_MESSAGE";
  if (!caso.operadorTraeTemaPropio && (
    (caso.perfilEstructurado?.interesesEnComun || []).length ||
    (caso.perfilEstructurado?.interesesClienta || []).length
  )) {
    return "PROFILE_SUPPORT";
  }

  return "DEFAULT";
}

function detectarAnchorHeuristico(caso = {}, mode = "DEFAULT") {
  if (mode === "CONTACT_BLOCK") {
    const cand = [
      caso.clientePlano,
      ...(caso.lineasClienteRecientes || []),
      caso.textoPlano
    ].find((x) => CONTACTO_REGEX.test(x || ""));
    return cand
      ? limpiarSalidaHumana(cand).slice(0, 180)
      : "mantener la conversacion dentro de la app y redirigir a un tema concreto";
  }

  if (mode === "MEDIA_REPLY") {
    const cand = [
      caso.textoPlano,
      caso.clientePlano,
      ...(caso.lineasClienteRecientes || [])
    ].find((x) => MEDIA_REGEX.test(x || ""));
    if (cand) return limpiarSalidaHumana(cand).slice(0, 180);
  }

  if (mode === "GHOSTING") {
    return limpiarSalidaHumana(caso.textoPlano || "").slice(0, 180);
  }

  if (mode === "CONFLICT_REFRAME") {
    const cand = [
      caso.textoPlano,
      caso.clientePlano,
      ...(caso.lineasClienteRecientes || [])
    ].find((x) => CONFLICT_REGEX.test(x || ""));
    if (cand) return limpiarSalidaHumana(cand).slice(0, 180);
    return "hay tension o malentendido y la respuesta debe bajar la friccion";
  }

  if (caso.anclarEnUltimoMensajeCliente && caso.lineasClienteRecientes?.length) {
    return limpiarSalidaHumana(caso.lineasClienteRecientes[caso.lineasClienteRecientes.length - 1]).slice(0, 180);
  }

  if (caso.operadorTraeTemaPropio && caso.textoPlano) {
    return limpiarSalidaHumana(caso.textoPlano).slice(0, 180);
  }

  const ubicacion = extraerUbicacionVisiblePerfil(caso.perfilEstructurado);
  if (ubicacion) {
    return `dato visible del perfil: ${ubicacion}`;
  }

  const interes =
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  if (interes) {
    return `interes del perfil: ${interes}`;
  }

  return "anclarse al borrador del operador sin volverse abstracto";
}

function planHeuristico(caso = {}) {
  const mode = detectarModeHeuristico(caso);
  const anchor = detectarAnchorHeuristico(caso, mode);

  const useProfileInterest =
    mode === "NEW_CHAT" ||
    mode === "PROFILE_SUPPORT";

  const chosenInterest =
    useProfileInterest
      ? (
          caso.perfilEstructurado?.interesesEnComun?.[0] ||
          caso.perfilEstructurado?.interesesClienta?.[0] ||
          ""
        )
      : "";

  const forbidden = [
    "muletillas abstractas",
    "continuidad falsa",
    "desviarse del ancla"
  ];

  if (caso.temaContactoExterno) forbidden.push("repetir numero o validar contacto externo");

  const summaryMap = {
    NEW_CHAT: "entrada concreta y facil de responder",
    REPLY_LAST_MESSAGE: "responder primero a lo ultimo que ella dijo",
    GHOSTING: "reapertura segura, concreta y sin resentimiento",
    CONTACT_BLOCK: "mantener la charla dentro de la app con redireccion concreta",
    MEDIA_REPLY: "anclarse al contenido multimedia antes que al perfil",
    CONFLICT_REFRAME: "bajar tension y responder con tacto",
    PROFILE_SUPPORT: "usar un interes concreto como apoyo, no como muletilla",
    DEFAULT: "seguir el borrador real y evitar deriva generica"
  };

  return {
    mode,
    anchor,
    use_profile_interest: Boolean(chosenInterest),
    chosen_interest: chosenInterest,
    summary: summaryMap[mode] || summaryMap.DEFAULT,
    forbidden
  };
}

async function planificarCaso(caso = {}) {
  const plannerSystem = `
Eres un analista conversacional para un operador que escribe a una clienta dentro de una app.
No redactas el mensaje final.
Solo devuelves un JSON corto y util.

MODOS VALIDOS
NEW_CHAT
REPLY_LAST_MESSAGE
GHOSTING
CONTACT_BLOCK
MEDIA_REPLY
CONFLICT_REFRAME
PROFILE_SUPPORT
DEFAULT

OBJETIVO
Clasificar el caso correctamente y fijar una ancla obligatoria.
La ancla debe ser concreta, no abstracta.

REGLAS
- Si hay contacto externo, prioriza CONTACT_BLOCK
- Si hay foto, video, audio o imagen como tema real, prioriza MEDIA_REPLY
- Si el borrador habla de dejar en visto o silencio, prioriza GHOSTING
- Si hay tension o malentendido, usa CONFLICT_REFRAME
- Si no hay respuesta real previa, usa NEW_CHAT
- Si hay ultimo mensaje real de la clienta y el operador no trae tema propio, usa REPLY_LAST_MESSAGE
- PROFILE_SUPPORT solo si el perfil realmente ayuda
- No inventes datos
- Devuelve solo JSON valido
`.trim();

  const plannerUser = `
BORRADOR
${caso.textoPlano}

ULTIMO MENSAJE REAL DE LA CLIENTA
${caso.clientePlano || "Sin mensaje claro"}

ULTIMAS LINEAS DE CLIENTA
${(caso.lineasClienteRecientes || []).join(" | ") || "Sin lineas"}

CONTEXTO
${caso.contextoPlano || "Sin contexto"}

INTERESES_EN_COMUN
${(caso.perfilEstructurado?.interesesEnComun || []).join(" | ") || "Ninguno"}

INTERESES_CLIENTA
${(caso.perfilEstructurado?.interesesClienta || []).join(" | ") || "Ninguno"}

DATOS_CLIENTA
${(caso.perfilEstructurado?.datosClienta || []).join(" | ") || "Ninguno"}

DATOS
hay_conversacion_real=${caso.estadoConversacion?.hayConversacionReal ? "si" : "no"}
operador_trae_tema_propio=${caso.operadorTraeTemaPropio ? "si" : "no"}
tema_contacto_externo=${caso.temaContactoExterno ? "si" : "no"}

Devuelve este JSON:
{
  "mode": "",
  "anchor": "",
  "use_profile_interest": false,
  "chosen_interest": "",
  "summary": "",
  "forbidden": []
}
`.trim();

  const data = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      { role: "system", content: plannerSystem },
      { role: "user", content: plannerUser }
    ],
    temperature: 0.1,
    maxTokens: 120,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const parsed = extraerPrimerJson(data?.choices?.[0]?.message?.content || "");

  if (!parsed || !parsed.mode || !parsed.anchor) {
    return {
      plan: planHeuristico(caso),
      usageData: data
    };
  }

  return {
    plan: {
      mode: String(parsed.mode || "DEFAULT").trim(),
      anchor: limpiarSalidaHumana(String(parsed.anchor || "")),
      use_profile_interest: Boolean(parsed.use_profile_interest),
      chosen_interest: limpiarSalidaHumana(String(parsed.chosen_interest || "")),
      summary: limpiarSalidaHumana(String(parsed.summary || "")),
      forbidden: Array.isArray(parsed.forbidden)
        ? parsed.forbidden.map((x) => limpiarSalidaHumana(String(x || ""))).filter(Boolean).slice(0, 8)
        : []
    },
    usageData: data
  };
}

function prepararCasoSugerencias({
  operador = "",
  texto = "",
  contexto = "",
  cliente = "",
  perfil = ""
}) {
  const elementosClave = detectarElementosClave(texto);
  const analisisCliente = analizarCliente(cliente);
  const analisisOperador = analizarMensajeOperador(texto);

  const lecturaCliente = construirLecturaCliente(analisisCliente);

  const contextoFiltrado = filtrarContextoRelevante(contexto, texto, cliente);
  const textoPlano = compactarBloque(texto, 820);
  const clientePlano = compactarBloque(cliente, 520);
  const contextoPlano = compactarBloque(
    limitarContexto(contextoFiltrado),
    900
  );
  const perfilPlano = compactarBloque(
    limitarContexto(perfil),
    420
  );

  const estadoConversacion = construirEstadoConversacion(clientePlano, contextoPlano);
  const permisosApertura = detectarPermisosApertura({
    texto,
    cliente: clientePlano,
    contexto: contextoPlano,
    estadoConversacion
  });

  const intencionOperador = detectarIntencionOperador(
    texto,
    clientePlano,
    contextoPlano,
    estadoConversacion
  );
  const guiaIntencion = construirGuiaIntencion(intencionOperador);

  const metaEdicion = analisisOperador.metaEdicion;
  const ghostwriterMode = analisisOperador.ghostwriterMode;
  const operadorTraeTemaPropio = detectarTemaPropioOperador(texto, analisisOperador);

  const perfilEstructurado = parsearPerfilEstructurado(perfilPlano);
  const esChatNuevoOperativo = estadoConversacion.esChatNuevoOperativo;
  const guiaPerfil = construirGuiaPerfil(perfilEstructurado, esChatNuevoOperativo);

  const lineasClienteRecientes = dedupeStrings(
    estadoConversacion.lineasClienta.slice(-3)
  ).slice(-3);

  const lineasOperadorRecientes = dedupeStrings(
    estadoConversacion.lineasOperador.slice(-3)
  ).slice(-3);

  const anclarEnUltimoMensajeCliente =
    estadoConversacion.hayConversacionReal &&
    !operadorTraeTemaPropio &&
    lineasClienteRecientes.length > 0;

  const lecturaOperador = [
    construirLecturaOperador(analisisOperador),
    !estadoConversacion.hayConversacionReal
      ? "No hay respuesta real de la clienta. Convierte el texto en un enganche directo."
      : "",
    anclarEnUltimoMensajeCliente
      ? "Hay mensajes recientes de la clienta y el operador no trae un tema nuevo claro. Prioriza lo ultimo que ella dijo."
      : ""
  ].filter(Boolean).join(" ");

  const hechosClienteSensibles = detectarHechosClienteSensibles(lineasClienteRecientes);
  const mencionesGeograficasOperador = extraerMencionesGeograficasOperador(texto);
  const contactoEnBorrador = esSolicitudContacto(texto);
  const temaContactoExterno = Boolean(analisisCliente.contacto || contactoEnBorrador);

  const baseCaso = {
    operador,
    texto,
    contexto,
    cliente,
    perfil,
    textoPlano,
    clientePlano,
    contextoPlano,
    perfilPlano,
    elementosClave,
    analisisCliente,
    analisisOperador,
    lecturaCliente,
    lecturaOperador,
    tonoCliente: analisisCliente.tono,
    contactoExterno: analisisCliente.contacto,
    contactoEnBorrador,
    temaContactoExterno,
    estadoConversacion,
    permisosApertura,
    intencionOperador,
    guiaIntencion,
    metaEdicion,
    ghostwriterMode,
    operadorTraeTemaPropio,
    perfilEstructurado,
    esChatNuevoOperativo,
    guiaPerfil,
    lineasClienteRecientes,
    lineasOperadorRecientes,
    anclarEnUltimoMensajeCliente,
    hechosClienteSensibles,
    mencionesGeograficasOperador
  };

  const heuristico = planHeuristico(baseCaso);
  const ubicacionVisiblePerfil = extraerUbicacionVisiblePerfil(perfilEstructurado);
  const objetivoLongitud = construirObjetivoLongitud({
    ...baseCaso,
    mode: heuristico.mode
  });

  const fingerprint = [
    "premium-planner-writer-v2-dynamic",
    heuristico.mode,
    objetivoLongitud.profile,
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 260),
    normalizarTexto(contextoPlano).slice(-500),
    normalizarTexto(perfilPlano).slice(0, 260)
  ].join("||");

  return {
    ...baseCaso,
    mode: heuristico.mode,
    anchor: heuristico.anchor,
    ubicacionVisiblePerfil,
    objetivoLongitud,
    fingerprint
  };
}

function construirFallbackSugerencias(caso = {}) {
  const perfil = caso.objetivoLongitud?.profile || "medio";
  const interes =
    caso.plan?.chosen_interest ||
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const ubicacion =
    caso.ubicacionVisiblePerfil ||
    extraerUbicacionVisiblePerfil(caso.perfilEstructurado);

  const maps = {
    corto: {
      CONTACT_BLOCK: [
        "Mejor sigamos por aqui. Ya que estamos, que tipo de charla te engancha de verdad cuando alguien te escribe?"
      ],
      GHOSTING: [
        "No pasa nada si te alejaste un poco. Solo me dio curiosidad saber si fue el momento o si esto no te movio demasiado."
      ],
      MEDIA_REPLY: [
        "Lo que mandaste me dejo curiosidad. Que fue lo que mas te gusto a ti de ese momento?"
      ],
      CONFLICT_REFRAME: [
        "No quiero que esto se vaya al choque. Que fue exactamente lo que te molesto?"
      ],
      NEW_CHAT: ubicacion
        ? [`Vi que eres de ${ubicacion}. Siempre me ha dado curiosidad ese lugar. Que es lo que mas te gusta de vivir ahi?`]
        : interes
          ? [`Vi que te gusta ${String(interes).toLowerCase()}. Que es lo que mas te engancha de eso?`]
          : ["Te pregunto algo simple: que es lo primero que te suele llamar la atencion de alguien?"],
      REPLY_LAST_MESSAGE: [
        "Eso que dijiste me dejo curiosidad. Siempre hablas asi de directo o fue por el momento?"
      ],
      PROFILE_SUPPORT: ubicacion
        ? [`Vi que eres de ${ubicacion}. No se escucha tanto sobre ese lugar y me dio curiosidad. Que es lo mejor de estar ahi?`]
        : interes
          ? [`Vi lo de ${String(interes).toLowerCase()} en tu perfil. Lo sigues por gusto general o hay algo puntual que te engancha?`]
          : ["Vi un detalle en tu perfil que me dio curiosidad. Que parte de ti dirias que casi siempre llama la atencion?"],
      DEFAULT: interes
        ? [`Vi que te gusta ${String(interes).toLowerCase()}. Hay algo en especial de eso que sigas mas de cerca?`]
        : ["Te hago una simple: que clase de charla suele engancharte mas cuando alguien te escribe?"]
    },
    medio: {
      CONTACT_BLOCK: [
        "Podemos dejar el cambio de app para mas adelante; por aqui estoy bien. Mejor dime algo mas util para seguir la charla: que detalle tuyo suele salir rapido cuando de verdad estas comoda hablando con alguien?"
      ],
      GHOSTING: [
        "No voy a hacer drama por el silencio, pero si retomamos prefiero que sea con algo que si valga la pena. Me dio curiosidad saber si contigo el problema fue el momento o simplemente que esto no termino de enganchar."
      ],
      MEDIA_REPLY: [
        "Lo que compartiste tiene un detalle que cambia bastante la impresion, y por eso me dio mas curiosidad el contexto que lo obvio. Que parte de ese momento fue la que mas te gusto a ti cuando decidiste mostrarlo?"
      ],
      CONFLICT_REFRAME: [
        "No quiero que esto se quede en una lectura torpe o en un tono mas pesado de la cuenta. Si hay algo rescatable aqui, prefiero entender que fue exactamente lo que te hizo reaccionar asi."
      ],
      NEW_CHAT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me dio curiosidad porque es uno de esos lugares que llaman la atencion enseguida. Que es lo que mas te gusta de vivir ahi o lo que mas sientes que la gente no imagina de ese lugar?`]
        : interes
          ? [`Vi que te gusta ${String(interes).toLowerCase()} y me parecio mejor entrar por ahi que tirar una frase comun. Cuando alguien tiene un gusto asi de claro, casi siempre hay algo concreto detras. Que es lo que mas te engancha de eso?`]
          : ["Prefiero ir por algo mas concreto que una entrada comun. Cual dirias que es ese detalle tuyo que suele hacer una charla mucho mas interesante cuando alguien lo sabe ver?"],
      REPLY_LAST_MESSAGE: [
        "Eso que dijiste cambia bastante el tono de la charla y por eso no da para responder con cualquier cosa. Me dejo curiosidad saber si siempre hablas asi de directo o si te sale solo cuando algo de verdad te interesa."
      ],
      PROFILE_SUPPORT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me fui por eso porque me parecio mejor punto de partida que una frase comun. Hay lugares que dicen bastante de alguien. Que es lo que mas sientes que te representa de estar ahi?`]
        : interes
          ? [`Vi lo de ${String(interes).toLowerCase()} en tu perfil y me parecio mejor ir por algo concreto. A veces un gusto bien marcado dice bastante mas que una presentacion armada. Que es lo que mas te atrapa de eso?`]
          : ["Vi un detalle en tu perfil que me parecio mejor punto de partida que cualquier frase comun. Cuando alguien deja algo asi, casi siempre hay mas fondo del que parece. Que dirias que dice de ti?"],
      DEFAULT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me parecio mas interesante tirar por ahi que por una entrada cualquiera. Hay lugares que enseguida despiertan curiosidad. Que es lo que mas te gusta de ese lado tuyo?`]
        : interes
          ? [`Vi que te gusta ${String(interes).toLowerCase()} y eso me parecio mejor punto de partida que una frase comun. Lo sigues de manera casual o es de esas cosas que de verdad te atrapan cuando te metes?`]
          : ["Prefiero ir por algo concreto antes que por una entrada comun. A veces una charla cambia por un detalle simple, y me dio curiosidad saber cual dirias que es ese detalle contigo."]
    },
    largo: {
      CONTACT_BLOCK: [
        "Entiendo que prefieras mover la charla, pero por ahora me siento mejor siguiendo por aqui. No hace falta complicarlo mas: si te apetece, cuentame algo concreto de ti que si valga la pena y que nos saque de hablar solo del cambio de app."
      ],
      GHOSTING: [
        "No voy a hacer drama por el silencio ni convertir esto en un reclamo. Si te escribo otra vez, prefiero que sea con algo que tenga sentido: me quede con curiosidad de saber si esto se enfrio por el momento o si simplemente no aparecio todavia ese detalle que si te enganche de verdad."
      ],
      MEDIA_REPLY: [
        "Lo que compartiste deja una impresion bastante mas clara que cualquier frase armada, y por eso me dio mas curiosidad el contexto que lo obvio. A veces un detalle asi dice bastante de una persona, asi que me interesa saber que era exactamente lo que mas te gustaba de ese momento."
      ],
      CONFLICT_REFRAME: [
        "No quiero que esto se quede en un tono torpe o en una lectura que termine pesando mas de la cuenta. Si aqui hubo un malentendido, prefiero bajarle un poco al choque y entender mejor que fue lo que te hizo reaccionar asi, porque ahi suele estar lo importante."
      ],
      NEW_CHAT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me llamo mas la atencion eso que cualquier entrada comun. Hay lugares que de inmediato despiertan curiosidad porque no se escuchan todos los dias, y me interesa saber que es lo que mas te gusta de vivir ahi o lo que mas sientes que la gente no imagina.`]
        : interes
          ? [`Vi que te gusta ${String(interes).toLowerCase()} y me parecio mejor entrar por ahi que tirar una frase cualquiera. Cuando alguien tiene un gusto tan claro, casi siempre hay una parte de su forma de ser metida en eso. Me dio curiosidad saber que es lo que mas te engancha de verdad.`]
          : ["No queria ir por una entrada comun ni por una frase copiada. Hay perfiles que no dicen gran cosa y otros donde un detalle basta para abrir una charla mejor; aqui senti mas lo segundo, y me dio curiosidad saber que parte de ti dirias que casi siempre vale la pena descubrir primero."],
      REPLY_LAST_MESSAGE: [
        "Eso que dijiste cambia bastante el tono de la charla y por eso no da para responderlo con cualquier cosa. Me dejo con curiosidad de entender mejor desde donde te sale esa forma de decirlo, porque a veces ahi es donde aparece lo mas interesante de una conversacion."
      ],
      PROFILE_SUPPORT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me parecio mucho mejor punto de partida que una frase comun. Hay lugares que ya de por si despiertan curiosidad, pero lo interesante de verdad es lo que terminan diciendo de alguien. Me interesa saber que es lo que mas sientes que te representa de estar ahi.`]
        : interes
          ? [`Vi lo de ${String(interes).toLowerCase()} en tu perfil y me fui por algo mas concreto que una entrada tipica. A veces un gusto asi esta puesto por adorno y otras veces dice bastante de alguien; me dio la impresion de que aqui va mas por lo segundo. Que es lo que mas te atrapa de eso?`]
          : ["Vi un detalle en tu perfil que me parecio mejor punto de partida que cualquier frase comun. Cuando alguien deja algo asi, casi siempre hay mas fondo del que parece, y me dio curiosidad saber que parte de ti es la que mas suele sorprender cuando te conocen un poco mejor."],
      DEFAULT: ubicacion
        ? [`Vi que eres de ${ubicacion} y me parecio mas interesante tirar por ahi que por una entrada cualquiera. Hay lugares que ya de por si llaman la atencion, pero lo que de verdad da juego en una charla es lo que una persona deja ver desde ese detalle. Que es lo que mas te gusta de ese lado tuyo?`]
        : interes
          ? [`Vi que te gusta ${String(interes).toLowerCase()} y eso me parecio mejor punto de partida que una frase comun. Cuando alguien tiene un gusto asi de claro, casi siempre hay algo real detras de eso, y me dio curiosidad saber que es lo que mas te engancha cuando de verdad te metes en ese tema.`]
          : ["No queria tirar una entrada comun ni quedarme en algo vacio. A veces una charla cambia no por decir mucho, sino por tocar justo el detalle que si despierta interes, y aqui me dio curiosidad saber cual dirias que es ese detalle contigo."]
    }
  };

  return maps[perfil]?.[caso.mode] || maps[perfil]?.DEFAULT || maps.medio.DEFAULT;
}

async function generarSugerencias(caso = {}) {
  const planned = await planificarCaso(caso);
  const plan = planned.plan || planHeuristico(caso);

  caso.mode = plan.mode || caso.mode || "DEFAULT";
  caso.anchor = plan.anchor || caso.anchor || detectarAnchorHeuristico(caso, caso.mode);
  caso.plan = plan;
  caso.ubicacionVisiblePerfil = caso.ubicacionVisiblePerfil || extraerUbicacionVisiblePerfil(caso.perfilEstructurado);
  caso.objetivoLongitud = construirObjetivoLongitud(caso);

  const userPrompt = construirUserPrompt({
    mode: caso.mode,
    anchor: caso.anchor,
    planSummary: plan.summary || "",
    textoPlano: caso.textoPlano,
    clientePlano: caso.clientePlano,
    contextoPlano: caso.contextoPlano,
    lecturaCliente: caso.lecturaCliente,
    lecturaOperador: caso.lecturaOperador,
    tonoCliente: caso.tonoCliente,
    contactoExterno: caso.contactoExterno,
    contactoEnBorrador: caso.contactoEnBorrador,
    elementosClave: caso.elementosClave,
    intencionOperador: caso.intencionOperador,
    guiaIntencion: caso.guiaIntencion,
    metaEdicion: caso.metaEdicion,
    ghostwriterMode: caso.ghostwriterMode,
    perfilEstructurado: caso.perfilEstructurado,
    guiaPerfil: caso.guiaPerfil,
    esChatNuevoOperativo: caso.esChatNuevoOperativo,
    lineasClienteRecientes: caso.lineasClienteRecientes,
    lineasOperadorRecientes: caso.lineasOperadorRecientes,
    mencionesGeograficasOperador: caso.mencionesGeograficasOperador,
    estadoConversacion: caso.estadoConversacion,
    operadorTraeTemaPropio: caso.operadorTraeTemaPropio,
    anclarEnUltimoMensajeCliente: caso.anclarEnUltimoMensajeCliente,
    permisosApertura: caso.permisosApertura,
    objetivoLongitud: caso.objetivoLongitud,
    ubicacionVisiblePerfil: caso.ubicacionVisiblePerfil
  });

  const maxTokensByProfile = {
    corto: 90,
    medio: 130,
    largo: 180
  };

  const temperatureByProfile = {
    corto: 0.42,
    medio: caso.ghostwriterMode ? 0.58 : 0.52,
    largo: caso.ghostwriterMode ? 0.62 : 0.56
  };

  const dataWriter = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(
          caso.permisosApertura,
          caso.elementosClave,
          caso.mode,
          caso.objetivoLongitud
        )
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    temperature: temperatureByProfile[caso.objetivoLongitud.profile] || 0.52,
    maxTokens: maxTokensByProfile[caso.objetivoLongitud.profile] || 130,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const candidata = extraerPrimeraSugerenciaPremium(
    dataWriter?.choices?.[0]?.message?.content || ""
  );

  const sugerencias = filtrarSugerenciasFinales([candidata], caso);

  if (sugerencias.length) {
    return {
      sugerencias: [sugerencias[0]],
      usageData: sumarUsage(planned.usageData, dataWriter)
    };
  }

  const fallback = filtrarSugerenciasFinales(
    construirFallbackSugerencias(caso),
    caso
  );

  if (fallback.length) {
    return {
      sugerencias: [fallback[0]],
      usageData: sumarUsage(planned.usageData, dataWriter)
    };
  }

  const ultimoRecurso = caso.objetivoLongitud.profile === "corto"
    ? ["Te hago una simple: que es lo que mas te llama la atencion de una charla cuando alguien si te interesa?"]
    : caso.estadoConversacion.hayConversacionReal
      ? ["Eso que dijiste cambia bastante el tono de la charla, y por eso prefiero seguir justo por ahi en vez de responder con algo vacio. Me dejo curiosidad real saber desde donde te sale esa forma de verlo."]
      : ["Vi un detalle aqui que da mas para una charla con sustancia que para una entrada comun. Por eso me dio curiosidad saber que parte de ti dirias que casi siempre vale la pena descubrir primero."];

  return {
    sugerencias: [ultimoRecurso[0]],
    usageData: sumarUsage(planned.usageData, dataWriter)
  };
}

module.exports = {
  sumarUsage,
  prepararCasoSugerencias,
  filtrarSugerenciasFinales,
  generarSugerencias,
  construirFallbackSugerencias,
  normalizarSugerenciaPremium,
  cumpleLongitudPremium,
  construirObjetivoLongitud
};
