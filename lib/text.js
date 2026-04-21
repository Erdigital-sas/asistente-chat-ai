// lib/text.js
const {
  MAX_CONTEXT_LINES,
  MIN_RESPONSE_LENGTH,
  TARGET_SUGGESTION_SPECS
} = require("../config");

const {
  quitarTildes,
  normalizarTexto,
  normalizarEspacios,
  limpiarSalidaHumana,
  limpiarLinea,
  extraerBloquesIA,
  contarCaracteres,
  contarPreguntas,
  dedupeStrings,
  partirPipe,
  asegurarCierreNatural
} = require("./utils");

const PATRONES_ENCUENTRO = [
  /\b(vernos|nos vemos|verme|verte|verse|vernos algun dia|conocernos en persona|en persona|cara a cara)\b/i,
  /\b(meet|meet up|see each other|see you in person|in person|face to face|date)\b/i,
  /\b(cenar|cena|ir a cenar|dinner|almorzar juntos|almuerzo juntos|lunch together|desayunar juntos|breakfast together)\b/i,
  /\b(tomar un cafe|ir por un cafe|cafe juntos|coffee together|grab coffee|coffee date)\b/i,
  /\b(tomar algo|tomar unos tragos|tragos juntos|drinks together|grab a drink|have a drink)\b/i,
  /\b(salgamos|salir contigo|go out sometime|go out together|ir al cine|movie together|caminar juntos|walk together)\b/i,
  /\b(venir a mi casa|ven a mi casa|ir a tu casa|voy a tu casa|my place|your place|come over|visitarte|visitarnos|visit you)\b/i,
  /\b(paso por ti|te recojo|pick you up|send me your address|dame tu direccion|mandame tu ubicacion)\b/i,
  /\b(fin de semana juntos|weekend together|viaje juntos|trip together)\b/i
];

const META_EDICION_REGEX =
  /\b(no fui lo suficientemente interesante|no fui suficiente|no fue suficiente|mi mensaje|el mensaje|otro mensaje|mensaje mas interesante|mensaje mejor|captar tu atencion|capturar tu atencion|sonar mas interesante|quiero decirle|como le digo|ayudame a decir|mejorame esto|reescribe esto|hazlo mas atractivo|hazlo mejor|no fui tan interesante|no fui lo bastante interesante)\b/i;

const META_MISFIRE_RESPONSE_REGEX =
  /^(espero que no hayas pensado eso|no creo que haya sido eso|a veces es dificil captar|a veces no es facil captar|entiendo que puedas pensar eso|entiendo que pienses eso|no creo que lo hayas tomado asi)\b/i;

const STOPWORDS_RELEVANCIA = new Set([
  "hola", "amor", "mi", "mio", "tu", "tuyo", "que", "como", "estas", "esta",
  "para", "pero", "porque", "por", "con", "sin", "una", "uno", "unos",
  "unas", "este", "esta", "estos", "estas", "muy", "mas", "menos", "del",
  "las", "los", "mis", "tus", "sus", "aqui", "alla", "eso", "esto", "esa",
  "ese", "soy", "eres", "fue", "fui", "ser", "tener", "tengo", "tiene",
  "solo", "bien", "vale", "gracias", "ahora", "luego", "despues", "later",
  "today", "hoy", "clienta", "operador"
]);

const TOKENS_GENERICOS_SIN_TEMA = new Set([
  "mensaje",
  "mensajes",
  "respuesta",
  "respuestas",
  "respondiste",
  "respondes",
  "contestaste",
  "contestas",
  "interesada",
  "interesado",
  "razon",
  "alguna",
  "quiero",
  "saber",
  "hola",
  "perfil",
  "intereses",
  "conocerte",
  "hablar",
  "charla",
  "charlar"
]);

const TERMINOS_AFECTIVOS = [
  "mi amor",
  "amor",
  "baby",
  "babe",
  "bebe",
  "querida",
  "querido",
  "corazon",
  "mi vida",
  "mi reina",
  "princesa"
];

const SALUDOS_APERTURA_REGEX =
  /^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\b/i;

const FRASES_PRIMER_CONTACTO_OPERADOR_REGEX =
  /\b(conocer mas de ti|conocerte mejor|me gustaria conocerte|quisiera conocerte|quiero conocerte|saber mas de ti|me gustaria saber de ti|conocer un poco mas de ti|hablar contigo por primera vez|charlar contigo por primera vez|romper el hielo|icebreaker|primer contacto)\b/i;

const FRASES_PRIMER_CONTACTO_SUGERENCIA_REGEX =
  /\b(conocerte|conocer mas de ti|saber mas de ti|me gustaria saber de ti|me gustaria conocerte|quisiera conocerte|quiero conocerte|conocer un poco mas de ti|romper el hielo|icebreaker|primer contacto|por primera vez)\b/i;

const PREGUNTA_SIMPLE_DIRECTA_REGEX =
  /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live|que haces|que haces ahora|what are you doing|que buscas|what are you looking for|te gusta|you like|cual equipo|which team|what team|que deporte sigues|que te gusta hacer|what do you like to do|que clase de relacion buscas|what kind of relationship are you looking for)\b/i;

