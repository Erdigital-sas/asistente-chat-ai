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
  limpiarTextoIA,
  esRespuestaBasura,
  contieneTemaEncuentro,
  detectarElementosClave,
  extraerNombreEnApertura,
  analizarCliente,
  analizarMensajeOperador,
  construirLecturaCliente,
  construirLecturaOperador,
  filtrarContextoRelevante,
  limitarContexto,
  construirEstadoConversacion,
  detectarIntencionOperador,
  construirGuiaIntencion,
  detectarTemaPropioOperador,
  parsearPerfilEstructurado,
  construirGuiaPerfil,
  detectarHechosClienteSensibles,
  extraerMencionesGeograficasOperador,
  esSolicitudContacto,
  violaPropiedadHechosCliente
} = require("../lib/text");

const { construirSystemPrompt } = require("../prompts/systemPrompt");
const { construirUserPrompt } = require("../prompts/userPrompt");
const { llamarOpenAI } = require("./openai");

const MEMORY_TTL_MS = 20 * 60 * 1000;
const MEMORY_LIMIT = 400;
const recentSuggestionMemory = new Map();

const LENGTH_MAP = {
  corto: { min: 55, max: 115, ideal: 80, shape: "observación breve + pregunta corta" },
  medio: { min: 70, max: 140, ideal: 105, shape: "frase natural + curiosidad simple" },
  largo: { min: 110, max: 190, ideal: 150, shape: "reacción clara + un cierre ligero" }
};

const META_REGEX =
  /\b(quise escribirte mejor|queria escribirte mejor|responderte mejor|con mas intencion|con mas calma|con mas naturalidad|me dejo curiosidad real|por como lo dijiste|siempre hablas asi|piloto automatico|tu mejor vibra|tu mejor energia)\b/i;

const BAD_CONTINUITY_REGEX =
  /\b(retomar|seguir conversando|continuar la charla|volver a hablar|otra vez|de nuevo|como te decia)\b/i;

const CONTACT_REGEX =
  /\b(whatsapp|telegram|instagram|snapchat|discord|numero|telefono|phone|mail|email|correo)\b/i;

const LOCATION_QUESTION_REGEX =
  /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i;

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

function pruneSuggestionMemory() {
  const now = Date.now();

  for (const [key, value] of recentSuggestionMemory.entries()) {
    if (!value || value.expiresAt <= now) {
      recentSuggestionMemory.delete(key);
    }
  }

  while (recentSuggestionMemory.size > MEMORY_LIMIT) {
    const oldestKey = recentSuggestionMemory.keys().next().value;
    recentSuggestionMemory.delete(oldestKey);
  }
}

function getMemoryKey(caso = {}) {
  return [
    normalizarTexto(caso.operador || "anon").slice(0, 80),
    normalizarTexto(caso.tipoContacto || "nuevo_total"),
    normalizarTexto(caso.textoPlano || "").slice(0, 220),
    normalizarTexto(caso.clientePlano || "").slice(0, 180),
    normalizarTexto(caso.contextoPlano || "").slice(-320),
    normalizarTexto(caso.perfilPlano || "").slice(0, 180)
  ].join("||");
}

function readRecentSuggestions(memoryKey = "") {
  pruneSuggestionMemory();

  const entry = recentSuggestionMemory.get(memoryKey);
  if (!entry) return [];

  if (entry.expiresAt <= Date.now()) {
    recentSuggestionMemory.delete(memoryKey);
    return [];
  }

  return Array.isArray(entry.values) ? entry.values : [];
}

function writeRecentSuggestions(memoryKey = "", suggestions = []) {
  if (!memoryKey || !Array.isArray(suggestions) || !suggestions.length) return;

  pruneSuggestionMemory();
  recentSuggestionMemory.set(memoryKey, {
    values: suggestions.slice(0, 6),
    expiresAt: Date.now() + MEMORY_TTL_MS
  });
}

