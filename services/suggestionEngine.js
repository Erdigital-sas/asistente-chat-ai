const {
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_TIMEOUT_SUGGESTIONS_MS
} = require("../config");

const {
  compactarBloque,
  limpiarSalidaHumana,
  normalizarEspacios,
  normalizarTexto,
  dedupeStrings
} = require("../lib/utils");

const { llamarOpenAI } = require("./openai");

const META_REGEX =
  /\b(responderte mejor|escribirte mejor|con mas intencion|con mas calma|con mas naturalidad|me dejo curiosidad real|por como lo dijiste|siempre hablas asi|piloto automatico|tu mejor vibra|tu mejor energia)\b/i;

const CONTACTO_REGEX =
  /\b(whatsapp|telegram|instagram|snapchat|discord|numero|telefono|phone|mail|email|correo)\b/i;

const ENCUENTRO_REGEX =
  /\b(vernos|en persona|cafe juntos|salir contigo|my place|your place|dinner|drink together|come over|direccion|ubicacion)\b/i;

const RESPUESTA_FRASES_GENERICAS_REGEX =
  /^(entiendo|tiene sentido|lo que dices|por donde vas|gracias por decirme|me interesa lo que dices)\b/i;

const CONTINUIDAD_TRAMPOSA_REGEX =
  /\b(retomar|seguir conversando|de nuevo|otra vez|como te decia|volver a hablar)\b/i;

const AFFECTIVE_TERMS = [
  "mi amor", "amor", "baby", "babe", "mi vida", "corazon", "cariño", "carino"
];

function parsePerfilPlano(perfil = "") {
  const raw = String(perfil || "");

  const getLine = (label) => {
    const match = raw.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    return match ? match[1].trim() : "";
  };

  const splitPipe = (text) =>
    dedupeStrings(
      String(text || "")
        .split("|")
        .map((x) => normalizarEspacios(x))
        .filter(Boolean)
    );

  return {
    interesesEnComun: splitPipe(getLine("INTERESES_EN_COMUN")),
    interesesClienta: splitPipe(getLine("INTERESES_CLIENTA")),
    ubicacionClienta: getLine("UBICACION_CLIENTA"),
    datosClienta: splitPipe(getLine("DATOS_CLIENTA"))
  };
}

function buildSignals(raw = {}) {
  return {
    ultimo_role_visible: String(raw?.ultimo_role_visible || "").trim(),
    hay_clienta_visible: Boolean(raw?.hay_clienta_visible),
    hay_operador_visible: Boolean(raw?.hay_operador_visible),
    solo_operador_visible: Boolean(raw?.solo_operador_visible),
    total_clienta_visible: Number(raw?.total_clienta_visible || 0),
    total_operador_visible: Number(raw?.total_operador_visible || 0)
  };
}

function contieneTerminoAfectivo(texto = "") {
  const t = normalizarTexto(texto);
  return AFFECTIVE_TERMS.some((term) => t.includes(normalizarTexto(term)));
}

function extraerSaludoInicial(texto = "") {
  const match = String(texto || "").trim().match(/^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\b/i);
  return match ? match[1] : "";
}

function pickDetallePerfil(perfil = {}, texto = "") {
  const textoNorm = String(texto || "").toLowerCase();
  const preguntaUbicacion =
    /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i
      .test(textoNorm);

  if (preguntaUbicacion && perfil.ubicacionClienta) {
    return { type: "ubicacion", value: perfil.ubicacionClienta };
  }

  if (perfil.interesesEnComun?.length) {
    return { type: "interes_comun", value: perfil.interesesEnComun[0] };
  }

  if (perfil.interesesClienta?.length) {
    return { type: "interes_clienta", value: perfil.interesesClienta[0] };
  }

  return { type: "none", value: "" };
}

function detectarModo({ texto = "", cliente = "", chatSignals = {}, pageType = "" }) {
  const tipoPagina = String(pageType || "").trim().toLowerCase();

  if (tipoPagina === "mail") {
    return "MAIL_APERTURA";
  }

  if (tipoPagina === "chat") {
    if (chatSignals.ultimo_role_visible === "clienta" && chatSignals.hay_clienta_visible) {
      return "RESPUESTA_CHAT";
    }

    if (chatSignals.hay_clienta_visible && chatSignals.ultimo_role_visible === "operador") {
      return "SEGUIMIENTO_CHAT";
    }

    if (
      chatSignals.solo_operador_visible ||
      (chatSignals.hay_operador_visible && !chatSignals.hay_clienta_visible)
    ) {
      return "REAPERTURA_SUAVE";
    }

    return "APERTURA_FRIA";
  }

  if (normalizarEspacios(cliente)) {
    return "RESPUESTA_CHAT";
  }

  if (/\b(no respondes|me dejaste en visto|sigues ahi|desapareciste)\b/i.test(texto)) {
    return "REAPERTURA_SUAVE";
  }

  return "APERTURA_FRIA";
}