const PALABRAS_NO_NOMBRE_APERTURA = new Set([
  "vi",
  "veo",
  "vengo",
  "voy",
  "quiero",
  "quisiera",
  "queria",
  "me",
  "mi",
  "que",
  "como",
  "si",
  "no",
  "pero",
  "porque",
  "por",
  "para",
  "y",
  "o",
  "entonces",
  "solo",
  "solamente",
  "saber",
  "preguntar",
  "decirte",
  "decir",
  "contarte",
  "hablarte",
  "hablar",
  "escribirte",
  "escribir",
  "interesada",
  "interesado",
  "mensaje",
  "respuesta",
  "respondiste",
  "respondes",
  "contestaste",
  "contestas",
  "sigo",
  "sigue",
  "sigues",
  "hola",
  "hey",
  "hi",
  "buenas"
]);

const CONTINUIDAD_TRILLADA_REGEX =
  /\b(seguir conversando|seguir la conversacion|seguir hablando|seguir por aqui|retomar la conversacion|continuar la conversacion|continuar la charla|volver a conversar|seguir con esta charla|que la conversacion siga|seguir conociendonos|seguir en contacto por aqui|seguir esta conversacion)\b/i;

const GEO_TRIGGER_PATTERNS = [
  /\b(?:vivo en|soy de|estoy en|vivi en|naci en|resido en|me mude a|me mudé a|vengo de|ahora estoy en)\s+([a-zA-ZÀ-ÿ' .\-]{2,80})/gi,
  /\b(?:i live in|i am from|i'm from|i was born in|i moved to|i am in|i'm in)\s+([a-zA-ZÀ-ÿ' .\-]{2,80})/gi
];

function limitarContexto(ctx = "") {
  return String(ctx ?? "")
    .split("\n")
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(-MAX_CONTEXT_LINES)
    .join("\n");
}

function limpiarTextoIA(texto = "") {
  const vistos = new Set();

  return extraerBloquesIA(texto)
    .map(limpiarLinea)
    .filter((t) => t.length >= MIN_RESPONSE_LENGTH)
    .filter((t) => {
      const clave = normalizarTexto(t);
      if (!clave || vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
}

function obtenerSpecSugerencia(index = 0) {
  return TARGET_SUGGESTION_SPECS[index] || TARGET_SUGGESTION_SPECS[0];
}

function cumpleLongitudObjetivo(texto = "", index = 0) {
  const spec = obtenerSpecSugerencia(index);
  const total = contarCaracteres(texto);
  return total >= spec.min && total <= spec.max;
}

function puntuarLongitud(texto = "", index = 0) {
  const spec = obtenerSpecSugerencia(index);
  const total = contarCaracteres(texto);

  if (!total) return -25;
  if (cumpleLongitudObjetivo(texto, index)) return 12;

  const distancia = Math.abs(total - spec.ideal);
  return Math.max(-12, 8 - Math.ceil(distancia / 20));
}

function setCumpleLongitudes(sugerencias = []) {
  return (
    sugerencias.length >= 3 &&
    sugerencias.slice(0, 3).every((s, idx) => cumpleLongitudObjetivo(s, idx))
  );
}

function construirReporteLongitudes(sugerencias = []) {
  return TARGET_SUGGESTION_SPECS.map((spec, idx) => {
    const actual = contarCaracteres(sugerencias[idx] || "");
    return `Opcion ${idx + 1}: ${actual} caracteres. Objetivo ${spec.min}-${spec.max}.`;
  }).join("\n");
}

function esRespuestaBasura(texto = "") {
  const t = normalizarTexto(texto);

  return (
    t.length < MIN_RESPONSE_LENGTH ||
    /^(ok|okay|yes|no|hola|hi|vale|bien|jaja|haha|hmm|mm|fine|nice|cool)[.!?]*$/.test(t)
  );
}

function sePareceDemasiado(a = "", b = "") {
  const ta = normalizarTexto(a);
  const tb = normalizarTexto(b);

  if (!ta || !tb) return false;
  if (ta === tb) return true;

  const wa = new Set(ta.split(" ").filter(Boolean));
  const wb = tb.split(" ").filter(Boolean);

  if (!wb.length) return false;

  const overlap = wb.filter((w) => wa.has(w)).length;
  return overlap / wb.length >= 0.85;
}

function contieneTemaEncuentro(texto = "") {
  const original = String(texto ?? "");
  const limpio = quitarTildes(original);

  return PATRONES_ENCUENTRO.some((regex) => regex.test(limpio));
}

function detectarMetaEdicionOperador(texto = "") {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return META_EDICION_REGEX.test(t);
}

function esPreguntaSimpleDirecta(texto = "") {
  const original = String(texto ?? "");
  const t = normalizarTexto(original);
  if (!t) return false;

  const palabras = t.split(/\s+/).filter(Boolean);

  return (
    palabras.length <= 12 &&
    (
      /[?¿]/.test(original) ||
      PREGUNTA_SIMPLE_DIRECTA_REGEX.test(t)
    )
  );
}

function tokenizarRelevancia(texto = "") {
  return [
    ...new Set(
      normalizarTexto(texto)
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS_RELEVANCIA.has(w))
    )
  ];
}

function extraerLineasContexto(contexto = "") {
  return String(contexto ?? "")
    .split("\n")
    .map((l) => limpiarSalidaHumana(l))
    .map((l) => normalizarEspacios(l))
    .filter(Boolean)
    .filter((l) => /^CLIENTA:|^OPERADOR:/i.test(l));
}

function extraerLineasPorRol(contexto = "", role = "CLIENTA") {
  const prefijo = String(role || "").toUpperCase();
  return extraerLineasContexto(contexto)
    .filter((linea) => linea.toUpperCase().startsWith(`${prefijo}:`))
    .map((linea) => normalizarEspacios(linea.replace(/^CLIENTA:\s*/i, "").replace(/^OPERADOR:\s*/i, "")));
}

function filtrarContextoRelevante(contexto = "", texto = "", cliente = "") {
  const lineas = extraerLineasContexto(contexto);
  if (!lineas.length) return "";

  const ultimas = lineas.slice(-4);
  const tokensObjetivo = new Set([
    ...tokenizarRelevancia(texto),
    ...tokenizarRelevancia(cliente)
  ]);

  if (!tokensObjetivo.size) {
    return [...new Set(ultimas)].slice(-MAX_CONTEXT_LINES).join("\n");
  }

  const scored = lineas.map((linea) => {
    const tokens = tokenizarRelevancia(linea);
    const score = tokens.reduce(
      (acc, token) => acc + (tokensObjetivo.has(token) ? 1 : 0),
      0
    );

    return { linea, score };
  });

  const relevantes = scored
    .filter((x) => x.score > 0)
    .map((x) => x.linea);

  const combinadas = [...relevantes, ...ultimas];
  const unicas = [...new Set(combinadas)];

  return unicas.slice(-MAX_CONTEXT_LINES).join("\n");
}

function parsearPerfilEstructurado(perfilPlano = "") {
  const lines = String(perfilPlano ?? "")
    .split("\n")
    .map((l) => normalizarEspacios(l))
    .filter(Boolean);

  const data = {
    reglaPerfil: "",
    interesesEnComun: [],
    interesesClienta: [],
    datosClienta: []
  };

  for (const line of lines) {
    if (/^REGLA_PERFIL:/i.test(line)) {
      data.reglaPerfil = normalizarEspacios(line.replace(/^REGLA_PERFIL:/i, ""));
      continue;
    }

    if (/^INTERESES_EN_COMUN:/i.test(line)) {
      data.interesesEnComun = partirPipe(line.replace(/^INTERESES_EN_COMUN:/i, ""));
      continue;
    }

    if (/^INTERESES_CLIENTA:/i.test(line)) {
      data.interesesClienta = partirPipe(line.replace(/^INTERESES_CLIENTA:/i, ""));
      continue;
    }

    if (/^DATOS_CLIENTA:/i.test(line)) {
      data.datosClienta = partirPipe(line.replace(/^DATOS_CLIENTA:/i, ""));
    }
  }

  return data;
}

function construirEstadoConversacion(clientePlano = "", contextoPlano = "") {
  const clienteLimpio = normalizarEspacios(String(clientePlano || ""));
  const clienteNorm = normalizarTexto(clienteLimpio);

  const lineasClienta = dedupeStrings([
    ...extraerLineasPorRol(contextoPlano, "CLIENTA"),
    clienteNorm && !/^sin mensaje/.test(clienteNorm) ? clienteLimpio : ""
  ]);

  const lineasOperador = dedupeStrings(
    extraerLineasPorRol(contextoPlano, "OPERADOR")
  );

  const hayRespuestaCliente = lineasClienta.length > 0;
  const hayConversacionReal = hayRespuestaCliente;
  const soloOperadorSinRespuesta = !hayRespuestaCliente && lineasOperador.length > 0;
  const chatVacioTotal = !hayRespuestaCliente && lineasOperador.length === 0;
  const esChatNuevoOperativo = !hayRespuestaCliente && lineasOperador.length <= 2;

  return {
    lineasClienta,
    lineasOperador,
    hayRespuestaCliente,
    hayConversacionReal,
    soloOperadorSinRespuesta,
    chatVacioTotal,
    esChatNuevoOperativo
  };
}

function detectarChatNuevoOperativo(clientePlano = "", contextoPlano = "") {
  return construirEstadoConversacion(clientePlano, contextoPlano).esChatNuevoOperativo;
}

function construirGuiaPerfil(perfil = {}, esChatNuevo = false) {
  const reglas = [];

  if (perfil.interesesEnComun.length) {
    reglas.push("Prioriza primero los INTERESES_EN_COMUN. Tienen mas valor que los intereses solo de la clienta.");
    if (esChatNuevo) {
      reglas.push("Si el chat es nuevo o casi vacio, puedes enganchar usando primero un interes en comun, de forma natural y especifica.");
    }
  }

  if (!perfil.interesesEnComun.length && perfil.interesesClienta.length) {
    reglas.push("Si no hay intereses en comun, puedes usar INTERESES_CLIENTA como apoyo, sin fingir que el operador comparte esa aficion.");
  }

  if (perfil.interesesClienta.length) {
    reglas.push("Nunca digas que algo esta en comun si aparece solo en INTERESES_CLIENTA.");
  }

  if (perfil.datosClienta.length) {
    reglas.push("DATOS_CLIENTA solo sirven para enriquecer de forma prudente. No inventes conexion falsa.");
  }

  return reglas.join(" ");
}

function detectarTemaPropioOperador(texto = "", analisis = null) {
  const t = normalizarTexto(texto);

  if (!t) return false;

  if (
    analisis?.metaEdicion ||
    analisis?.preguntaGenerica ||
    analisis?.fraseQuemada ||
    analisis?.muyPlano ||
    analisis?.reclamo
  ) {
    return false;
  }

  if (
    analisis?.preguntaSimpleDirecta
  ) {
    return false;
  }

  if (
    /(no me respondes|no respondes|no me contestas|sigues ahi|sigues por aqui|te perdi|apareciste|desapareciste|quiero saber si|estas interesada en mi|estas interesado en mi|por alguna razon)/.test(t)
  ) {
    return false;
  }

  const tokens = tokenizarRelevancia(t).filter((token) => !TOKENS_GENERICOS_SIN_TEMA.has(token));
  return tokens.length >= 2;
}

function limpiarMencionGeografica(raw = "") {
  let texto = normalizarEspacios(String(raw || ""))
    .replace(/[.,;:!?]+$/g, "")
    .trim();

  texto = texto.split(/\b(?: y | pero | porque | and | but | because )\b/i)[0].trim();
  return texto.slice(0, 80);
}

function extraerMencionesGeograficasOperador(texto = "") {
  const resultado = [];

  for (const regex of GEO_TRIGGER_PATTERNS) {
    let match;
    while ((match = regex.exec(String(texto || "")))) {
      const lugar = limpiarMencionGeografica(match[1] || "");
      if (lugar) {
        resultado.push(lugar);
      }
    }
  }

  return dedupeStrings(resultado).slice(0, 5);
}

function esNombreAperturaProbable(token = "") {
  const posible = limpiarSalidaHumana(token || "")
    .replace(/^[,.;:!?]+|[,.;:!?]+$/g, "")
    .trim();

  if (!posible) return false;

  const norm = normalizarTexto(posible);

  if (!norm || norm.length < 3) return false;
  if (/\d/.test(norm)) return false;
  if (TERMINOS_AFECTIVOS.includes(norm)) return false;
  if (PALABRAS_NO_NOMBRE_APERTURA.has(norm)) return false;

  return true;
}

function extraerNombreEnApertura(texto = "") {
  const limpio = normalizarEspacios(String(texto ?? ""));
  const match = limpio.match(
    /^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\s+([a-zA-ZñÑáéíóúÁÉÍÓÚ]+)(?=[\s,;:.!?]|$)/i
  );

  if (!match) return "";

  const posible = limpiarSalidaHumana(match[2] || "");
  if (!esNombreAperturaProbable(posible)) return "";

  return normalizarTexto(posible);
}

function extraerAfectivosPresentes(texto = "") {
  const norm = normalizarTexto(texto);
  return TERMINOS_AFECTIVOS.filter((term) => norm.includes(term));
}

function detectarPermisosApertura({
  texto = "",
  cliente = "",
  contexto = "",
  estadoConversacion = null
}) {
  const operadorNorm = normalizarTexto(texto);
  const estado = estadoConversacion || construirEstadoConversacion(cliente, contexto);

  const saludoExplicito = SALUDOS_APERTURA_REGEX.test(operadorNorm);
  const primerContactoExplicito = FRASES_PRIMER_CONTACTO_OPERADOR_REGEX.test(operadorNorm);

  const hayHistorial = estado.hayConversacionReal;

  const pareceChatViejo =
    hayHistorial ||
    /\b(otra vez|de nuevo|retomando|seguimos|ya habiamos hablado|como te decia|volviendo a lo de antes)\b/.test(operadorNorm);

  return {
    saludoExplicito,
    primerContactoExplicito,
    hayHistorial,
    pareceChatViejo,
    hayConversacionReal: estado.hayConversacionReal,
    soloOperadorSinRespuesta: estado.soloOperadorSinRespuesta,
    sinRespuestaPrevia: !estado.hayRespuestaCliente
  };
}

function violaReglasApertura(
  sugerencia = "",
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  }
) {
  const sugNorm = normalizarTexto(sugerencia);
  if (!sugNorm) return false;

  if (!permisosApertura.saludoExplicito && SALUDOS_APERTURA_REGEX.test(sugNorm)) {
    return true;
  }

  if (
    !permisosApertura.primerContactoExplicito &&
    FRASES_PRIMER_CONTACTO_SUGERENCIA_REGEX.test(sugNorm)
  ) {
    return true;
  }

  if (
    permisosApertura.pareceChatViejo &&
    !permisosApertura.primerContactoExplicito &&
    /\b(romper el hielo|primer contacto|por primera vez por aqui|conocer mas de ti|saber mas de ti)\b/.test(sugNorm)
  ) {
    return true;
  }

  return false;
}

function detectarElementosClave(texto = "") {
  const palabras = normalizarTexto(texto).split(/\s+/).filter(Boolean);

  return {
    nombreApertura: extraerNombreEnApertura(texto),
    afectivos: extraerAfectivosPresentes(texto),
    mensajeCorto: palabras.length <= 9 || normalizarTexto(texto).length < 55
  };
}

function faltaElementosClave(
  sugerencia = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }
) {
  const sugNorm = normalizarTexto(sugerencia);
  const nombreSugerencia = extraerNombreEnApertura(sugerencia);

  if (elementos.nombreApertura) {
    if (!sugNorm.includes(elementos.nombreApertura)) return true;
    if (nombreSugerencia && nombreSugerencia !== elementos.nombreApertura) {
      return true;
    }
  } else if (nombreSugerencia) {
    return true;
  }

  if (elementos.afectivos.length) {
    const faltaAfectivo = elementos.afectivos.some((term) => !sugNorm.includes(term));
    if (faltaAfectivo) return true;
  }

  return false;
}

function usaContinuidadTrillada(texto = "") {
  return CONTINUIDAD_TRILLADA_REGEX.test(normalizarTexto(texto));
}

function violaReglaContinuidad(
  sugerencia = "",
  estadoConversacion = { hayConversacionReal: false, lineasClienta: [] },
  operadorTraeTemaPropio = false
) {
  if (!usaContinuidadTrillada(sugerencia)) return false;

  if (!estadoConversacion?.hayConversacionReal) {
    return true;
  }

  if ((estadoConversacion?.lineasClienta || []).length && !operadorTraeTemaPropio) {
    return true;
  }

  return false;
}

function pareceResponderComoSiLaClientaLeHubieraPreguntado(texto = "") {
  const t = normalizarTexto(texto);

  return (
    /^(hola[, ]*)?(gracias por preguntar|gracias,|estoy bien|todo bien por aqui|bien por aqui|espero que tu dia)/.test(t) ||
    /^(hola[, ]*)?agradezco que lo menciones/.test(t)
  );
}

function originalEsInicioOEnganche(original = "") {
  const o = normalizarTexto(original);

  return (
    /\b(como estas|que haces|de donde eres|que tal|como te va|por que no me respondes|estuve pensando en ti|vi que|me llamo la atencion|me gustaria saber|cual es tu libro favorito|conocer mas de ti)\b/.test(o)
  );
}

function esSugerenciaDebil(
  texto = "",
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false },
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  },
  estadoConversacion = { hayConversacionReal: false, lineasClienta: [] },
  operadorTraeTemaPropio = false
) {
  const t = normalizarTexto(texto);
  const originalPreguntaSimple = esPreguntaSimpleDirecta(original);

  if (!t || t.length < 18) return true;
  if (contarPreguntas(texto) > 2) return true;
  if (contieneTemaEncuentro(texto)) return true;
  if (sePareceDemasiado(texto, original)) return true;
  if (faltaElementosClave(texto, elementos)) return true;
  if (violaReglasApertura(texto, permisosApertura)) return true;
  if (violaReglaContinuidad(texto, estadoConversacion, operadorTraeTemaPropio)) return true;
  if (META_MISFIRE_RESPONSE_REGEX.test(t)) return true;

  if (
    !estadoConversacion?.hayConversacionReal &&
    /\b(retomar la conversacion|continuar la conversacion|seguir por aqui|de nuevo|otra vez|como te decia|volver a hablar)\b/.test(t)
  ) {
    return true;
  }

  if (
    originalEsInicioOEnganche(original) &&
    pareceResponderComoSiLaClientaLeHubieraPreguntado(texto)
  ) {
    return true;
  }

  if (
    detectarMetaEdicionOperador(original) &&
    /^(espero|no creo|entiendo que|a veces es dificil|a veces no es facil)/.test(t)
  ) {
    return true;
  }

  if (elementos.mensajeCorto && !originalPreguntaSimple && t.split(/\s+/).filter(Boolean).length < 11) {
    return true;
  }

  const patrones = [
    /^hola[, ]?(como estas|que tal|que haces|como va tu dia)/,
    /^me gustaria saber de ti/,
    /^espero tu respuesta/,
    /^hola[, ]?como va tu dia/,
    /^que andas haciendo ahora/,
    /^que estas haciendo en este momento/,
    /^hola[, ]?todo bien por aqui/,
    /^agradezco que lo menciones/,
    /^gracias, espero que tu dia vaya bien/
  ];

  return patrones.some((p) => p.test(t));
}

function necesitaSegundoIntento(
  sugerencias = [],
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false },
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  },
  estadoConversacion = { hayConversacionReal: false, lineasClienta: [] },
  operadorTraeTemaPropio = false
) {
  if (sugerencias.length < 3) return true;
  if (!setCumpleLongitudes(sugerencias)) return true;

  const debiles = sugerencias.filter((s) =>
    esSugerenciaDebil(s, original, elementos, permisosApertura, estadoConversacion, operadorTraeTemaPropio)
  ).length;

  const distintas = new Set(sugerencias.map(normalizarTexto)).size;

  return debiles >= 1 || distintas < 3;
}

