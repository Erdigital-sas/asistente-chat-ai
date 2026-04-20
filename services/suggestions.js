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
  extraerMencionesGeograficasOperador
} = require("../lib/text");

const { construirSystemPrompt } = require("../prompts/systemPrompt");
const { construirUserPrompt } = require("../prompts/userPrompt");
const { llamarOpenAI } = require("./openai");

const PREMIUM_MIN_CHARS = 170;
const PREMIUM_MAX_CHARS = 300;
const PREMIUM_IDEAL_CHARS = 230;

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
  const clientePlano = compactarBloque(cliente, 420);
  const contextoPlano = compactarBloque(
    limitarContexto(contextoFiltrado),
    620
  );
  const perfilPlano = compactarBloque(
    limitarContexto(perfil),
    320
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
    estadoConversacion.lineasClienta.slice(-2)
  ).slice(-2);

  const lineasOperadorRecientes = dedupeStrings(
    estadoConversacion.lineasOperador.slice(-2)
  ).slice(-2);

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

  const fingerprint = [
    "premium-v1",
    normalizarTexto(textoPlano).slice(0, 420),
    normalizarTexto(clientePlano).slice(0, 240),
    normalizarTexto(contextoPlano).slice(-420),
    normalizarTexto(perfilPlano).slice(0, 220)
  ].join("||");

  return {
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

function puntuarLongitudPremium(texto = "") {
  const total = contarCaracteres(texto);
  if (!total) return -20;
  if (cumpleLongitudPremium(texto)) return 10;

  const distancia = Math.abs(total - PREMIUM_IDEAL_CHARS);
  return Math.max(-10, 6 - Math.ceil(distancia / 20));
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

function construirFallbackSugerencias({
  texto = "",
  cliente = "",
  estadoConversacion = null,
  perfilEstructurado = null
}) {
  const textoLimpio = limpiarSalidaHumana(texto || "");
  const estado = estadoConversacion || { hayConversacionReal: false };
  const interesPerfil =
    perfilEstructurado?.interesesEnComun?.[0] ||
    perfilEstructurado?.interesesClienta?.[0] ||
    "";

  if (!estado.hayConversacionReal) {
    if (interesPerfil) {
      const interes = limpiarSalidaHumana(interesPerfil).toLowerCase();

      return [
        `No queria dejarte otro mensaje comun, asi que preferi escribirte mejor. Vi que ${interes} aparece en tu perfil y me dio curiosidad saber que es lo que mas disfrutas de eso, porque siempre dice bastante mas de alguien que cualquier descripcion rapida.`
      ];
    }

    return [
      `No queria dejarte otro mensaje generico, asi que preferi escribirte mejor. Me dio curiosidad saber que tipo de detalle, plan o gusto es el que mas te representa cuando de verdad estas en tu mejor energia.`
    ];
  }

  const base = textoLimpio && textoLimpio.length >= 18
    ? textoLimpio.replace(/[?¿]+$/g, "").replace(/[.!]+$/g, "").trim()
    : "Queria responderte mejor";

  return [
    `${base}. Me quede pensando en lo ultimo que compartiste y preferi contestarte con mas intencion y menos piloto automatico, porque tu forma de decir las cosas deja curiosidad y eso siempre me parece mucho mas interesante que una charla vacia.`
  ].map(normalizarSugerenciaPremium);
}

async function generarSugerencias(caso = {}) {
  const userPrompt = construirUserPrompt({
    textoPlano: caso.textoPlano,
    clientePlano: caso.clientePlano,
    contextoPlano: caso.contextoPlano,
    lecturaCliente: caso.lecturaCliente,
    lecturaOperador: caso.lecturaOperador,
    tonoCliente: caso.tonoCliente,
    contactoExterno: caso.contactoExterno,
    elementosClave: caso.elementosClave,
    intencionOperador: caso.intencionOperador,
    guiaIntencion: caso.guiaIntencion,
    permisosApertura: caso.permisosApertura,
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
    anclarEnUltimoMensajeCliente: caso.anclarEnUltimoMensajeCliente
  });

  const data = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(
          caso.permisosApertura,
          caso.elementosClave,
          false,
          caso.estadoConversacion,
          caso.operadorTraeTemaPropio
        )
      },
      {
        role: "user",
        content: userPrompt
      }
    ],
    temperature: caso.ghostwriterMode ? 0.7 : 0.62,
    maxTokens: 140,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const candidata = extraerPrimeraSugerenciaPremium(
    data?.choices?.[0]?.message?.content || ""
  );

  const sugerencias = filtrarSugerenciasFinales([candidata], caso);

  if (sugerencias.length) {
    return {
      sugerencias: [sugerencias[0]],
      usageData: data
    };
  }

  const fallback = filtrarSugerenciasFinales(
    construirFallbackSugerencias({
      texto: caso.textoPlano,
      cliente: caso.clientePlano,
      estadoConversacion: caso.estadoConversacion,
      perfilEstructurado: caso.perfilEstructurado
    }),
    caso
  );

  if (fallback.length) {
    return {
      sugerencias: [fallback[0]],
      usageData: data
    };
  }

  return {
    sugerencias: [
      "No queria dejarte algo frio ni comun, asi que preferi escribirte mejor. Me dio curiosidad saber que detalle, gusto o forma de ver las cosas es la que mas te representa cuando de verdad estas en tu mejor energia."
    ],
    usageData: data
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
  puntuarLongitudPremium
};
