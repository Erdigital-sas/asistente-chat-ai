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
  esSolicitudContacto,
  sePareceDemasiado
} = require("../lib/text");

const { construirSystemPrompt } = require("../prompts/systemPrompt");
const { construirUserPrompt } = require("../prompts/userPrompt");
const { llamarOpenAI, suggestionsOpenAILimiter } = require("./openai");

const PREMIUM_MIN_CHARS = 170;
const PREMIUM_MAX_CHARS = 300;
const DEFAULT_VARIANTS = 3;
const RECENT_MEMORY_LIMIT = 24;

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
  /\b(no queria dejarte algo frio ni comun|preferi escribirte mejor|quise escribirte mejor|me quede pensando en lo ultimo que compartiste|responderte con mas intencion|con mas intencion|con mas calma|con mas naturalidad|lo reformulo mejor|piloto automatico|tu mejor energia|tu mejor vibra|forma de ver las cosas|mensaje vacio|mensaje frio|mas humano|mas conectado)\b/i;

const FRASES_META_REGEX =
  /\b(el mensaje|mi mensaje|el borrador|reescrib|reformular|responderte mejor|sonar mejor|quedarme en algo generico)\b/i;

const CIERRE_ABSTRACTO_REGEX =
  /\b(que te representa de verdad|cuando de verdad estas en tu mejor energia|cuando estas en tu mejor vibra|lo que mas te representa|forma de ver las cosas)\b/i;

const STOPWORDS_ANCLA = new Set([
  "hola", "como", "estas", "esta", "pero", "porque", "por", "para", "quiero",
  "saber", "gustaria", "hablar", "conversar", "mensaje", "mensajes", "respuesta",
  "respuestas", "quieres", "quiero", "tengo", "tiene", "tener", "buen", "buena",
  "sobre", "algo", "este", "esta", "esto", "esas", "esos", "aqui", "alla",
  "muy", "poco", "mucho", "tambien", "solo", "igual", "donde", "cuando", "me",
  "tu", "ella", "el", "una", "uno", "unos", "unas", "con", "sin", "del"
]);

const recentSuggestionsByOperator = new Map();

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

function tokenizarAnchor(anchor = "") {
  return normalizarTexto(anchor)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_ANCLA.has(w));
}

function contarCoincidenciasTokens(texto = "", referencia = "") {
  const a = new Set(
    normalizarTexto(texto)
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS_ANCLA.has(w))
  );

  const b = new Set(
    normalizarTexto(referencia)
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS_ANCLA.has(w))
  );

  if (!a.size || !b.size) return 0;

  let total = 0;
  for (const token of a) {
    if (b.has(token)) total += 1;
  }

  return total;
}

function tieneAnclaReal(sugerencia = "", anchor = "") {
  const tokens = tokenizarAnchor(anchor);
  if (!tokens.length) return true;

  const salida = new Set(normalizarTexto(sugerencia).split(/\s+/).filter(Boolean));
  return tokens.some((t) => salida.has(t));
}

function obtenerMemoriaOperador(operador = "") {
  const key = normalizarTexto(operador || "anon");
  return recentSuggestionsByOperator.get(key) || [];
}

function obtenerFrasesRecientesOperador(operador = "") {
  return obtenerMemoriaOperador(operador)
    .map((item) => String(item || "").split(/[.!?]/)[0] || "")
    .map((x) => normalizarEspacios(x).slice(0, 90))
    .filter(Boolean)
    .slice(-6);
}

function registrarMemoriaOperador(operador = "", sugerencias = []) {
  const key = normalizarTexto(operador || "anon");
  const prev = obtenerMemoriaOperador(operador);

  const merged = [
    ...prev,
    ...dedupeStrings(
      (Array.isArray(sugerencias) ? sugerencias : [])
        .map((x) => normalizarEspacios(x))
        .filter(Boolean)
    )
  ].slice(-RECENT_MEMORY_LIMIT);

  recentSuggestionsByOperator.set(key, merged);
}

function penalizacionRepeticionReciente(sugerencia = "", operador = "") {
  const memoria = obtenerMemoriaOperador(operador);
  if (!memoria.length) return 0;

  const inicioActual = normalizarTexto(sugerencia)
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");

  let penalty = 0;

  for (const previo of memoria) {
    const inicioPrevio = normalizarTexto(previo)
      .split(/\s+/)
      .slice(0, 8)
      .join(" ");

    if (sePareceDemasiado(sugerencia, previo)) {
      penalty += 28;
      continue;
    }

    if (inicioActual && inicioActual === inicioPrevio) {
      penalty += 14;
    }
  }

  return penalty;
}