function esSolicitudContacto(texto = "") {
  const t = normalizarTexto(texto);

  const patrones = [
    /\bwhatsapp\b/,
    /\btelegram\b/,
    /\bphone\b/,
    /\bnumber\b/,
    /\bnumero\b/,
    /\btelefono\b/,
    /\btel\b/,
    /\bcel\b/,
    /\bcelular\b/,
    /\bemail\b/,
    /\bmail\b/,
    /\bcorreo\b/,
    /\binstagram\b/,
    /\big\b/,
    /\bsnap\b/,
    /\bsnapchat\b/,
    /\bfacebook\b/,
    /\bcontact\b/,
    /\bwa\b/,
    /\bws\b/,
    /\bhangouts\b/,
    /\bwechat\b/,
    /\bline\b/,
    /\bkik\b/,
    /\bskype\b/,
    /\bdiscord\b/,
    /\bexterno\b/,
    /\boutside\b/,
    /\btext me\b/,
    /\bcall me\b/,
    /\bwrite me\b/,
    /\bmy number\b/,
    /\btu numero\b/,
    /\bpasame tu\b/,
    /\bdame tu\b/,
    /\bte dejo mi\b/,
    /\bhablamos por\b/,
    /\bhabla por\b/,
    /\bcontactame\b/,
    /\badd me\b/,
    /\b\d{6,}\b/
  ];

  return patrones.some((patron) => patron.test(t));
}

