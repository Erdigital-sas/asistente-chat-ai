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

const LENGTH_PROFILES = {
  corto: { min: 45, max: 115, ideal: 75 },
  medio: { min: 80, max: 155, ideal: 115 },
  largo: { min: 130, max: 240, ideal: 180 }
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
  /\b(eso que dijiste cambia bastante el tono|eso que dijiste me dejo curiosidad|por como lo dijiste|siempre hablas asi|preferi escribirte mejor|responderte mejor|con mas intencion|con mas calma|con mas naturalidad|piloto automatico|tu mejor energia|tu mejor vibra|forma de ver las cosas)\b/i;

const STOPWORDS_ANCLA = new Set([
  "hola", "como", "estas", "esta", "pero", "porque", "por", "para", "quiero",
  "saber", "gustaria", "hablar", "conversar", "mensaje", "mensajes", "respuesta",
  "respuestas", "quieres", "quiero", "tengo", "tiene", "tener", "buen", "buena",
  "sobre", "algo", "este", "esta", "esto", "esas", "esos", "aqui", "alla",
  "muy", "poco", "mucho", "tambien", "solo", "igual", "donde", "cuando",
  "eres", "hacer", "gusta", "buscas"
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
  const explicita = limpiarSalidaHumana(perfilEstructurado?.ubicacionClienta || "");
  if (explicita) return explicita;

  return "";
}

function obtenerInteresPrioritario(perfilEstructurado = {}) {
  return (
    perfilEstructurado?.interesesEnComun?.[0] ||
    perfilEstructurado?.interesesClienta?.[0] ||
    ""
  );
}

function inferirTipoContacto(estadoConversacion = {}) {
  if (estadoConversacion?.hayConversacionReal) {
    return "viejo_con_respuesta";
  }

  if ((estadoConversacion?.lineasOperador || []).length > 0) {
    return "viejo_sin_respuesta";
  }

  return "nuevo_total";
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

  if (caso.tipoTrabajo === "reply_last_client_message" && caso.lineasClienteRecientes?.length) {
    return limpiarSalidaHumana(
      caso.lineasClienteRecientes[caso.lineasClienteRecientes.length - 1]
    ).slice(0, 180);
  }

  const ubicacion = caso.ubicacionVisiblePerfil || extraerUbicacionVisiblePerfil(caso.perfilEstructurado);
  if (ubicacion && textoPreguntaPorUbicacion(caso.textoPlano || "")) {
    return `dato visible del perfil: ${ubicacion}`;
  }

  const interes = obtenerInteresPrioritario(caso.perfilEstructurado);
  if (interes && textoPreguntaPorInteres(caso.textoPlano || "")) {
    return `interes del perfil: ${interes}`;
  }

  if (caso.operadorTraeTemaPropio && caso.textoPlano) {
    return limpiarSalidaHumana(caso.textoPlano).slice(0, 180);
  }

  if (ubicacion) {
    return `dato visible del perfil: ${ubicacion}`;
  }

  if (interes) {
    return `interes del perfil: ${interes}`;
  }

  return "seguir el tema real del borrador sin sonar abstracto";
}

function inferirTipoTrabajo(caso = {}) {
  if (["CONTACT_BLOCK", "GHOSTING", "CONFLICT_REFRAME", "MEDIA_REPLY"].includes(caso.mode)) {
    return "complex_reframe";
  }

  if (
    caso.analisisOperador?.preguntaSimpleDirecta &&
    caso.tipoContacto !== "viejo_con_respuesta"
  ) {
    return "simple_profile_fastpath";
  }

  if (
    caso.anclarEnUltimoMensajeCliente &&
    !caso.operadorTraeTemaPropio &&
    caso.estadoConversacion?.hayConversacionReal
  ) {
    return "reply_last_client_message";
  }

  return "rewrite_operator_draft";
}

function construirObjetivoLongitud(caso = {}) {
  const palabras = palabrasCount(caso.textoPlano || "");
  const textoLen = contarCaracteres(caso.textoPlano || "");
  const clienteLen = contarCaracteres(caso.clientePlano || "");
  const hasInterest = Boolean(obtenerInteresPrioritario(caso.perfilEstructurado));
  const hasLocation = Boolean(caso.ubicacionVisiblePerfil || extraerUbicacionVisiblePerfil(caso.perfilEstructurado));

  let profile = "medio";

  if (caso.tipoTrabajo === "simple_profile_fastpath") {
    profile = "corto";
  } else if (caso.tipoTrabajo === "reply_last_client_message") {
    if (clienteLen <= 120 && palabras <= 8) {
      profile = "corto";
    } else {
      profile = "medio";
    }
  } else if (caso.tipoTrabajo === "complex_reframe") {
    profile = "largo";
  } else {
    if (
      (caso.tipoContacto !== "viejo_con_respuesta" && caso.analisisOperador?.preguntaSimpleDirecta && (hasInterest || hasLocation)) ||
      (textoLen <= 60 && (hasInterest || hasLocation))
    ) {
      profile = "corto";
    } else if (
      textoLen > 170 ||
      caso.analisisOperador?.metaEdicion ||
      caso.analisisOperador?.reclamo ||
      caso.analisisOperador?.mezclaDeIdeas
    ) {
      profile = "largo";
    }
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

function textoPreguntaPorUbicacion(texto = "") {
  return /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i.test(normalizarTexto(texto));
}

function textoPreguntaPorBusqueda(texto = "") {
  return /\b(que buscas|what are you looking for|que tipo de relacion buscas|que clase de relacion buscas)\b/i.test(normalizarTexto(texto));
}

function textoPreguntaPorInteres(texto = "") {
  return /\b(te gusta|you like|cual equipo|which team|what team|futbol|football|deporte|sport|viajar|travel|dancing|bailar|shopping|compras|musica|music|arte|arts|gardening|jardineria|cooking|cocinar|nature|naturaleza)\b/i.test(normalizarTexto(texto));
}

function textoPreguntaPorActividad(texto = "") {
  return /\b(que haces|que haces ahora|what are you doing|que tal tu dia|como va tu dia)\b/i.test(normalizarTexto(texto));
}

function construirFastPathSimple(caso = {}) {
  const texto = caso.textoPlano || "";
  const ubicacion = caso.ubicacionVisiblePerfil || extraerUbicacionVisiblePerfil(caso.perfilEstructurado);
  const interes = obtenerInteresPrioritario(caso.perfilEstructurado);
  const tipoContacto = caso.tipoContacto || inferirTipoContacto(caso.estadoConversacion);

  if (caso.temaContactoExterno) {
    return limpiarSalidaHumana(
      "Podemos seguir por aqui sin problema. Dime algo concreto de ti que si valga la pena conocer."
    );
  }

  if (textoPreguntaPorUbicacion(texto)) {
    if (ubicacion) {
      if (tipoContacto === "viejo_sin_respuesta") {
        return limpiarSalidaHumana(
          `Vi que eres de ${ubicacion}. Ese detalle me dio curiosidad. Que es lo mejor de vivir ahi?`
        );
      }

      return limpiarSalidaHumana(
        `Vi que eres de ${ubicacion}. Que es lo que mas te gusta de vivir ahi?`
      );
    }

    return limpiarSalidaHumana(
      "Te hago una simple: de donde eres y que es lo que mas te gusta de ese lugar?"
    );
  }

  if (textoPreguntaPorInteres(texto)) {
    if (interes) {
      return limpiarSalidaHumana(
        `Vi que te gusta ${String(interes).toLowerCase()}. Lo sigues por gusto general o hay algo puntual que te engancha mas?`
      );
    }

    return limpiarSalidaHumana(
      "Eso me dio curiosidad. Lo sigues por gusto general o hay algo puntual que te engancha mas?"
    );
  }

  if (textoPreguntaPorBusqueda(texto)) {
    return limpiarSalidaHumana(
      "Te pregunto algo simple: aqui buscas algo tranquilo para hablar o algo mas serio?"
    );
  }

  if (textoPreguntaPorActividad(texto)) {
    if (interes) {
      return limpiarSalidaHumana(
        `Te hago una simple: hoy andas con algo de ${String(interes).toLowerCase()} o te toco otro plan?`
      );
    }

    return limpiarSalidaHumana(
      "Te hago una simple: que andas haciendo a esta hora?"
    );
  }

  if (tipoContacto !== "viejo_con_respuesta") {
    if (ubicacion) {
      return limpiarSalidaHumana(
        `Vi que eres de ${ubicacion}. Ese detalle me llamo la atencion enseguida. Que es lo mejor de estar ahi?`
      );
    }

    if (interes) {
      return limpiarSalidaHumana(
        `Vi que te gusta ${String(interes).toLowerCase()}. Me parecio mejor ir por ahi que con una frase comun. Que es lo que mas te engancha de eso?`
      );
    }
  }

  return "";
}

function esCasoSimpleFastPath(caso = {}) {
  if (caso.tipoTrabajo === "complex_reframe") return false;
  if (caso.tipoContacto === "viejo_con_respuesta") return false;
  if (!caso.analisisOperador?.preguntaSimpleDirecta) return false;
  if (caso.metaEdicion) return false;
  return true;
}

function construirResumenTipoContacto(tipoContacto = "nuevo_total") {
  const mapa = {
    nuevo_total: "Cliente nueva. Debes enganchar como primer acercamiento.",
    viejo_sin_respuesta: "Hay historial del operador, pero no respuesta real de la clienta. No finjas continuidad ni respondas como si ella ya hubiera abierto tema.",
    viejo_con_respuesta: "Ya hubo respuesta real de la clienta. Responde primero a lo ultimo que ella dijo."
  };

  return mapa[tipoContacto] || mapa.nuevo_total;
}

function construirResumenTrabajo(tipoTrabajo = "rewrite_operator_draft") {
  const mapa = {
    simple_profile_fastpath: "Caso simple con dato claro del perfil o pregunta directa.",
    rewrite_operator_draft: "Debes mejorar el borrador del operador sin tratarlo como si ella lo hubiera dicho.",
    reply_last_client_message: "Debes responder primero a lo ultimo de la clienta.",
    complex_reframe: "Caso complejo que requiere tacto y control."
  };

  return mapa[tipoTrabajo] || mapa.rewrite_operator_draft;
}

function planHeuristico(caso = {}) {
  const mode = detectarModeHeuristico(caso);
  const tipoTrabajo = inferirTipoTrabajo({ ...caso, mode });
  const anchor = detectarAnchorHeuristico({ ...caso, mode, tipoTrabajo }, mode);
  const chosenInterest = obtenerInteresPrioritario(caso.perfilEstructurado);

  return {
    mode,
    anchor,
    chosen_interest: chosenInterest,
    summary: `${construirResumenTipoContacto(caso.tipoContacto)} ${construirResumenTrabajo(tipoTrabajo)}`.trim()
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
    estadoConversacion.lineasClienta.slice(-4)
  ).slice(-4);

  const lineasOperadorRecientes = dedupeStrings(
    estadoConversacion.lineasOperador.slice(-4)
  ).slice(-4);

  const anclarEnUltimoMensajeCliente =
    estadoConversacion.hayConversacionReal &&
    !operadorTraeTemaPropio &&
    lineasClienteRecientes.length > 0;

  const hechosClienteSensibles = detectarHechosClienteSensibles(lineasClienteRecientes);
  const mencionesGeograficasOperador = extraerMencionesGeograficasOperador(texto);
  const contactoEnBorrador = esSolicitudContacto(texto);
  const temaContactoExterno = Boolean(analisisCliente.contacto || contactoEnBorrador);

  const tipoContacto = inferirTipoContacto(estadoConversacion);
  const ubicacionVisiblePerfil = extraerUbicacionVisiblePerfil(perfilEstructurado);

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
    mencionesGeograficasOperador,
    tipoContacto,
    ubicacionVisiblePerfil
  };

  const mode = detectarModeHeuristico(baseCaso);
  const tipoTrabajo = inferirTipoTrabajo({
    ...baseCaso,
    mode
  });
  const objetivoLongitud = construirObjetivoLongitud({
    ...baseCaso,
    mode,
    tipoTrabajo
  });
  const plan = planHeuristico({
    ...baseCaso,
    mode,
    tipoTrabajo
  });

  const lecturaOperador = [
    construirLecturaOperador(analisisOperador),
    construirResumenTipoContacto(tipoContacto),
    construirResumenTrabajo(tipoTrabajo),
    !estadoConversacion.hayConversacionReal
      ? "No hay respuesta real de la clienta."
      : "",
    anclarEnUltimoMensajeCliente
      ? "Hay mensajes recientes de la clienta y el operador no trae tema nuevo claro. Prioriza lo ultimo que ella dijo."
      : ""
  ].filter(Boolean).join(" ");

  const fingerprint = [
    "premium-v4",
    normalizarTexto(operador).slice(0, 80),
    mode,
    tipoTrabajo,
    tipoContacto,
    objetivoLongitud.profile,
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 260),
    normalizarTexto(contextoPlano).slice(-500),
    normalizarTexto(perfilPlano).slice(0, 260)
  ].join("||");

  return {
    ...baseCaso,
    lecturaOperador,
    mode,
    tipoTrabajo,
    objetivoLongitud,
    anchor: plan.anchor,
    plan,
    fingerprint
  };
}

function necesitaSegundoIntentoCandidato(candidata = "", caso = {}, sugerenciasFiltradas = []) {
  const t = normalizarTexto(candidata || "");

  if (!candidata || !sugerenciasFiltradas.length) return true;
  if (esMetaRobotica(candidata)) return true;
  if (!cumpleLongitudPremium(candidata, caso.objetivoLongitud)) return true;

  if (
    caso.tipoTrabajo === "reply_last_client_message" &&
    caso.anclarEnUltimoMensajeCliente &&
    !tieneAnclaReal(candidata, caso.anchor)
  ) {
    return true;
  }

  if (
    caso.tipoContacto !== "viejo_con_respuesta" &&
    /\b(eso que dijiste|por como lo dijiste|siempre hablas asi|fue por el momento)\b/.test(t)
  ) {
    return true;
  }

  if (
    caso.tipoTrabajo === "rewrite_operator_draft" &&
    /\b(eso que dijiste|por como lo dijiste|siempre hablas asi)\b/.test(t)
  ) {
    return true;
  }

  return false;
}

function construirFeedbackSegundoIntento(caso = {}, candidata = "") {
  const bloques = [];

  bloques.push("El intento anterior no quedo bien. Corrigelo.");
  bloques.push(`Tipo de trabajo: ${caso.tipoTrabajo}`);
  bloques.push(`Tipo de contacto: ${caso.tipoContacto}`);
  bloques.push(`Ancla obligatoria: ${caso.anchor || "seguir el tema real del borrador"}`);
  bloques.push(`Longitud obligatoria: ${caso.objetivoLongitud.min}-${caso.objetivoLongitud.max} caracteres.`);
  bloques.push("No respondas al operador como si el borrador fuera algo que la clienta dijo.");
  bloques.push("Si no hay respuesta real de la clienta, no escribas como si ya vinieran conversando.");
  bloques.push("Si el caso es simple, no des discurso.");
  bloques.push("Evita frases tipo eso que dijiste, por como lo dijiste, siempre hablas asi, me dejo curiosidad real.");

  if (caso.tipoTrabajo === "rewrite_operator_draft") {
    bloques.push("Tu tarea es mejorar el borrador del operador manteniendo su intencion. No le contestes como si fuera un mensaje de ella.");
  }

  if (caso.tipoTrabajo === "reply_last_client_message") {
    bloques.push("Tu tarea es responder primero lo ultimo que dijo la clienta. No ignores ese punto.");
  }

  if (caso.ubicacionVisiblePerfil && textoPreguntaPorUbicacion(caso.textoPlano || "")) {
    bloques.push(`La ubicacion visible del perfil es ${caso.ubicacionVisiblePerfil}. Si la pregunta va por ahi, usala de forma simple.`);
  }

  const interes = obtenerInteresPrioritario(caso.perfilEstructurado);
  if (interes && textoPreguntaPorInteres(caso.textoPlano || "")) {
    bloques.push(`El interes visible del perfil es ${interes}. Si la pregunta va por ahi, usalo de forma simple.`);
  }

  if (candidata) {
    bloques.push(`Texto flojo anterior: ${candidata}`);
  }

  return bloques.join("\n");
}

function recortarNatural(texto = "", max = 150) {
  const limpio = normalizarEspacios(String(texto || ""));
  if (!limpio) return "";
  if (limpio.length <= max) return limpiarSalidaHumana(limpio);

  const corte = limpio.slice(0, max);
  const idx = Math.max(
    corte.lastIndexOf(". "),
    corte.lastIndexOf("? "),
    corte.lastIndexOf("! "),
    corte.lastIndexOf(", ")
  );

  const base = idx > Math.floor(max * 0.55)
    ? corte.slice(0, idx).trim()
    : corte.trim();

  return limpiarSalidaHumana(base.replace(/[,:;]+$/g, "").trim());
}

function construirFallbackRewriteDesdeBorrador(caso = {}) {
  const texto = normalizarTexto(caso.textoPlano || "");
  const original = limpiarSalidaHumana(caso.textoPlano || "");

  if (!original) return "";

  if (/\b(discutir|pelea|problema|molesta|molesto|discutiendo)\b/.test(texto)) {
    return "No quiero que esto se convierta en una discusion por una mala vuelta. De verdad sientes que estamos yendo por ahi?";
  }

  if (/\b(que haces|que haces ahora|what are you doing)\b/.test(texto)) {
    return "Te hago una simple: que andas haciendo a esta hora?";
  }

  if (/\b(de donde eres|where are you from|donde vives)\b/.test(texto)) {
    const ubicacion = caso.ubicacionVisiblePerfil || "";
    if (ubicacion) {
      return `Vi que eres de ${ubicacion}. Que es lo que mas te gusta de vivir ahi?`;
    }
  }

  if (/\b(te gusta|futbol|football|music|musica|arte|arts|travel|viajar|cooking|cocinar|nature|naturaleza)\b/.test(texto)) {
    const interes =
      caso.plan?.chosen_interest ||
      caso.perfilEstructurado?.interesesEnComun?.[0] ||
      caso.perfilEstructurado?.interesesClienta?.[0] ||
      "";

    if (interes) {
      return `Vi que te gusta ${String(interes).toLowerCase()}. Lo sigues por gusto general o hay algo puntual que te engancha mas?`;
    }
  }

  const recortado = recortarNatural(original, caso.objetivoLongitud?.max || 150);
  if (recortado) return recortado;

  return "";
}

function construirFallbackSugerencias(caso = {}) {
  const interes = obtenerInteresPrioritario(caso.perfilEstructurado);
  const ubicacion = caso.ubicacionVisiblePerfil || extraerUbicacionVisiblePerfil(caso.perfilEstructurado);

  if (caso.tipoTrabajo === "simple_profile_fastpath") {
    const fast = construirFastPathSimple(caso);
    return fast ? [fast] : [];
  }

  if (caso.tipoTrabajo === "reply_last_client_message") {
    return [
      "Lo que comentas tiene mas fondo de lo que parece. Siempre lo ves asi o fue muy de ese momento?"
    ];
  }

  if (caso.tipoTrabajo === "rewrite_operator_draft") {
    const desdeBorrador = construirFallbackRewriteDesdeBorrador(caso);
    if (desdeBorrador) {
      return [desdeBorrador];
    }

    if (ubicacion) {
      return [
        `Vi que eres de ${ubicacion}. Ese detalle me llamo la atencion enseguida. Que es lo mejor de estar ahi?`
      ];
    }

    if (interes) {
      return [
        `Vi que te gusta ${String(interes).toLowerCase()}. Me dio curiosidad saber que es lo que mas te engancha de eso.`
      ];
    }

    return [
      "Hay algo en lo que dices que da para una charla interesante. Te ha pasado algo reciente que te haya hecho verlo asi?"
    ];
  }

  if (caso.mode === "CONTACT_BLOCK") {
    return [
      "Podemos seguir por aqui sin problema. Ya que estamos, dime algo concreto de ti que si valga la pena conocer."
    ];
  }

  if (caso.mode === "GHOSTING") {
    return [
      "No te escribo para hacer drama. Solo me dio curiosidad saber si fue el momento o si esto no termino de engancharte."
    ];
  }

  if (caso.mode === "MEDIA_REPLY") {
    return [
      "Lo que mandaste me dejo curiosidad. Que fue lo que mas te gusto a ti de ese momento?"
    ];
  }

  if (caso.mode === "CONFLICT_REFRAME") {
    return [
      "No quiero que esto se vaya a un choque innecesario. Que fue exactamente lo que te molesto?"
    ];
  }

  if (ubicacion) {
    return [
      `Vi que eres de ${ubicacion}. Ese detalle me llamo la atencion enseguida. Que es lo mejor de estar ahi?`
    ];
  }

  if (interes) {
    return [
      `Vi que te gusta ${String(interes).toLowerCase()}. Que es lo que mas te engancha de eso?`
    ];
  }

  return [
    "Te hago una simple: que tipo de charla suele engancharte mas cuando alguien te escribe?"
  ];
}

async function generarSugerencias(caso = {}) {
  if (esCasoSimpleFastPath(caso)) {
    const directa = construirFastPathSimple(caso);

    if (directa) {
      return {
        sugerencias: [directa],
        usageData: null
      };
    }
  }

  const planSummary = [
    construirResumenTipoContacto(caso.tipoContacto),
    construirResumenTrabajo(caso.tipoTrabajo)
  ].join(" ");

  const userPrompt1 = construirUserPrompt({
    mode: caso.mode,
    tipoTrabajo: caso.tipoTrabajo,
    tipoContacto: caso.tipoContacto,
    anchor: caso.anchor,
    planSummary,
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
    ubicacionVisiblePerfil: caso.ubicacionVisiblePerfil,
    feedbackCorreccion: ""
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
          caso.mode,
          caso.objetivoLongitud,
          caso.tipoTrabajo,
          caso.tipoContacto
        )
      },
      {
        role: "user",
        content: userPrompt1
      }
    ],
    temperature: caso.tipoTrabajo === "complex_reframe"
      ? (caso.ghostwriterMode ? 0.64 : 0.56)
      : (caso.ghostwriterMode ? 0.56 : 0.46),
    maxTokens: caso.objetivoLongitud.profile === "corto"
      ? 90
      : caso.objetivoLongitud.profile === "medio"
        ? 140
        : 220,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const candidata1 = extraerPrimeraSugerenciaPremium(
    data1?.choices?.[0]?.message?.content || ""
  );

  const sugerencias1 = filtrarSugerenciasFinales([candidata1], caso);

  if (!necesitaSegundoIntentoCandidato(candidata1, caso, sugerencias1)) {
    return {
      sugerencias: [sugerencias1[0]],
      usageData: data1
    };
  }

  const userPrompt2 = construirUserPrompt({
    mode: caso.mode,
    tipoTrabajo: caso.tipoTrabajo,
    tipoContacto: caso.tipoContacto,
    anchor: caso.anchor,
    planSummary,
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
    ubicacionVisiblePerfil: caso.ubicacionVisiblePerfil,
    feedbackCorreccion: construirFeedbackSegundoIntento(caso, candidata1)
  });

  const data2 = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(
          caso.permisosApertura,
          caso.elementosClave,
          caso.mode,
          caso.objetivoLongitud,
          caso.tipoTrabajo,
          caso.tipoContacto
        )
      },
      {
        role: "user",
        content: userPrompt2
      }
    ],
    temperature: caso.tipoTrabajo === "complex_reframe"
      ? (caso.ghostwriterMode ? 0.70 : 0.60)
      : (caso.ghostwriterMode ? 0.60 : 0.50),
    maxTokens: caso.objetivoLongitud.profile === "corto"
      ? 100
      : caso.objetivoLongitud.profile === "medio"
        ? 150
        : 240,
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

  if (sugerencias1.length) {
    return {
      sugerencias: [sugerencias1[0]],
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

  const ultimoRecurso = caso.tipoTrabajo === "simple_profile_fastpath"
    ? ["Te hago una simple: que tipo de charla suele engancharte mas cuando alguien te escribe?"]
    : caso.tipoTrabajo === "reply_last_client_message"
      ? ["Lo que comentas tiene mas fondo de lo que parece. Siempre lo ves asi o fue muy de ese momento?"]
      : ["Hay un detalle aqui que me dejo curiosidad. Que dirias que es lo primero que suele llamar la atencion de ti?"];

  return {
    sugerencias: [limpiarSalidaHumana(ultimoRecurso[0])],
    usageData: sumarUsage(data1, data2)
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