function buildSystemPrompt(caso = {}) {
  return `
Eres un editor conversacional premium para una app de citas.

Debes devolver exactamente 3 opciones finales listas para enviar.
Todas deben sonar humanas, naturales, claras y fáciles de responder.

Reglas generales:
- no inventes nombres
- no inventes ciudades ni recuerdos
- no propongas salir de la app ni contacto externo
- no uses más de una pregunta por opción
- no uses tono de coach, poeta o bot
- no metas frases meta sobre escribir mejor, responder mejor, con más intención o con más calma
- si no hay respuesta real de la clienta, no escribas como si ella acabara de decir algo profundo
- usa el perfil solo como apoyo y como máximo un detalle por opción

Modo actual: ${caso.mode}

Si es APERTURA_FRIA:
- abre natural y ligero
- puedes usar saludo corto si ya estaba en el borrador o si queda natural
- no respondas como si ella ya hubiera hablado

Si es REAPERTURA_SUAVE:
- ya hubo mensajes del operador pero no respuesta real de ella
- reabre sin reclamo ni drama
- no menciones silencio ni ausencia

Si es SEGUIMIENTO_CHAT:
- hay historial con mensajes de la clienta, pero el último visible es del operador
- mejora el borrador actual y continúa la línea de la conversación
- no respondas como si la clienta hubiera dicho el borrador

Si es RESPUESTA_CHAT:
- el último visible es de la clienta
- responde primero a lo que ella dijo

Si es MAIL_APERTURA:
- estás en vista de perfil/carta, no en chat
- escribe una apertura simple basada en el borrador o en un detalle real del perfil

Devuelve solo:
1. ...
2. ...
3. ...
`.trim();
}

function buildUserPrompt(caso = {}) {
  return `
TIPO DE PAGINA
${caso.pageType || "unknown"}

BORRADOR DEL OPERADOR
"""
${caso.textoPlano}
"""

ULTIMO MENSAJE DE LA CLIENTA
"""
${caso.clientePlano || "Sin mensaje claro"}
"""

CONTEXTO RELEVANTE
"""
${caso.contextoPlano || "Sin contexto claro"}
"""

CHAT SIGNALS
- ultimo_role_visible: ${caso.chatSignals.ultimo_role_visible || "ninguno"}
- hay_clienta_visible: ${caso.chatSignals.hay_clienta_visible ? "si" : "no"}
- hay_operador_visible: ${caso.chatSignals.hay_operador_visible ? "si" : "no"}
- solo_operador_visible: ${caso.chatSignals.solo_operador_visible ? "si" : "no"}

PERFIL
- intereses en comun: ${(caso.perfil.interesesEnComun || []).join(" | ") || "ninguno"}
- intereses clienta: ${(caso.perfil.interesesClienta || []).join(" | ") || "ninguno"}
- ubicacion: ${caso.perfil.ubicacionClienta || "ninguna"}

DETALLE PRIORITARIO
${caso.detallePerfil?.value || "ninguno"}

IMPORTANTE
- si el ultimo visible no es de la clienta, no escribas como respuesta a ella
- si el ultimo visible es del operador, mejora el nuevo mensaje del operador
- si es vista mail, escribe como apertura, no como respuesta

Devuelve solo 3 opciones numeradas.
`.trim();
}

function extractOptions(raw = "") {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const options = [];
  const regex = /(?:^|\n)\s*\d+\s*[\.\)\-:]\s*([\s\S]*?)(?=(?:\n\s*\d+\s*[\.\)\-:])|$)/g;
  let match;

  while ((match = regex.exec(text))) {
    const item = normalizarEspacios(match[1]);
    if (item) options.push(item);
  }

  if (options.length) return options;

  return text
    .split("\n")
    .map((x) => normalizarEspacios(x))
    .filter(Boolean);
}

function preguntaUbicacion(texto = "") {
  return /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i
    .test(String(texto || "").toLowerCase());
}

function badSuggestion(s, caso = {}) {
  const t = normalizarTexto(s || "");

  if (!s) return true;
  if (META_REGEX.test(t)) return true;
  if (CONTACTO_REGEX.test(t)) return true;
  if (ENCUENTRO_REGEX.test(t)) return true;

  if (
    caso.mode !== "RESPUESTA_CHAT" &&
    RESPUESTA_FRASES_GENERICAS_REGEX.test(s)
  ) {
    return true;
  }

  if (
    (caso.mode === "APERTURA_FRIA" || caso.mode === "REAPERTURA_SUAVE" || caso.mode === "MAIL_APERTURA") &&
    CONTINUIDAD_TRAMPOSA_REGEX.test(t)
  ) {
    return true;
  }

  if (
    !preguntaUbicacion(caso.textoPlano) &&
    caso.perfil?.ubicacionClienta &&
    normalizarTexto(s).includes(normalizarTexto(caso.perfil.ubicacionClienta))
  ) {
    return true;
  }

  if (normalizarEspacios(s).length < 35) return true;

  return false;
}