function analizarCliente(texto = "") {
  const original = String(texto ?? "");
  const t = normalizarTexto(original);

  const pregunta =
    /[?¿]/.test(original) ||
    /\b(que|como|cuando|donde|por que|porque|quien|cual|cuanto|cuanta|what|how|when|where|why|which)\b/.test(t);

  const rechazo =
    /(no me interesa|dejame|deja de escribir|stop|leave me alone|bye|goodbye|adios|no gracias|no thanks|not interested|no quiero|no deseo)/.test(t);

  const molesta =
    /(raro|weird|too much|vas muy rapido|muy rapido|calma|tranquilo|relajate|que intenso|intenso|insistente)/.test(t);

  const ocupada =
    /(busy|work|working|trabaj|ocupad|luego|despues|later|after|ahora no|not now|cant talk|cannot talk|mas tarde)/.test(t);

  const afectiva =
    /(love|miss|baby|amor|carino|mi vida|te extrano|me gustas|me encantas|beso|besitos|corazon|mi amor)/.test(t);

  const coqueta =
    /(handsome|cute|sweet|kiss|hug|guapo|lindo|bonito|hermoso|rico|bb|bebe|linda)/.test(t);

  const fria =
    t.length < 22 ||
    /^(ok|okay|yes|no|bien|vale|jaja|haha|hmm|mm|fine|nice|cool)\b/.test(t);

  const contacto = esSolicitudContacto(original);
  const encuentro = contieneTemaEncuentro(original);

  let tono = "neutral";
  if (rechazo) tono = "rechazo";
  else if (molesta) tono = "molesta";
  else if (ocupada) tono = "ocupada";
  else if (afectiva) tono = "afectiva";
  else if (coqueta) tono = "coqueta";
  else if (fria) tono = "fria";

  return {
    pregunta,
    rechazo,
    molesta,
    ocupada,
    afectiva,
    coqueta,
    fria,
    contacto,
    encuentro,
    tono
  };
}