function obtenerLoadState() {
  const active = safePositiveInt(suggestionsOpenAILimiter.activeCount);
  const waiting = safePositiveInt(suggestionsOpenAILimiter.queuedCount);
  const max = safePositiveInt(suggestionsOpenAILimiter.maxConcurrent || 6);

  const fastMode =
    active >= Math.max(1, max - 1) ||
    waiting >= Math.max(4, max * 2);

  return {
    active,
    waiting,
    max,
    fastMode
  };
}

function safePositiveInt(n = 0) {
  const num = Number.parseInt(n, 10) || 0;
  return Math.max(0, num);
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
      : "mantener la charla dentro de la app y llevarla a algo concreto";
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
    return limpiarSalidaHumana(caso.textoPlano || caso.clientePlano || "").slice(0, 180);
  }

  if (mode === "CONFLICT_REFRAME") {
    const cand = [
      caso.textoPlano,
      caso.clientePlano,
      ...(caso.lineasClienteRecientes || [])
    ].find((x) => CONFLICT_REGEX.test(x || ""));

    if (cand) return limpiarSalidaHumana(cand).slice(0, 180);
    return "bajar tension y responder con tacto";
  }

  if (caso.anclarEnUltimoMensajeCliente && caso.lineasClienteRecientes?.length) {
    return limpiarSalidaHumana(
      caso.lineasClienteRecientes[caso.lineasClienteRecientes.length - 1]
    ).slice(0, 180);
  }

  if (caso.operadorTraeTemaPropio && caso.textoPlano) {
    return limpiarSalidaHumana(caso.textoPlano).slice(0, 180);
  }

  const interes =
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  if (interes) {
    return `interes concreto: ${interes}`;
  }

  return "seguir el tema real del borrador sin sonar abstracta";
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

  const summaryMap = {
    NEW_CHAT: "entrada concreta y facil de responder",
    REPLY_LAST_MESSAGE: "responder primero a lo ultimo que ella dijo",
    GHOSTING: "reapertura segura y sin drama",
    CONTACT_BLOCK: "mantener la charla dentro de la app con naturalidad",
    MEDIA_REPLY: "anclarse al contenido compartido antes que al perfil",
    CONFLICT_REFRAME: "bajar friccion sin sonar blando ni coach",
    PROFILE_SUPPORT: "usar un interes concreto como apoyo real",
    DEFAULT: "seguir el tema verdadero del borrador y hacerlo sonar humano"
  };

  return {
    mode,
    anchor,
    use_profile_interest: Boolean(chosenInterest),
    chosen_interest: chosenInterest,
    summary: summaryMap[mode] || summaryMap.DEFAULT,
    forbidden: [
      "frases meta",
      "tono literario",
      "continuidad falsa",
      "desviarse del ancla"
    ]
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
  const textoPlano = compactarBloque(texto, 760);
  const clientePlano = compactarBloque(cliente, 360);
  const contextoPlano = compactarBloque(
    limitarContexto(contextoFiltrado),
    620
  );
  const perfilPlano = compactarBloque(
    limitarContexto(perfil),
    280
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
      ? "No hay respuesta real de la clienta. Convierte el texto en una entrada directa."
      : "",
    anclarEnUltimoMensajeCliente
      ? "Hay mensaje reciente de la clienta. Responde eso primero."
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
    "premium-human-v2",
    heuristico.mode,
    normalizarTexto(textoPlano).slice(0, 280),
    normalizarTexto(clientePlano).slice(0, 220),
    normalizarTexto(contextoPlano).slice(-320),
    normalizarTexto(perfilPlano).slice(0, 180)
  ].join("||");

  return {
    ...baseCaso,
    mode: heuristico.mode,
    anchor: heuristico.anchor,
    plan: heuristico,
    fingerprint
  };
}