function limpiarOpciones(items = [], caso = {}) {
  return dedupeStrings(
    (Array.isArray(items) ? items : [])
      .map((x) => limpiarSalidaHumana(x))
      .filter(Boolean)
      .filter((x) => !badSuggestion(x, caso))
  );
}

function fallbackAperturaFria(caso = {}) {
  const detalle = caso.detallePerfil || { type: "none", value: "" };
  const saludo = extraerSaludoInicial(caso.textoPlano) ? "Hola. " : "";

  if (detalle.value) {
    return [
      `${saludo}Vi ${detalle.value} en tu perfil y me pareció mejor empezar por algo real que por una frase vacía. ¿Qué es lo que más te gusta de eso?`,
      `${saludo}Entre todo lo que podía decirte, ${detalle.value} fue lo que más me dio curiosidad. ¿Qué te engancha más de eso?`,
      `${saludo}Prefiero abrir con algo concreto: vi ${detalle.value} en tu perfil. ¿Eso va más contigo por gusto o por lo que te hace sentir?`
    ];
  }

  return [
    `${saludo}Prefiero empezar con algo simple y real: ¿qué tipo de conversación sí te dan ganas de seguir cuando alguien te escribe por aquí?`,
    `${saludo}No quise abrir con una frase vacía, así que voy con una sencilla: ¿qué suele llamar tu atención cuando alguien te empieza a hablar?`,
    `${saludo}Antes que sonar igual que todos, prefiero preguntarte algo directo: ¿eres más de charlas tranquilas o de gente que entra con más chispa?`
  ];
}

function fallbackReaperturaSuave(caso = {}) {
  const detalle = caso.detallePerfil || { type: "none", value: "" };
  const saludo = extraerSaludoInicial(caso.textoPlano) ? "Hola. " : "Hola. ";

  if (detalle.value) {
    return [
      `${saludo}Paso por aquí con algo más claro: vi ${detalle.value} en tu perfil. ¿Qué es lo que más te llama de eso?`,
      `${saludo}En vez de repetir un saludo vacío, mejor te pregunto algo concreto: vi ${detalle.value} en tu perfil. ¿Qué te engancha más de eso?`,
      `${saludo}Prefiero reabrir con algo real: vi ${detalle.value} en tu perfil. ¿Eso va más contigo por gusto, por energía o por costumbre?`
    ];
  }

  return [
    `${saludo}Paso por aquí con una pregunta simple y real: ¿qué suele hacer que una conversación te parezca interesante desde el principio?`,
    `${saludo}En vez de dejar un mensaje más del montón, prefiero preguntarte algo concreto: ¿qué te hace seguir una charla por aquí?`,
    `${saludo}Reaparezco con una fácil para no sonar copiado: ¿eres más de gente tranquila o de quien entra con un poco más de chispa?`
  ];
}

function fallbackSeguimientoChat(caso = {}) {
  const borrador = normalizarTexto(caso.textoPlano);

  if (/extrañ/.test(borrador)) {
    return [
      "Si te soy sincero, sí te he estado extrañando un poco. ¿A ti también te pasa que alguien se te queda dando vueltas en la cabeza?",
      "Te lo digo sin rodeos: sí te he extrañado, y me salió escribirte. ¿A ti te pasa algo parecido a veces?",
      "No te lo digo por decir: sí te he estado pensando un poco. ¿Te pasa de vez en cuando que alguien se te queda presente sin buscarlo?"
    ];
  }

  if (/ocupad/.test(borrador)) {
    return [
      "Solo quería saber si te agarré ocupada o si te pillé en un momento tranquilo.",
      "Te lo pregunto simple: ¿andas ocupada o todavía te queda un rato para una charla tranquila?",
      "Voy directo: ¿te agarro en medio de algo o estás más libre ahora?"
    ];
  }

  if (/que haces|que estas haciendo|que andas haciendo/.test(borrador)) {
    return [
      "Te hago una simple: ¿qué andas haciendo a esta hora?",
      "Voy con una fácil para no dar vueltas: ¿qué te tocó hacer hoy?",
      "Solo por curiosidad: ¿tu día va tranquilo o te agarré en medio de algo?"
    ];
  }

  if (contieneTerminoAfectivo(caso.textoPlano)) {
    return [
      "Mi amor, te lo digo simple: me salieron ganas de escribirte otra vez. ¿Cómo va tu noche?",
      "Mi amor, quise escribirte sin vueltas. ¿Cómo te está tratando el día?",
      "Mi amor, me nació hablarte otra vez. ¿Andas más tranquila ahora?"
    ];
  }

  return [
    "Quise escribirte algo simple y natural, no una frase vacía. ¿Cómo va tu día?",
    "Voy con algo directo para que fluya mejor: ¿cómo te ha tratado el día?",
    "Prefiero decirlo simple antes que sonar forzado: ¿cómo vas hoy?"
  ];
}