function construirLecturaCliente(analisis) {
  const reglas = [];

  if (analisis.pregunta) {
    reglas.push("La clienta hizo una pregunta. Respondela primero.");
  }

  if (analisis.fria) {
    reglas.push("La clienta viene breve o fria. No alargues ni exageres emocion.");
  }

  if (analisis.ocupada) {
    reglas.push("La clienta parece ocupada. Ve corto y facil de responder.");
  }

  if (analisis.coqueta || analisis.afectiva) {
    reglas.push("La clienta muestra interes o coqueteo. Puedes sonar mas cercano.");
  }

  if (analisis.molesta || analisis.rechazo) {
    reglas.push("La clienta marca distancia. Baja intensidad y no insistas.");
  }

  if (analisis.contacto) {
    reglas.push("Pidio contacto externo. Mantiene la conversacion dentro de la app.");
  }

  if (analisis.encuentro) {
    reglas.push("Se menciono verse o hacer un plan presencial. No propongas encuentros ni salidas. Redirige la charla para seguir por aqui.");
  }

  if (!reglas.length) {
    reglas.push("Tono neutral. Responde natural y humano.");
  }

  return reglas.join(" ");
}

function analizarMensajeOperador(texto = "") {
  const original = String(texto ?? "");
  const t = normalizarTexto(original);
  const preguntaSimpleDirecta = esPreguntaSimpleDirecta(original);

  const traePregunta =
    /[?¿]/.test(original) ||
    /\b(que|como|cuando|donde|por que|porque|quien|cual|cuanto|what|how|when|where|why)\b/.test(t);

  const preguntaGenerica =
    !preguntaSimpleDirecta &&
    /\b(como estas|que haces|de donde eres|que tal|como te va|how are you|what are you doing|where are you from)\b/.test(t);

  const fraseQuemada =
    /\b(tenemos intereses en comun|tenemos cosas en comun|vi que tenemos intereses en comun|vi que te gusta|bonita sonrisa|linda sonrisa|me llamo la atencion tu perfil)\b/.test(t);

  const muyPlano =
    t.length < 30 ||
    /\b(hola|hi|hello|mucho gusto|encantado)\b/.test(t);

  const reclamo =
    /(no me has respondido|no me respondes|no me contestas|me has dejado|me dejaste|me ignoras|por que no)/.test(t);

  const mezclaDeIdeas =
    /[,.;:]/.test(original) && t.split(" ").length >= 12;

  const primerContacto =
    /(vi que|me llamo la atencion|tu perfil|intereses en comun|libro favorito|lectura|travel|music|cooking|conocer mas de ti)/.test(t);

  const encuentroPresencial = contieneTemaEncuentro(original);
  const metaEdicion = detectarMetaEdicionOperador(original);

  const palabras = t.split(/\s+/).filter(Boolean);
  const mensajeCorto = palabras.length <= 9 || t.length < 55;

  const ghostwriterMode =
    metaEdicion ||
    reclamo ||
    preguntaGenerica ||
    fraseQuemada ||
    (!preguntaSimpleDirecta && muyPlano) ||
    (!preguntaSimpleDirecta && mensajeCorto);

  return {
    traePregunta,
    preguntaGenerica,
    preguntaSimpleDirecta,
    fraseQuemada,
    muyPlano,
    reclamo,
    mezclaDeIdeas,
    primerContacto,
    encuentroPresencial,
    mensajeCorto,
    metaEdicion,
    ghostwriterMode
  };
}