function normalizarSugerenciaPremium(texto = "") {
  return limpiarSalidaHumana(
    String(texto || "")
      .replace(/\n+/g, " ")
      .replace(/[“”"]/g, "")
      .trim()
  );
}

function extraerSugerenciasPremium(raw = "", limit = DEFAULT_VARIANTS) {
  const limpias = limpiarTextoIA(raw)
    .map(normalizarSugerenciaPremium)
    .filter((s) => !esRespuestaBasura(s));

  if (limpias.length) {
    return dedupeStrings(limpias).slice(0, limit);
  }

  const unica = normalizarSugerenciaPremium(raw);
  return unica ? [unica] : [];
}

function cumpleLongitudPremium(texto = "") {
  const total = contarCaracteres(texto);
  return total >= PREMIUM_MIN_CHARS && total <= PREMIUM_MAX_CHARS;
}

function esMetaRobotica(texto = "") {
  const limpio = normalizarTexto(texto);
  if (!limpio) return true;

  return (
    FRASES_ROBOTICAS_REGEX.test(limpio) ||
    FRASES_META_REGEX.test(limpio) ||
    CIERRE_ABSTRACTO_REGEX.test(limpio)
  );
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

  if (caso.mode === "REPLY_LAST_MESSAGE" && caso.clientePlano && !tieneAnclaReal(sugerencia, caso.anchor)) {
    return true;
  }

  return false;
}

function filtrarSugerenciasFinales(sugerencias = [], caso = {}) {
  return dedupeStrings(Array.isArray(sugerencias) ? sugerencias : [])
    .map(normalizarSugerenciaPremium)
    .filter(Boolean)
    .filter((s) => cumpleLongitudPremium(s))
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

function puntuarSugerenciaFinal(texto = "", caso = {}) {
  if (!texto) return -999;

  let score = 0;
  const total = contarCaracteres(texto);

  if (total >= 190 && total <= 255) score += 12;
  else if (cumpleLongitudPremium(texto)) score += 7;
  else score -= 20;

  if (tieneAnclaReal(texto, caso.anchor)) score += 16;
  else score -= 16;

  const ultimaLineaClienta =
    (caso.lineasClienteRecientes || [])[caso.lineasClienteRecientes.length - 1] ||
    caso.clientePlano ||
    "";

  if (caso.anclarEnUltimoMensajeCliente && ultimaLineaClienta) {
    const matches = contarCoincidenciasTokens(texto, ultimaLineaClienta);
    score += Math.min(18, matches * 6);
    if (!matches) score -= 12;
  }

  const interesElegido =
    caso.plan?.chosen_interest ||
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  if (interesElegido) {
    const interestMatches = contarCoincidenciasTokens(texto, interesElegido);
    score += Math.min(8, interestMatches * 4);
  }

  if (!esMetaRobotica(texto)) score += 22;
  else score -= 28;

  if (!MULETILLA_REGEX.test(normalizarTexto(texto))) score += 10;
  else score -= 22;

  const preguntas = (String(texto || "").match(/[?¿]/g) || []).length;
  if (preguntas <= 2) score += 4;
  else score -= 14;

  if ((String(texto || "").match(/,/g) || []).length >= 4) {
    score -= 4;
  }

  if (caso.temaContactoExterno && /\b(aqui|por aqui|prefiero aqui|mejor aqui)\b/i.test(texto)) {
    score += 8;
  }

  score -= penalizacionRepeticionReciente(texto, caso.operador);

  return score;
}

function ordenarYSacarTop(sugerencias = [], caso = {}, limit = DEFAULT_VARIANTS) {
  return dedupeStrings(sugerencias)
    .map((texto) => ({
      texto,
      score: puntuarSugerenciaFinal(texto, caso)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.texto);
}

function construirFallbackSugerencias(caso = {}) {
  const mode = caso.mode || (!caso.estadoConversacion?.hayConversacionReal ? "NEW_CHAT" : "DEFAULT");
  const interes =
    caso.plan?.chosen_interest ||
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const fallbacks = {
    CONTACT_BLOCK: [
      "Podemos dejar el cambio de app para mas adelante; por aqui estoy bien. Mejor dime algo mas simple: que fue lo mas inesperado, divertido o raro que te paso hoy, de eso que luego se queda dando vueltas un rato.",
      "Por ahora prefiero seguir por aqui, que asi la charla va mas tranquila. Mejor cuentame algo con sustancia: que detalle de tu dia fue el que te cambio el humor para bien, aunque haya sido una tonteria.",
      "No me molesta seguir por aqui; de hecho asi va mas simple. Ya que estamos, dime algo mas interesante que cambiar de app: que cosa te hace entrar rapido en confianza con alguien cuando la charla si te gusta."
    ],
    GHOSTING: [
      "No voy a hacer drama por el silencio, pero si te escribo otra vez prefiero que sea con algo que si tenga gracia. A veces una charla cambia por un detalle, y contigo me dio curiosidad ver si ese detalle todavia aparece.",
      "Todo bien con que una charla se enfrie a ratos; pasa. Lo que si me dio curiosidad es si contigo el problema fue el momento o simplemente que no habia aparecido todavia una pregunta que de verdad te sacara una respuesta real.",
      "No te escribo para reclamarte nada; solo me dio curiosidad retomar esto de una forma un poco mejor. A veces una conversacion no arranca por rutina, y otras por falta de algo concreto que la haga valer la pena."
    ],
    MEDIA_REPLY: [
      "Lo que mandaste tiene un detalle que se queda dando vueltas, y no es solo por verlo sino por la sensacion que deja. Ahora si me dio curiosidad saber que parte de ese momento fue la que mas te gusto a ti cuando lo compartiste.",
      "Hay algo en lo que mostraste que se siente bastante mas natural que lo tipico, y eso cambia mucho la impresion. Mas que quedarme en lo obvio, me dio curiosidad saber que fue exactamente lo que a ti te gusto de ese momento.",
      "Lo que compartiste no se siente puesto por cumplir, y eso se nota. Por eso me dio mas curiosidad el contexto que la imagen en si: que era lo que te tenia en ese mood o en ese momento cuando decidiste mostrarlo."
    ],
    CONFLICT_REFRAME: [
      "No me interesa que esto se vuelva pesado por una mala vuelta. Si hay algo rescatable en una charla, prefiero bajarle un poco al choque y entender mejor desde donde lo estas diciendo tu, porque ahi suele estar lo importante.",
      "No quiero que esto se quede en un tira y afloja sin sentido. Cuando una charla tiene algo bueno, prefiero frenar un poco el tono y ver que fue lo que realmente te molesto o te hizo reaccionar asi.",
      "Si esto se pone tenso por una mala lectura, la charla pierde lo poco bueno que ya tenia. Prefiero que lo bajemos medio paso y ver que parte tomaste de una forma distinta a como iba realmente."
    ],
    NEW_CHAT: interes
      ? [
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y me fui por algo mas concreto, porque eso casi nunca esta puesto por llenar espacio. Siempre me da curiosidad cuando un gusto asi si dice algo real de la forma de ser de alguien.`,
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y me llamo mas eso que cualquier frase armada. Normalmente cuando alguien tiene un gusto asi de claro se nota que hay una historia atras, y ahi es donde la charla se vuelve interesante.`,
          `Lo de ${interes.toLowerCase()} en tu perfil me parecio mejor punto de partida que una entrada tipica. Cuando alguien pone algo asi, casi siempre dice bastante mas de su forma de disfrutar la vida que una presentacion bonita.`
        ]
      : [
          "Te escribo algo simple: cuando alguien tiene una vibra interesante casi siempre se nota en algun detalle, no en una descripcion armada. Y contigo me dio curiosidad saber cual seria ese detalle si me lo contaras sin filtro.",
          "Prefiero ir por algo concreto en vez de tirar una entrada igual a todas. A veces una persona engancha mas por un detalle raro o genuino que por lo obvio, y me dio curiosidad saber cual seria ese detalle contigo.",
          "No me interesa sonar ensayado; me interesa que la charla tenga algo de verdad. Por eso te pregunto algo mas simple: cual es ese detalle tuyo que casi siempre termina llamando la atencion cuando alguien te conoce un poco mejor."
        ],
    REPLY_LAST_MESSAGE: [
      "Eso que dijiste cambia bastante el tono de la charla, y me gusto porque suena mas real que lo tipico. Ahora si me dio curiosidad saber si eso te sale asi de natural o si normalmente te guardas bastante mas de lo que pareces.",
      "Lo que dijiste tiene mas miga de la que parece a primera vista, y por eso no da para responder con cualquier cosa. Si te soy sincero, me dejo con curiosidad por entender mejor de donde te sale esa forma de verlo.",
      "Eso que soltaste tiene bastante mas personalidad que una respuesta de compromiso, y ahi es donde una charla mejora de verdad. Ahora me dio curiosidad saber si siempre hablas asi de directo o depende mucho de quien tengas enfrente."
    ],
    PROFILE_SUPPORT: interes
      ? [
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y me parecio mejor entrar por ahi que por una frase comun. Cuando alguien tiene un gusto tan claro, casi siempre dice mas de su forma de ser que una presentacion demasiado pensada.`,
          `Lo de ${interes.toLowerCase()} en tu perfil me parecio mucho mejor punto de partida que ir por lo tipico. Hay gustos que estan puestos por adorno y otros que dicen bastante de alguien; este me dio la impresion de ser de los segundos.`,
          `Vi lo de ${interes.toLowerCase()} y me dio mas curiosidad eso que cualquier entrada armada. Normalmente cuando una persona tiene un gusto asi de marcado, la charla mejora bastante mas rapido porque ya hay algo real de donde tirar.`
        ]
      : [
          "A veces un detalle concreto vale mucho mas que una presentacion bonita, y eso fue justo lo que me dio curiosidad aqui. Cuando alguien se sale un poco de lo obvio, la charla cambia mucho mas rapido y se nota enseguida.",
          "Me fui por lo concreto porque es donde una charla se vuelve de verdad interesante. Hay perfiles que no dicen mucho y otros que dejan algun detalle util; aqui senti mas lo segundo que lo primero.",
          "Hay algo mejor que una entrada bonita, y es encontrar un detalle que si tenga algo de real. Eso fue lo que me dio curiosidad aqui, porque senti que habia mas fondo que el de una charla cualquiera."
        ],
    DEFAULT: [
      "Hay algo en lo que escribiste o en como viene esta charla que da para algo mejor que una respuesta de compromiso. Me dio curiosidad seguir por la parte mas real de esto, que casi siempre es donde empieza lo interesante.",
      "No hace falta adornar mucho una charla cuando hay un detalle que ya la mueve por si solo. Aqui senti justo eso, y por eso me dio curiosidad seguir por lo que de verdad puede hacerla un poco mas interesante.",
      "A veces una charla cambia no por decir mucho, sino por tocar justo el detalle que la saca de lo comun. Y aqui senti que habia uno de esos, por eso me dio curiosidad ver por donde lo llevas tu."
    ]
  };

  return fallbacks[mode] || fallbacks.DEFAULT;
}

async function generarSugerencias(caso = {}) {
  const plan = planHeuristico(caso);

  caso.mode = plan.mode || caso.mode || "DEFAULT";
  caso.anchor = plan.anchor || caso.anchor || detectarAnchorHeuristico(caso, caso.mode);
  caso.plan = plan;

  const loadState = obtenerLoadState();
  caso.fastMode = Boolean(loadState.fastMode);

  const recentAvoid = obtenerFrasesRecientesOperador(caso.operador);

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
    chosenInterest: plan.chosen_interest || "",
    recentAvoid,
    fastMode: caso.fastMode
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
          caso.mode,
          caso.fastMode
        )
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    temperature: caso.fastMode ? 0.56 : 0.72,
    maxTokens: caso.fastMode ? 180 : 320,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const sugerenciasCrudas = extraerSugerenciasPremium(
    dataWriter?.choices?.[0]?.message?.content || "",
    caso.fastMode ? 1 : DEFAULT_VARIANTS
  );

  const sugerenciasFiltradas = filtrarSugerenciasFinales(sugerenciasCrudas, caso);
  const sugerenciasOrdenadas = ordenarYSacarTop(
    sugerenciasFiltradas,
    caso,
    caso.fastMode ? 1 : DEFAULT_VARIANTS
  );

  if (sugerenciasOrdenadas.length) {
    registrarMemoriaOperador(caso.operador, sugerenciasOrdenadas);

    return {
      sugerencias: sugerenciasOrdenadas,
      usageData: sumarUsage(dataWriter)
    };
  }

  const fallback = filtrarSugerenciasFinales(
    construirFallbackSugerencias(caso),
    caso
  );

  const fallbackOrdenado = ordenarYSacarTop(
    fallback,
    caso,
    caso.fastMode ? 1 : DEFAULT_VARIANTS
  );

  if (fallbackOrdenado.length) {
    registrarMemoriaOperador(caso.operador, fallbackOrdenado);

    return {
      sugerencias: fallbackOrdenado,
      usageData: sumarUsage(dataWriter)
    };
  }

  const ultimoRecurso = caso.estadoConversacion?.hayConversacionReal
    ? ["Eso que dijiste cambia bastante el tono de la charla, y ahora si me dio curiosidad saber desde donde te sale esa forma tan directa de verlo."]
    : ["Vi un detalle aqui que me dio mas curiosidad que cualquier entrada comun, y por eso preferi ir por algo mas concreto en vez de sonar igual que todo el mundo."];

  registrarMemoriaOperador(caso.operador, ultimoRecurso);

  return {
    sugerencias: ultimoRecurso,
    usageData: sumarUsage(dataWriter)
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