function sanitizeLocation(raw = "") {
  const texto = limpiarSalidaHumana(raw || "");
  if (!texto) return "";
  if (/\d/.test(texto)) return "";
  if (texto.split(/\s+/).length > 4) return "";
  if (/^(about|bio|interested in|looking for|my content|present requests)$/i.test(texto)) {
    return "";
  }
  return texto;
}

function getInterests(perfilEstructurado = {}) {
  return {
    comunes: dedupeStrings(perfilEstructurado?.interesesEnComun || []),
    clienta: dedupeStrings(perfilEstructurado?.interesesClienta || [])
  };
}

function elegirDetallePrioritario(caso = {}) {
  const wantsLocation = Boolean(caso.preguntaUbicacion);
  const intereses = getInterests(caso.perfilEstructurado);

  if (intereses.comunes.length) {
    return { type: "interes_comun", value: intereses.comunes[0] };
  }

  if (intereses.clienta.length) {
    return { type: "interes_clienta", value: intereses.clienta[0] };
  }

  if (wantsLocation) {
    const ubicacion = sanitizeLocation(caso?.perfilEstructurado?.ubicacionClienta || "");
    if (ubicacion) {
      return { type: "ubicacion", value: ubicacion };
    }
  }

  return { type: "none", value: "" };
}

function inferirTipoContacto(estadoConversacion = {}) {
  if (estadoConversacion?.hayConversacionReal) return "viejo_con_respuesta";
  if ((estadoConversacion?.lineasOperador || []).length) return "viejo_sin_respuesta";
  return "nuevo_total";
}

function inferirModo(caso = {}) {
  if (caso?.estadoConversacion?.hayConversacionReal && caso?.analisisCliente?.pregunta) {
    return "RESPUESTA_DIRECTA";
  }

  if (caso?.estadoConversacion?.hayConversacionReal) {
    return "CONTINUIDAD";
  }

  if (caso?.tipoContacto === "viejo_sin_respuesta") {
    return "REAPERTURA_SUAVE";
  }

  return "APERTURA_FRIA";
}

function construirObjetivoLongitud(caso = {}) {
  const textLen = contarCaracteres(caso.textoPlano || "");
  let profile = "medio";

  if (caso.mode === "RESPUESTA_DIRECTA") {
    profile = textLen <= 60 ? "corto" : "medio";
  } else if (caso.mode === "APERTURA_FRIA" || caso.mode === "REAPERTURA_SUAVE") {
    profile = textLen <= 50 ? "corto" : "medio";
  } else if (
    textLen > 180 ||
    caso?.analisisOperador?.metaEdicion ||
    caso?.analisisOperador?.mezclaDeIdeas
  ) {
    profile = "largo";
  }

  return {
    profile,
    ...LENGTH_MAP[profile],
    instruction:
      profile === "corto"
        ? "Si el caso es simple, resuelve en una línea viva y una sola pregunta suave."
        : profile === "medio"
          ? "Desarrolla lo justo para sonar natural y no vacío."
          : "Puedes desarrollar un poco más, pero sin sonar pesado."
  };
}

function construirAnchor(caso = {}) {
  if (caso?.estadoConversacion?.hayConversacionReal && (caso.lineasClienteRecientes || []).length) {
    return limpiarSalidaHumana(
      caso.lineasClienteRecientes[caso.lineasClienteRecientes.length - 1] || ""
    ).slice(0, 180);
  }

  if (caso.operadorTraeTemaPropio && caso.textoPlano) {
    return limpiarSalidaHumana(caso.textoPlano).slice(0, 180);
  }

  if (caso.detallePrioritario?.value) {
    return caso.detallePrioritario.value;
  }

  return "";
}

function construirObjetivoConversacional(caso = {}) {
  if (caso.tipoContacto === "nuevo_total") {
    return "Abrir la conversación con naturalidad, curiosidad real y una respuesta fácil de dar.";
  }

  if (caso.tipoContacto === "viejo_sin_respuesta") {
    return "Reabrir suave, sin reclamo y sin fingir continuidad, dejando una pregunta concreta y ligera.";
  }

  if (caso.estadoConversacion?.hayConversacionReal && caso.analisisCliente?.pregunta) {
    return "Responder primero a la pregunta o idea de la clienta y luego mover la charla con naturalidad.";
  }

  return "Continuar la charla de forma natural, concreta y fácil de responder.";
}