function construirLecturaOperador(analisis) {
  const reglas = [];

  if (analisis.metaEdicion) {
    reglas.push("El borrador parece una autoevaluacion o instruccion implicita del operador. Debes convertirlo en un mensaje final para la clienta, no responderle a la herramienta.");
  }

  if (analisis.preguntaSimpleDirecta) {
    reglas.push("Si el borrador ya es una pregunta simple y clara, no lo conviertas en discurso. Mejoralo con un detalle concreto del perfil o del ultimo mensaje y mantenlo breve.");
  }

  if (analisis.ghostwriterMode && !analisis.preguntaSimpleDirecta) {
    reglas.push("Modo ghostwriter activo. Debes mejorar mucho el borrador, pero sin sonar artificial ni literario.");
  }

  if (analisis.preguntaGenerica) {
    reglas.push("La pregunta del operador esta generica. Mejora el gancho.");
  }

  if (analisis.fraseQuemada) {
    reglas.push("Evita frases quemadas. Hazlo mas natural y especifico.");
  }

  if (analisis.muyPlano && !analisis.preguntaSimpleDirecta) {
    reglas.push("El borrador esta plano. Dale mas interes real.");
  }

  if (analisis.reclamo) {
    reglas.push("Convierte cualquier reclamo en una reapertura positiva, segura y con curiosidad. No suenes resentido ni necesitado.");
  }

  if (analisis.mezclaDeIdeas) {
    reglas.push("Ordena las ideas. El texto puede venir de dictado.");
  }

  if (analisis.primerContacto) {
    reglas.push("Si es primer contacto, prioriza curiosidad natural.");
  }

  if (analisis.mensajeCorto && !analisis.preguntaSimpleDirecta) {
    reglas.push("Si el mensaje es corto y no tiene una ancla clara, amplialo solo lo necesario usando el ultimo mensaje de la clienta, el contexto o el perfil visible.");
  }

  if (analisis.encuentroPresencial) {
    reglas.push("El borrador alude a verse en persona o a un plan presencial. Debes transformarlo para seguir la charla sin proponer encuentros.");
  }

  if (!analisis.traePregunta) {
    reglas.push("No fuerces pregunta si no hace falta, pero si hace falta cerrar con una pregunta, que sea solo una y muy suave.");
  }

  if (!reglas.length) {
    reglas.push("Mantener estilo natural y claro.");
  }

  return reglas.join(" ");
}