function fallbackRespuestaChat(caso = {}) {
  return [
    "Te sigo. Quiero responderte bien sin darle vueltas: ¿eso lo ves así desde hace tiempo o hubo algo que te hizo pensarlo de esa manera?",
    "Te entiendo mejor por ahí. Quiero preguntarte algo concreto: ¿eso te sale natural o viene de algo que has vivido muy de cerca?",
    "Lo que dices tiene una idea clara detrás. ¿Lo ves así por intuición o porque ya te tocó vivir algo parecido?"
  ];
}

function fallbackMailApertura(caso = {}) {
  const detalle = caso.detallePerfil || { type: "none", value: "" };

  if (detalle.value) {
    return [
      `Hola. Vi ${detalle.value} en tu perfil y me pareció un mejor punto para empezar que una frase vacía. ¿Qué es lo que más te gusta de eso?`,
      `Hola. Me llamó la atención ${detalle.value} y preferí empezar por algo real. ¿Qué te engancha más de eso?`,
      `Hola. Entre lo que vi en tu perfil, ${detalle.value} fue lo que más curiosidad me dio. ¿Eso va más contigo por gusto o por lo que te transmite?`
    ];
  }

  return [
    "Hola. Me pareciste interesante y preferí decírtelo simple antes que sonar igual que todos. ¿Qué suele llamarte la atención cuando alguien te escribe?",
    "Hola. Antes que mandar una frase vacía, prefiero ir a algo real: ¿eres más de conversaciones tranquilas o de gente que entra con un poco más de chispa?",
    "Hola. Quise escribirte algo natural y fácil de responder: ¿qué hace que una charla te resulte interesante desde el principio?"
  ];
}

function fallbackSuggestions(caso = {}) {
  if (caso.mode === "RESPUESTA_CHAT") return fallbackRespuestaChat(caso);
  if (caso.mode === "SEGUIMIENTO_CHAT") return fallbackSeguimientoChat(caso);
  if (caso.mode === "MAIL_APERTURA") return fallbackMailApertura(caso);
  if (caso.mode === "REAPERTURA_SUAVE") return fallbackReaperturaSuave(caso);
  return fallbackAperturaFria(caso);
}

function crearCaso({
  texto = "",
  cliente = "",
  contexto = "",
  perfil = "",
  chat_signals = {},
  page_type = ""
}) {
  const perfilParseado = parsePerfilPlano(perfil);

  const caso = {
    textoPlano: compactarBloque(texto, 700),
    clientePlano: compactarBloque(cliente, 450),
    contextoPlano: compactarBloque(contexto, 800),
    perfil: perfilParseado,
    chatSignals: buildSignals(chat_signals),
    pageType: String(page_type || "").trim().toLowerCase()
  };

  caso.mode = detectarModo({
    texto: caso.textoPlano,
    cliente: caso.clientePlano,
    chatSignals: caso.chatSignals,
    pageType: caso.pageType
  });

  caso.detallePerfil = pickDetallePerfil(caso.perfil, caso.textoPlano);

  return caso;
}

async function generarSugerenciasMotor(caso = {}) {
  let usageData = null;
  let options = [];

  try {
    const data = await llamarOpenAI({
      lane: "sugerencias",
      model: OPENAI_MODEL_SUGGESTIONS,
      messages: [
        { role: "system", content: buildSystemPrompt(caso) },
        { role: "user", content: buildUserPrompt(caso) }
      ],
      temperature: caso.mode === "RESPUESTA_CHAT" ? 0.62 : 0.82,
      maxTokens: 260,
      timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
    });

    usageData = data || null;
    options = limpiarOpciones(
      extractOptions(data?.choices?.[0]?.message?.content || ""),
      caso
    );
  } catch (_err) {
    options = [];
  }

  const fallback = limpiarOpciones(fallbackSuggestions(caso), caso);
  const final = dedupeStrings(
    [...options, ...fallback]
  ).slice(0, 3);

  return {
    sugerencias: final.length ? final : fallback.slice(0, 3),
    usageData
  };
}

async function generateSimpleSuggestions(input = {}) {
  const caso = crearCaso(input);
  return generarSugerenciasMotor(caso);
}

module.exports = {
  parsePerfilPlano,
  buildSignals,
  pickDetallePerfil,
  detectarModo,
  buildSystemPrompt,
  buildUserPrompt,
  extractOptions,
  badSuggestion,
  fallbackSuggestions,
  crearCaso,
  generarSugerenciasMotor,
  generateSimpleSuggestions
};