function palabrasSet(texto = "") {
  return new Set(
    normalizarTexto(texto)
      .split(/\s+/)
      .filter((x) => x.length >= 4)
  );
}

function overlapRatio(a = "", b = "") {
  const sa = palabrasSet(a);
  const sb = palabrasSet(b);
  if (!sa.size || !sb.size) return 0;

  let overlap = 0;
  for (const word of sb) {
    if (sa.has(word)) overlap += 1;
  }

  return overlap / Math.max(1, sb.size);
}

function sePareceDemasiado(a = "", b = "") {
  const na = normalizarTexto(a);
  const nb = normalizarTexto(b);

  if (!na || !nb) return false;
  if (na === nb) return true;

  return overlapRatio(na, nb) >= 0.82 || overlapRatio(nb, na) >= 0.82;
}

function normalizarCandidata(texto = "") {
  return normalizarEspacios(
    String(texto || "")
      .replace(/[“”"]/g, "")
      .replace(/\n+/g, " ")
      .trim()
  );
}

function extraerOpcionesModelo(raw = "") {
  return limpiarTextoIA(raw)
    .map(normalizarCandidata)
    .filter(Boolean)
    .filter((s) => !esRespuestaBasura(s));
}

function contieneContactoExterno(texto = "") {
  return CONTACT_REGEX.test(normalizarTexto(texto)) || esSolicitudContacto(texto);
}

function violaReglasBase(sugerencia = "", caso = {}) {
  const s = normalizarCandidata(sugerencia);
  const ns = normalizarTexto(s);

  if (!s) return true;
  if (esRespuestaBasura(s)) return true;
  if (META_REGEX.test(ns)) return true;
  if (contieneTemaEncuentro(s)) return true;
  if (contieneContactoExterno(s)) return true;
  if (violaPropiedadHechosCliente(s, caso.hechosClienteSensibles, caso.textoPlano)) return true;

  if (!caso.estadoConversacion?.hayConversacionReal && BAD_CONTINUITY_REGEX.test(ns)) {
    return true;
  }

  if (
    !caso.estadoConversacion?.hayConversacionReal &&
    /^(gracias|claro|entiendo|me alegra|me gusta lo que dices)\b/i.test(ns)
  ) {
    return true;
  }

  if (!caso.preguntaUbicacion) {
    const ubicacion = sanitizeLocation(caso?.perfilEstructurado?.ubicacionClienta || "");
    const locNorm = normalizarTexto(ubicacion);
    if (locNorm && ns.includes(locNorm)) {
      return true;
    }
  }

  const nombreEsperado = normalizarTexto(caso?.elementosClave?.nombreApertura || "");
  const nombreCandidata = normalizarTexto(extraerNombreEnApertura(s));

  if (!nombreEsperado && nombreCandidata) {
    return true;
  }

  if (nombreEsperado && nombreCandidata && nombreEsperado !== nombreCandidata) {
    return true;
  }

  return false;
}

function cumpleLongitud(sugerencia = "", objetivo = LENGTH_MAP.medio) {
  const total = contarCaracteres(sugerencia);
  return total >= objetivo.min && total <= objetivo.max;
}

function filtrarSugerenciasFinales(sugerencias = [], caso = {}) {
  const banned = readRecentSuggestions(caso.memoryKey || "");
  const salida = [];

  for (const item of Array.isArray(sugerencias) ? sugerencias : []) {
    const limpio = normalizarCandidata(item);
    if (!limpio) continue;
    if (violaReglasBase(limpio, caso)) continue;
    if (!cumpleLongitud(limpio, caso.objetivoLongitud)) continue;
    if (sePareceDemasiado(limpio, caso.textoPlano || "")) continue;
    if (banned.some((x) => sePareceDemasiado(x, limpio))) continue;
    if (salida.some((x) => sePareceDemasiado(x, limpio))) continue;
    salida.push(limpio);
  }

  return salida;
}

function buildColdOpenFallbacks(caso = {}) {
  const detalle = caso.detallePrioritario || { type: "none", value: "" };

  if (detalle.type === "interes_comun" || detalle.type === "interes_clienta") {
    const interes = limpiarSalidaHumana(detalle.value).toLowerCase();

    return [
      `Hola. Vi ${interes} en tu perfil y me pareció un mejor punto para empezar que una frase vacía. ¿Qué es lo que más disfrutas de eso?`,
      `Hola. Entre todo lo que podía decirte, ${interes} fue el detalle que más me dio curiosidad. ¿Te viene de hace tiempo o apareció después?`,
      `Hola. ${interes} me llamó la atención en tu perfil y sentí que por ahí podía salir una charla más real. ¿Qué parte de eso te engancha más?`
    ];
  }

  return [
    "Hola. Prefiero abrir con algo simple y real: ¿qué tipo de conversación sí te dan ganas de seguir cuando alguien te escribe por aquí?",
    "Hola. No quise dejarte un mensaje vacío, así que voy con una fácil: ¿qué suele llamarte la atención de verdad cuando alguien te empieza a hablar?",
    "Hola. Antes que soltar una frase cualquiera, prefiero ir directo a algo útil: ¿eres más de charlas tranquilas o de gente que entra con más chispa desde el inicio?"
  ];
}

function buildSoftReopenFallbacks(caso = {}) {
  const detalle = caso.detallePrioritario || { type: "none", value: "" };

  if (detalle.type === "interes_comun" || detalle.type === "interes_clienta") {
    const interes = limpiarSalidaHumana(detalle.value).toLowerCase();

    return [
      `Hola. Paso por aquí con algo más claro: ${interes} me llamó la atención en tu perfil. ¿Qué es lo que más te engancha de eso?`,
      `Hola. En vez de repetir lo mismo, mejor te dejo una pregunta concreta: vi ${interes} en tu perfil. ¿Lo disfrutas por lo que te da o por lo que te hace sentir?`,
      `Hola. Me quedé con curiosidad por ${interes} y preferí empezar por ahí. ¿Es algo que te acompaña desde hace mucho o fue apareciendo con el tiempo?`
    ];
  }

  return [
    "Hola. Paso por aquí con una pregunta más simple que las frases típicas: ¿qué clase de charla sí te hace quedarte un rato por aquí?",
    "Hola. En vez de dejarte otro mensaje vacío, mejor voy a algo concreto: ¿qué te hace seguir una conversación cuando alguien te escribe?",
    "Hola. Prefiero un inicio ligero y real antes que sonar copiado. ¿Qué suele hacer que una conversación te resulte interesante desde el principio?"
  ];
}

function buildReplyFallbacks(caso = {}) {
  if (caso.lineasClienteRecientes?.length) {
    return [
      "Lo que dices tiene más fondo de lo que parece. ¿Lo ves así desde hace tiempo o te pasó algo que te hizo pensarlo de esa manera?",
      "Entiendo por dónde vas, y me dio curiosidad una cosa: ¿eso te sale natural o viene de algo que has vivido de cerca?",
      "Tiene sentido lo que planteas. Me interesa saber si lo dices por intuición o porque ya te tocó vivir algo parecido."
    ];
  }

  return [
    "Te respondo directo: me interesa seguir por una línea más natural y concreta. ¿Qué tipo de tema sí te suele enganchar cuando hablas con alguien?",
    "Voy a algo simple para que no se pierda el hilo: ¿qué clase de conversación te sale más natural cuando conectas con alguien?",
    "Prefiero que esto vaya por una charla real y no por frases hechas. ¿Qué tema te hace abrirte más cuando alguien te interesa un poco?"
  ];
}

function construirFallbackSugerencias(caso = {}) {
  if (caso.tipoContacto === "nuevo_total") {
    return buildColdOpenFallbacks(caso).map(limpiarSalidaHumana);
  }

  if (caso.tipoContacto === "viejo_sin_respuesta") {
    return buildSoftReopenFallbacks(caso).map(limpiarSalidaHumana);
  }

  return buildReplyFallbacks(caso).map(limpiarSalidaHumana);
}

function construirFeedbackSegundoIntento(caso = {}, sugerencias = []) {
  const bloques = [
    "Necesito 3 opciones buenas y distintas entre sí.",
    caso.estadoConversacion?.hayConversacionReal
      ? "Hay respuesta real de la clienta. Responde primero a ella."
      : "No hay respuesta real de la clienta. No finjas continuidad.",
    "Evita frases meta y frases vacías.",
    "No uses ubicación si el borrador no está yendo claramente por ubicación.",
    "No repitas estructuras demasiado parecidas entre sí."
  ];

  if (sugerencias.length) {
    bloques.push(`No repitas ni reformules estas salidas:\n${sugerencias.join("\n")}`);
  }

  return bloques.join("\n");
}

function prepararCasoSugerencias({
  operador = "",
  texto = "",
  contexto = "",
  cliente = "",
  perfil = ""
}) {
  const textoPlano = compactarBloque(texto, 820);
  const clientePlano = compactarBloque(cliente, 520);
  const contextoPlano = compactarBloque(
    limitarContexto(filtrarContextoRelevante(contexto, texto, cliente)),
    900
  );
  const perfilPlano = compactarBloque(limitarContexto(perfil), 420);

  const analisisCliente = analizarCliente(clientePlano);
  const analisisOperador = analizarMensajeOperador(textoPlano);
  const lecturaCliente = construirLecturaCliente(analisisCliente);
  const lecturaOperadorBase = construirLecturaOperador(analisisOperador);
  const estadoConversacion = construirEstadoConversacion(clientePlano, contextoPlano);
  const tipoContacto = inferirTipoContacto(estadoConversacion);
  const preguntaUbicacion = LOCATION_QUESTION_REGEX.test(normalizarTexto(textoPlano));

  const perfilEstructuradoRaw = parsearPerfilEstructurado(perfilPlano);
  const perfilEstructurado = {
    ...perfilEstructuradoRaw,
    ubicacionClienta: sanitizeLocation(perfilEstructuradoRaw.ubicacionClienta || "")
  };

  const intencionOperador = detectarIntencionOperador(
    textoPlano,
    clientePlano,
    contextoPlano,
    estadoConversacion
  );

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
    analisisCliente,
    analisisOperador,
    lecturaCliente,
    estadoConversacion,
    tipoContacto,
    preguntaUbicacion,
    perfilEstructurado,
    elementosClave: detectarElementosClave(textoPlano),
    intencionOperador,
    guiaIntencion: construirGuiaIntencion(intencionOperador),
    operadorTraeTemaPropio: detectarTemaPropioOperador(textoPlano, analisisOperador),
    guiaPerfil: construirGuiaPerfil(perfilEstructurado, estadoConversacion.esChatNuevoOperativo),
    hechosClienteSensibles: detectarHechosClienteSensibles(estadoConversacion.lineasClienta.slice(-4)),
    mencionesGeograficasOperador: extraerMencionesGeograficasOperador(textoPlano),
    lineasClienteRecientes: dedupeStrings(estadoConversacion.lineasClienta.slice(-4)).slice(-4),
    lineasOperadorRecientes: dedupeStrings(estadoConversacion.lineasOperador.slice(-4)).slice(-4),
    contactoEnBorrador: esSolicitudContacto(textoPlano),
    contactoExterno: analisisCliente.contacto,
    temaContactoExterno: Boolean(analisisCliente.contacto || esSolicitudContacto(textoPlano))
  };

  baseCaso.mode = inferirModo(baseCaso);
  baseCaso.objetivoLongitud = construirObjetivoLongitud(baseCaso);
  baseCaso.detallePrioritario = elegirDetallePrioritario(baseCaso);
  baseCaso.anchor = construirAnchor(baseCaso);
  baseCaso.objetivoConversacional = construirObjetivoConversacional(baseCaso);
  baseCaso.saludoRule =
    baseCaso.tipoContacto === "viejo_con_respuesta"
      ? "No metas saludo si no aporta; entra directo al punto."
      : "Saludo corto permitido si ayuda a sonar natural.";
  baseCaso.followUpRule =
    baseCaso.tipoContacto === "viejo_con_respuesta"
      ? "Continúa el hilo real de ella antes de abrir otro tema."
      : "No finjas continuidad ni uses otra vez, seguir, retomar o similares.";
  baseCaso.profileUseRule =
    baseCaso.detallePrioritario?.value
      ? `Si usas perfil, prioriza este detalle: ${baseCaso.detallePrioritario.value}.`
      : "Si usas perfil, hazlo solo como apoyo y sin inventar terreno común.";
  baseCaso.locationRule =
    baseCaso.preguntaUbicacion && baseCaso.perfilEstructurado.ubicacionClienta
      ? `Solo si de verdad ayuda, puedes usar esta ubicación: ${baseCaso.perfilEstructurado.ubicacionClienta}.`
      : "No uses la ubicación del perfil en la salida.";
  baseCaso.lecturaOperador = [
    lecturaOperadorBase,
    baseCaso.tipoContacto === "nuevo_total"
      ? "Es apertura fría."
      : baseCaso.tipoContacto === "viejo_sin_respuesta"
        ? "Es reapertura suave sin respuesta real previa."
        : "Hay conversación real con la clienta."
  ].filter(Boolean).join(" ");

  baseCaso.memoryKey = getMemoryKey(baseCaso);
  baseCaso.bannedSuggestions = readRecentSuggestions(baseCaso.memoryKey);
  baseCaso.fingerprint = [
    "v5",
    normalizarTexto(operador).slice(0, 80),
    baseCaso.mode,
    baseCaso.tipoContacto,
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 260),
    normalizarTexto(contextoPlano).slice(-360),
    normalizarTexto(perfilPlano).slice(0, 220)
  ].join("||");

  return baseCaso;
}

