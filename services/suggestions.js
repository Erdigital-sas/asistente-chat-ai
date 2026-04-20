// services/suggestions.js
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

const PREMIUM_MIN_CHARS = 170;
const PREMIUM_MAX_CHARS = 300;

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

const STOPWORDS_ANCLA = new Set([
  "hola", "como", "estas", "esta", "pero", "porque", "por", "para", "quiero",
  "saber", "gustaria", "hablar", "conversar", "mensaje", "mensajes", "respuesta",
  "respuestas", "quieres", "quiero", "tengo", "tiene", "tener", "buen", "buena",
  "sobre", "algo", "este", "esta", "esto", "esas", "esos", "aqui", "alla",
  "muy", "poco", "mucho", "tambien", "solo", "igual", "donde", "cuando"
]);

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
    NEW_CHAT: "enganche directo y concreto usando perfil solo si aporta",
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

  const fingerprint = [
    "premium-planner-writer-v1",
    heuristico.mode,
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 260),
    normalizarTexto(contextoPlano).slice(-500),
    normalizarTexto(perfilPlano).slice(0, 260)
  ].join("||");

  return {
    ...baseCaso,
    mode: heuristico.mode,
    anchor: heuristico.anchor,
    fingerprint
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

function cumpleLongitudPremium(texto = "") {
  const total = contarCaracteres(texto);
  return total >= PREMIUM_MIN_CHARS && total <= PREMIUM_MAX_CHARS;
}

function violaReglaContactoExterno(sugerencia = "", caso = {}) {
  if (!caso.temaContactoExterno) return false;

  const t = normalizarTexto(sugerencia);
  if (CONTACTO_REGEX.test(t)) return true;

  return !/\b(aqui|por aqui|seguir aqui|mejor aqui|prefiero aqui|prefiero por aqui|aqui mismo)\b/.test(t);
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
    .filter((s) => cumpleLongitudPremium(s))
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

function construirFallbackSugerencias(caso = {}) {
  const interes =
    caso.plan?.chosen_interest ||
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const fallbacks = {
    CONTACT_BLOCK: [
      "Entiendo que prefieras cambiar la forma en que hablamos, pero por ahora me siento mas comodo aqui. Si te parece, sigamos con algo mas simple: que fue lo mejor que te dejo tu dia?"
    ],
    GHOSTING: [
      "No queria quedarme en la parte incomoda del silencio, sino escribirte algo mejor. Si te nace seguir, me basta una respuesta sincera y ligera para retomar esto con mejor energia y sin presion."
    ],
    MEDIA_REPLY: [
      "Lo que compartiste deja una impresion muy clara y se nota que hubo una intencion real al enviarlo. Mas que quedarme en lo obvio, me dio curiosidad saber que detalle de ese momento fue el que mas te gusto a ti."
    ],
    CONFLICT_REFRAME: [
      "No quiero que esto se quede en una dinamica pesada. Prefiero que hablemos con mas calma y de una forma mas clara, porque cuando una charla vale la pena tambien merece un poco mas de cuidado."
    ],
    NEW_CHAT: interes
      ? [
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y preferi escribirte algo mas concreto. Siempre me llama la atencion cuando un gusto no esta ahi por adornar, sino porque realmente dice algo de como es alguien.`
        ]
      : [
          "No queria dejarte otro mensaje comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, plan o gusto es el que mas te representa cuando de verdad estas en tu mejor energia."
        ],
    REPLY_LAST_MESSAGE: [
      "Me quede pensando en lo ultimo que compartiste y preferi responderte con mas intencion y menos piloto automatico. Hay algo en tu forma de decir las cosas que deja curiosidad, y eso siempre vuelve mas interesante una charla."
    ],
    PROFILE_SUPPORT: interes
      ? [
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y me fui por algo mas concreto que una curiosidad comun. A veces un gusto bien elegido dice mucho mas de alguien que una presentacion armada.`
        ]
      : [
          "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. A veces un detalle concreto dice mucho mas que una presentacion armada, y me dio curiosidad saber que es lo que mas te representa de verdad."
        ],
    DEFAULT: [
      "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, gusto o forma de ver las cosas es la que mas te representa cuando de verdad estas en tu mejor energia."
    ]
  };

  return fallbacks[caso.mode] || fallbacks.DEFAULT;
}

async function generarSugerencias(caso = {}) {
  const planned = await planificarCaso(caso);
  const plan = planned.plan || planHeuristico(caso);

  caso.mode = plan.mode || caso.mode || "DEFAULT";
  caso.anchor = plan.anchor || caso.anchor || detectarAnchorHeuristico(caso, caso.mode);
  caso.plan = plan;

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
    permisosApertura: caso.permisosApertura
  });

  const dataWriter = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(
          caso.permisosApertura,
          caso.elementosClave,
          caso.mode
        )
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    temperature: caso.ghostwriterMode ? 0.62 : 0.54,
    maxTokens: 150,
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

  return {
    sugerencias: [
      "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, gusto o forma de ver las cosas es la que mas te representa cuando de verdad estas en tu mejor energia."
    ],
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
  cumpleLongitudPremium
};