function detectarIntencionOperador(
  texto = "",
  cliente = "",
  contexto = "",
  estadoConversacion = null
) {
  const t = normalizarTexto(texto);
  const estado = estadoConversacion || construirEstadoConversacion(cliente, contexto);

  if (
    /(no me respondes|no respondes|no me contestas|sigues ahi|sigues por aqui|te perdi|apareciste|desapareciste|pensando en ti|me acorde de ti|por que no)/.test(t)
  ) {
    return estado.hayConversacionReal ? "reenganche" : "enganche_sin_respuesta";
  }

  if (
    /(descansa|te leo luego|cuando puedas|hablamos despues|seguimos luego|que tengas linda noche|que tengas buen dia)/.test(t)
  ) {
    return "cierre_suave";
  }

  if (
    /(amor|baby|babe|bb|guapa|linda|hermosa|cute|beautiful|kiss|beso|besitos|me gustas|me encantas)/.test(t)
  ) {
    return "coqueteo";
  }

  if (
    /(vi que|tu perfil|me llamo la atencion|intereses en comun|conocer mas de ti)/.test(t) &&
    !estado.hayConversacionReal
  ) {
    return "enganche";
  }

  if (!estado.hayConversacionReal && /^(hola|hey|hi)\b/.test(t)) {
    return "enganche";
  }

  return estado.hayConversacionReal ? "conversacion" : "enganche";
}

function construirGuiaIntencion(intencion = "") {
  const mapa = {
    enganche: "Buscar una entrada atractiva, clara y facil de responder, con curiosidad natural.",
    enganche_sin_respuesta: "No la trates como si ya vinieran conversando. Convierte el seguimiento o reclamo en un enganche directo, fresco y facil de responder.",
    coqueteo: "Mantener un tono cercano y atractivo sin sonar intenso, necesitado ni artificial.",
    conversacion: "Responder y mover la charla con fluidez, naturalidad y continuidad, pero evitando muletillas repetitivas.",
    reenganche: "Recuperar la conversacion sin reclamo duro, con seguridad, calidez y mejor enganche, priorizando lo ultimo que ella dijo.",
    cierre_suave: "Cerrar o pausar con buena energia, dejando la puerta abierta para seguir despues."
  };

  return mapa[intencion] || mapa.conversacion;
}

function detectarHechosClienteSensibles(lineasClienta = []) {
  const bloque = normalizarTexto((lineasClienta || []).join(" || "));

  return {
    birthday: /\b(birthday|cumpleanos|celebrating|celebracion|cumple)\b/.test(bloque),
    family: /\b(my family|mi familia|my son|mi hijo|my daughter|mi hija|my grandson|mi nieto|daughter in law|nuera|my wife|mi esposa)\b/.test(bloque)
  };
}

function violaPropiedadHechosCliente(sugerencia = "", hechos = {}, originalOperador = "") {
  const s = normalizarTexto(sugerencia);
  const o = normalizarTexto(originalOperador);

  if (
    hechos.birthday &&
    !/\b(cumpleanos|birthday)\b/.test(o) &&
    (
      /\b(mi cumpleanos|hoy es mi cumpleanos|es mi cumpleanos|my birthday|today is my birthday)\b/.test(s) ||
      /\b(voy a celebrar mi cumpleanos|celebrare mi cumpleanos)\b/.test(s)
    )
  ) {
    return true;
  }

  if (
    hechos.family &&
    !/\b(mi familia|mi hijo|mi hija|mis hijos|mi nieto|mi nuera|my family|my son|my daughter|my grandson)\b/.test(o) &&
    /\b(mi familia|mi hijo|mi hija|mis hijos|mi nieto|mi nuera|my family|my son|my daughter|my grandson)\b/.test(s)
  ) {
    return true;
  }

  return false;
}