async function pedirOpciones(caso = {}) {
  const prompt = construirUserPrompt(caso);

  const data = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(caso)
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: caso.tipoContacto === "viejo_con_respuesta" ? 0.68 : 0.82,
    maxTokens: 320,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const raw = data?.choices?.[0]?.message?.content || "";
  return {
    candidates: extraerOpcionesModelo(raw),
    usageData: data
  };
}

async function generarSugerencias(caso = {}) {
  const primera = await pedirOpciones(caso);
  let sugerencias = filtrarSugerenciasFinales(primera.candidates, caso);

  if (sugerencias.length < 3) {
    const segunda = await pedirOpciones({
      ...caso,
      bannedSuggestions: dedupeStrings([
        ...(caso.bannedSuggestions || []),
        ...primera.candidates,
        ...sugerencias
      ]),
      feedbackCorreccion: construirFeedbackSegundoIntento(caso, primera.candidates)
    });

    sugerencias = filtrarSugerenciasFinales(
      [...sugerencias, ...segunda.candidates],
      {
        ...caso,
        bannedSuggestions: caso.bannedSuggestions || []
      }
    );

    const combinedUsage = sumarUsage(primera.usageData, segunda.usageData);

    if (sugerencias.length < 3) {
      sugerencias = filtrarSugerenciasFinales(
        [...sugerencias, ...construirFallbackSugerencias(caso)],
        caso
      );
    }

    if (!sugerencias.length) {
      sugerencias = construirFallbackSugerencias(caso).slice(0, 3);
    }

    const finales = sugerencias.slice(0, 3);
    writeRecentSuggestions(caso.memoryKey, finales);

    return {
      sugerencias: finales,
      usageData: combinedUsage
    };
  }

  const finales = sugerencias.slice(0, 3);
  writeRecentSuggestions(caso.memoryKey, finales);

  return {
    sugerencias: finales,
    usageData: primera.usageData
  };
}

module.exports = {
  sumarUsage,
  prepararCasoSugerencias,
  filtrarSugerenciasFinales,
  generarSugerencias,
  construirFallbackSugerencias,
  construirObjetivoLongitud
};
