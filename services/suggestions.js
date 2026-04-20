// services/suggestions.js
const {
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_TIMEOUT_SUGGESTIONS_MS
} = require("../config");

const {
  compactarBloque,
  limpiarSalidaHumana,
  normalizarTexto,
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
  /\b(visto|me dejaste en visto|me has dejado en visto|no respondes|no me respondes|no me contestas|desapareciste|te perdi|sigues ahi|por que no respondes)\b/i;

const MEDIA_REGEX =
  /\b(foto|selfie|imagen|video|audio|voz|pic|picture|photo|snapshot|video clip|voice note)\b/i;

const CONFLICT_REGEX =
  /\b(discutir|discutiendo|discusion|pelea|malentendido|no quiero seguir asi|si esto va a ser asi|frustrante|cortamos|relacion aqui|bothering|boring you|sorry for bothering)\b/i;

const MULETILLA_REGEX =
  /\b(me gustaria saber mas de ti|mas sobre ti|me encantaria hablar contigo|podemos encontrar un terreno comun|lo que te inspira|lo que te apasiona|seguir conversando|me gustaria conocer mas de ti)\b/i;

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

function detectarMode(caso = {}) {
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

function detectarAnchor(caso = {}) {
  if (caso.mode === "CONTACT_BLOCK") {
    return "mantener la conversacion dentro de la app y redirigir a un tema concreto";
  }

  if (caso.mode === "MEDIA_REPLY") {
    const bloque = [
      caso.textoPlano || "",
      caso.clientePlano || "",
      ...(caso.lineasClienteRecientes || [])
    ].find((x) => MEDIA_REGEX.test(x || ""));
    if (bloque) return limpiarSalidaHumana(bloque).slice(0, 180);
  }

  if (caso.mode === "GHOSTING") {
    return "el borrador del operador habla del silencio o de dejar en visto";
  }

  if (caso.mode === "CONFLICT_REFRAME") {
    return "hay tension o malentendido en el chat y la respuesta debe bajar la friccion";
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
    return `interes concreto del perfil: ${interes}`;
  }

  return "anclarse al borrador del operador sin volverse abstracto";
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

  const mode = detectarMode(baseCaso);
  const anchor = detectarAnchor({ ...baseCaso, mode });

  const fingerprint = [
    "premium-v3",
    mode,
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 260),
    normalizarTexto(contextoPlano).slice(-500),
    normalizarTexto(perfilPlano).slice(0, 260)
  ].join("||");

  return {
    ...baseCaso,
    mode,
    anchor,
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

  if (caso.mode === "MEDIA_REPLY" && !MEDIA_REGEX.test(`${caso.anchor} ${sugerencia}`)) {
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
    caso.perfilEstructurado?.interesesEnComun?.[0] ||
    caso.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  const fallbacks = {
    CONTACT_BLOCK: [
      "Me caes bien, pero por ahora prefiero que sigamos aqui y dejemos que la charla tome mas forma. Me quede con curiosidad por algo mas simple: que detalle de tu dia suele ponerte de mejor humor?"
    ],
    GHOSTING: [
      "No queria quedarme en la parte incomoda del silencio, sino escribirte algo mejor. Si te nace seguir, me basta una respuesta sincera y ligera para retomar esto con mejor energia y sin presion."
    ],
    MEDIA_REPLY: [
      "La imagen que compartiste deja una impresion muy clara y se nota que hay una energia real ahi. Mas que quedarme en lo obvio, me dio curiosidad saber que detalle de ese momento te gusto mas a ti cuando decidiste enviarlo."
    ],
    CONFLICT_REFRAME: [
      "No quiero que esto se quede en una tension innecesaria. Prefiero que hablemos con mas calma y de una forma mas clara, porque cuando una conversacion vale la pena tambien merece un poco mas de cuidado."
    ],
    NEW_CHAT: interes
      ? [
          `No queria dejarte otro mensaje comun, asi que preferi escribirte mejor. Vi que ${interes.toLowerCase()} aparece en tu perfil y me dio curiosidad saber que es lo que mas disfrutas de eso, porque suele decir bastante mas de alguien que una descripcion rapida.`
        ]
      : [
          "No queria dejarte otro mensaje generico, asi que preferi escribirte mejor. Me dio curiosidad saber que tipo de detalle, plan o gusto es el que mas te representa cuando de verdad estas en tu mejor energia."
        ],
    REPLY_LAST_MESSAGE: [
      "Me quede pensando en lo ultimo que compartiste y preferi responderte con mas intencion y menos piloto automatico. Hay algo en tu forma de decir las cosas que deja curiosidad, y eso siempre vuelve mas interesante una charla."
    ],
    PROFILE_SUPPORT: interes
      ? [
          `Vi que ${interes.toLowerCase()} aparece en tu perfil y preferi ir por algo mas concreto. Siempre me llama la atencion cuando un gusto no esta ahi por adornar, sino porque realmente dice algo de como es alguien.`
        ]
      : [
          "No queria dejarte algo comun, asi que preferi escribirte mejor. A veces un detalle concreto dice mucho mas que una presentacion armada, y me dio curiosidad saber que es lo que mas te representa de verdad."
        ],
    DEFAULT: [
      "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, gusto o forma de ver las cosas es la que mas te representa cuando de verdad estas en tu mejor energia."
    ]
  };

  return fallbacks[caso.mode] || fallbacks.DEFAULT;
}

function construirRescuePrompt(caso = {}, candidata = "") {
  return `
La respuesta anterior no fue valida o no fue lo bastante precisa.

RESPUESTA ANTERIOR
"""
${candidata || "vacia"}
"""

REPARA ESTO AHORA
- una sola respuesta entre 170 y 300 caracteres
- mucho mas concreta
- humana y premium
- RESPETA EL MODO: ${caso.mode}
- RESPETA EL ANCLA: ${caso.anchor}
- si hay tema de contacto externo, manten todo dentro de la app y no menciones numeros ni canales externos
- si no hay respuesta real previa de la clienta, no uses continuidad falsa
- si hay un interes del perfil disponible, usa uno concreto
- no uses frases gastadas ni abstractas
- no inventes saludos
- no inventes nombres
- no propongas encuentros
- devuelve solo el mensaje final
`.trim();
}

function necesitaRescue(caso = {}, candidata = "") {
  const t = normalizarTexto(candidata || "");

  if (!candidata || !cumpleLongitudPremium(candidata)) return true;
  if (MULETILLA_REGEX.test(t)) return true;
  if (caso.mode === "CONTACT_BLOCK") return true;

  return ["GHOSTING", "MEDIA_REPLY", "CONFLICT_REFRAME"].includes(caso.mode);
}

async function generarSugerencias(caso = {}) {
  const userPrompt = construirUserPrompt({
    mode: caso.mode,
    anchor: caso.anchor,
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

  const data1 = await llamarOpenAI({
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
    temperature: caso.ghostwriterMode ? 0.66 : 0.58,
    maxTokens: 150,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const candidata1 = extraerPrimeraSugerenciaPremium(
    data1?.choices?.[0]?.message?.content || ""
  );

  const sugerencias1 = filtrarSugerenciasFinales([candidata1], caso);

  if (sugerencias1.length && !necesitaRescue(caso, sugerencias1[0])) {
    return {
      sugerencias: [sugerencias1[0]],
      usageData: data1
    };
  }

  if (!necesitaRescue(caso, candidata1)) {
    return {
      sugerencias: [candidata1],
      usageData: data1
    };
  }

  const data2 = await llamarOpenAI({
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
        content: `${userPrompt}\n\n${construirRescuePrompt(caso, candidata1)}`
      }
    ],
    temperature: 0.38,
    maxTokens: 150,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const candidata2 = extraerPrimeraSugerenciaPremium(
    data2?.choices?.[0]?.message?.content || ""
  );

  const sugerencias2 = filtrarSugerenciasFinales([candidata2], caso);

  if (sugerencias2.length) {
    return {
      sugerencias: [sugerencias2[0]],
      usageData: sumarUsage(data1, data2)
    };
  }

  const fallback = filtrarSugerenciasFinales(
    construirFallbackSugerencias(caso),
    caso
  );

  if (fallback.length) {
    return {
      sugerencias: [fallback[0]],
      usageData: sumarUsage(data1, data2)
    };
  }

  return {
    sugerencias: [
      "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, gusto o forma de ver las cosas es la que mas te representa cuando de verdad estas en tu mejor energia."
    ],
    usageData: sumarUsage(data1, data2)
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