function elegirMejorSet(
  primary = [],
  secondary = [],
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false },
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  },
  estadoConversacion = { hayConversacionReal: false, lineasClienta: [] },
  operadorTraeTemaPropio = false
) {
  const puntuar = (arr) => {
    if (!arr.length) return -999;

    let score = 0;
    score += arr.length * 10;
    score += new Set(arr.map(normalizarTexto)).size * 5;
    score += arr.reduce((acc, s, idx) => acc + puntuarLongitud(s, idx), 0);
    score += arr.filter((s) => !sePareceDemasiado(s, original)).length * 2;
    score += arr.filter((s) => !META_MISFIRE_RESPONSE_REGEX.test(normalizarTexto(s))).length * 3;
    score -= arr.filter((s) => esSugerenciaDebil(s, original, elementos, permisosApertura, estadoConversacion, operadorTraeTemaPropio)).length * 8;
    score -= arr.filter((s) => contieneTemaEncuentro(s)).length * 20;
    score -= arr.filter((s) => violaReglasApertura(s, permisosApertura)).length * 20;
    score -= arr.filter((s) => violaReglaContinuidad(s, estadoConversacion, operadorTraeTemaPropio)).length * 12;
    score += setCumpleLongitudes(arr) ? 18 : -18;

    return score;
  };

  return puntuar(secondary) > puntuar(primary) ? secondary : primary;
}

function construirFallbackSugerencias({
  texto = "",
  cliente = "",
  estadoConversacion = null,
  perfilEstructurado = null
}) {
  const textoLimpio = limpiarSalidaHumana(texto || "");
  const clienteLimpio = limpiarSalidaHumana(cliente || "");
  const estado = estadoConversacion || construirEstadoConversacion(cliente, "");
  const interesPerfil =
    perfilEstructurado?.interesesEnComun?.[0] ||
    perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const usarBaseSegura =
    !textoLimpio ||
    textoLimpio.length < 18 ||
    detectarMetaEdicionOperador(textoLimpio) ||
    contieneTemaEncuentro(textoLimpio);

  if (!estado.hayConversacionReal) {
    if (interesPerfil) {
      const interes = limpiarSalidaHumana(interesPerfil).toLowerCase();

      return [
        `Vi que te gusta ${interes} y me parecio mejor entrar por ahi que con una frase comun. Que es lo que mas te engancha de eso?`,
        `Me llamo la atencion lo de ${interes} en tu perfil. Lo sigues por gusto general o hay algo puntual que te atrapa mas?`,
        `Vi lo de ${interes} en tu perfil y me dio curiosidad. Que parte de eso es la que mas disfrutas de verdad?`
      ]
        .map(limpiarSalidaHumana)
        .filter(Boolean);
    }

    const base = usarBaseSegura
      ? "Prefiero ir por algo mas concreto que por una frase comun"
      : asegurarCierreNatural(textoLimpio);

    return [
      `${base}. Te pregunto algo simple: que tipo de charla suele engancharte mas cuando alguien te escribe?`,
      `${base}. Me da curiosidad saber que clase de detalle suele hacerte responder con mas ganas.`,
      `${base}. Quiero preguntarte algo facil de responder: que es lo primero que te suele llamar la atencion de alguien?`
    ]
      .map(limpiarSalidaHumana)
      .filter(Boolean);
  }

  const base = usarBaseSegura
    ? "Quiero responder a lo que dijiste de una forma mas concreta"
    : asegurarCierreNatural(textoLimpio);

  const guiadaPorCliente = clienteLimpio && clienteLimpio.length >= 12
    ? " y tomando en cuenta lo ultimo que dijiste"
    : "";

  return [
    `${base}${guiadaPorCliente}.`,
    `${base}${guiadaPorCliente}, sin irme por algo generico.`,
    `${base}${guiadaPorCliente} y sin sonar repetido.`
  ]
    .map(limpiarSalidaHumana)
    .filter(Boolean);
}

module.exports = {
  META_MISFIRE_RESPONSE_REGEX,
  limitarContexto,
  limpiarTextoIA,
  obtenerSpecSugerencia,
  cumpleLongitudObjetivo,
  puntuarLongitud,
  setCumpleLongitudes,
  construirReporteLongitudes,
  esRespuestaBasura,
  sePareceDemasiado,
  contieneTemaEncuentro,
  detectarMetaEdicionOperador,
  esPreguntaSimpleDirecta,
  tokenizarRelevancia,
  extraerLineasContexto,
  extraerLineasPorRol,
  filtrarContextoRelevante,
  parsearPerfilEstructurado,
  construirEstadoConversacion,
  detectarChatNuevoOperativo,
  construirGuiaPerfil,
  detectarTemaPropioOperador,
  extraerMencionesGeograficasOperador,
  extraerNombreEnApertura,
  extraerAfectivosPresentes,
  detectarPermisosApertura,
  violaReglasApertura,
  detectarElementosClave,
  faltaElementosClave,
  usaContinuidadTrillada,
  violaReglaContinuidad,
  pareceResponderComoSiLaClientaLeHubieraPreguntado,
  originalEsInicioOEnganche,
  esSugerenciaDebil,
  necesitaSegundoIntento,
  esSolicitudContacto,
  analizarCliente,
  construirLecturaCliente,
  analizarMensajeOperador,
  construirLecturaOperador,
  detectarIntencionOperador,
  construirGuiaIntencion,
  detectarHechosClienteSensibles,
  violaPropiedadHechosCliente,
  elegirMejorSet,
  construirFallbackSugerencias
};
