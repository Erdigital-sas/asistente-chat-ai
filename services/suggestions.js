// services/suggestions.js
const {
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_TIMEOUT_SUGGESTIONS_MS
} = require("../config");

const {
  compactarBloque,
  limpiarSalidaHumana,
  normalizarTexto,
  dedupeStrings
} = require("../lib/utils");

const {
  META_MISFIRE_RESPONSE_REGEX,
  limpiarTextoIA,
  construirReporteLongitudes,
  esRespuestaBasura,
  contieneTemaEncuentro,
  violaReglasApertura,
  violaPropiedadHechosCliente,
  violaReglaContinuidad,
  necesitaSegundoIntento,
  elegirMejorSet,
  construirFallbackSugerencias,
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
  const textoPlano = compactarBloque(texto, 820);
  const clientePlano = compactarBloque(cliente, 520);
  const contextoPlano = compactarBloque(
    limitarContexto(contextoFiltrado),
    1200
  );
  const perfilPlano = compactarBloque(
    limitarContexto(perfil),
    680
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

  const lecturaOperador = [
    construirLecturaOperador(analisisOperador),
    !estadoConversacion.hayConversacionReal
      ? "No hay respuesta real de la clienta. No hables de retomar ni de seguir conversando. Convierte el texto en un enganche directo."
      : "",
    anclarEnUltimoMensajeCliente
      ? "Hay mensajes recientes de la clienta y el operador no trae un tema nuevo claro. Prioriza lo ultimo que ella dijo antes de abrir otro tema."
      : ""
  ].filter(Boolean).join(" ");

  const hechosClienteSensibles = detectarHechosClienteSensibles(lineasClienteRecientes);
  const mencionesGeograficasOperador = extraerMencionesGeograficasOperador(texto);

  const fingerprint = [
    normalizarTexto(operador).slice(0, 80),
    normalizarTexto(textoPlano).slice(0, 500),
    normalizarTexto(clientePlano).slice(0, 300),
    normalizarTexto(contextoPlano).slice(-700),
    normalizarTexto(perfilPlano).slice(0, 350)
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

function filtrarSugerenciasFinales(sugerencias = [], caso = {}) {
  return (Array.isArray(sugerencias) ? sugerencias : []).filter(
    (s) =>
      !contieneTemaEncuentro(s) &&
      !violaReglasApertura(s, caso.permisosApertura) &&
      !violaPropiedadHechosCliente(s, caso.hechosClienteSensibles, caso.textoPlano) &&
      !violaReglaContinuidad(s, caso.estadoConversacion, caso.operadorTraeTemaPropio)
  );
}

async function generarSugerencias(caso = {}) {
  const userPrompt = construirUserPrompt({
    textoPlano: caso.textoPlano,
    clientePlano: caso.clientePlano,
    contextoPlano: caso.contextoPlano,
    perfilPlano: caso.perfilPlano,
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

  const data1 = await llamarOpenAI({
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
    temperature: caso.ghostwriterMode ? 0.66 : 0.54,
    maxTokens: caso.ghostwriterMode ? 460 : 360,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const sugerencias1Raw = limpiarTextoIA(
    data1?.choices?.[0]?.message?.content || ""
  )
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  const sugerencias1 = filtrarSugerenciasFinales(sugerencias1Raw, caso);

  const huboEncuentros1 = sugerencias1Raw.some((s) => contieneTemaEncuentro(s));
  const huboAperturaInvalida1 = sugerencias1Raw.some((s) => violaReglasApertura(s, caso.permisosApertura));
  const huboMetaMisfire1 = sugerencias1Raw.some((s) => META_MISFIRE_RESPONSE_REGEX.test(normalizarTexto(s)));
  const huboPropiedadHechos1 = sugerencias1Raw.some((s) => violaPropiedadHechosCliente(s, caso.hechosClienteSensibles, caso.textoPlano));

  if (!necesitaSegundoIntento(
    sugerencias1,
    caso.textoPlano,
    caso.elementosClave,
    caso.permisosApertura,
    caso.estadoConversacion,
    caso.operadorTraeTemaPropio
  )) {
    return {
      sugerencias: sugerencias1.slice(0, 3),
      usageData: data1
    };
  }

  const reporteLongitudes1 = construirReporteLongitudes(sugerencias1);

  const correccionEncuentro = huboEncuentros1
    ? "Se detectaron alusiones prohibidas a verse en persona, cena, cafe, salida o plan presencial. Corrigelo por completo."
    : "No incluyas ninguna alusion a verse en persona ni a planes presenciales.";

  const correccionApertura = huboAperturaInvalida1
    ? "Se detectaron saludos o frases de primer contacto no autorizadas. No abras con hola ni metas frases para conocerla si el operador no lo escribio."
    : "No inventes saludos ni frases de primer contacto si no vienen en el borrador del operador.";

  const correccionMeta = huboMetaMisfire1 || caso.metaEdicion
    ? "Se detecto una respuesta meta equivocada o el borrador parece una autoevaluacion del operador. No respondas a esa autoevaluacion. Convierte esa intencion en un mensaje final real para la clienta."
    : "No respondas al operador como si el borrador fuera una consulta para la herramienta.";

  const correccionPropiedad = huboPropiedadHechos1
    ? "Se detecto apropiacion de hechos de la clienta. No conviertas hechos de CLIENTA en primera persona del operador."
    : "Respeta la propiedad de los hechos por rol.";

  const correccionGhostwriter = caso.ghostwriterMode
    ? "El borrador venia flojo, corto, generico o con reclamo. Debes elevarlo mucho mas y usar mejor el perfil y el contexto para que parezca un mensaje atractivo real."
    : "Manten el mensaje fuerte, natural y util.";

  const correccionContinuidad =
    !caso.estadoConversacion?.hayConversacionReal
      ? "No hay respuesta real de la clienta. No puedes hablar de seguir conversando, retomar, continuar ni volver a hablar."
      : caso.anclarEnUltimoMensajeCliente
        ? "Hay mensajes recientes de la clienta y el operador no trae tema nuevo claro. Debes apoyarte primero en lo ultimo que ella dijo y evitar continuidad generica."
        : "Evita continuidad generica si puedes responder algo concreto.";

  const correccionPerfil = caso.perfilEstructurado.interesesEnComun.length
    ? "Si usas intereses, primero usa INTERESES_EN_COMUN."
    : "Si usas intereses, solo puedes usar INTERESES_CLIENTA como apoyo sin fingir que estan en comun.";

  const correccionGeo = caso.mencionesGeograficasOperador.length
    ? "Si aparece una ubicacion, solo puedes corregir la ortografia del mismo lugar mencionado por el operador. No cambies a otra ciudad."
    : "No inventes ciudad, estado o pais.";

  const userPrompt2 = `
${userPrompt}

CORRECCION OBLIGATORIA
El intento anterior no cumplio bien calidad o longitud.

Reporte del intento anterior:
${reporteLongitudes1}

${correccionEncuentro}
${correccionApertura}
${correccionMeta}
${correccionPropiedad}
${correccionGhostwriter}
${correccionContinuidad}
${correccionPerfil}
${correccionGeo}

Corrige esto ahora:
- opcion 1 entre 200 y 260 caracteres
- opcion 2 entre 200 y 260 caracteres
- opcion 3 entre 320 y 420 caracteres
- mas precision
- mas naturalidad
- mas utilidad real para el operador
- cero relleno
- respeta por completo nombres, afectivos e intencion
- respeta quien dijo cada hecho
- no respondas como si la clienta hubiera dicho otra cosa
- no respondas al operador como si el borrador fuera una consulta a la herramienta
- si el borrador venia flojo, subele mucho el nivel
- usa mejor el perfil visible si aporta
- prioriza intereses en comun
- evita continuidad trillada
- no inventes geografia
- no cambies un lugar por otro
- no propongas vernos, salir, cenar, tomar algo ni ningun plan presencial
- no inventes saludos
- no inventes primer contacto
`.trim();

  const data2 = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      {
        role: "system",
        content: construirSystemPrompt(
          caso.permisosApertura,
          caso.elementosClave,
          true,
          caso.estadoConversacion,
          caso.operadorTraeTemaPropio
        )
      },
      {
        role: "user",
        content: userPrompt2
      }
    ],
    temperature: caso.ghostwriterMode ? 0.72 : 0.60,
    maxTokens: caso.ghostwriterMode ? 520 : 420,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const sugerencias2Raw = limpiarTextoIA(
    data2?.choices?.[0]?.message?.content || ""
  )
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  const sugerencias2 = filtrarSugerenciasFinales(sugerencias2Raw, caso);

  return {
    sugerencias: elegirMejorSet(
      sugerencias1,
      sugerencias2,
      caso.textoPlano,
      caso.elementosClave,
      caso.permisosApertura,
      caso.estadoConversacion,
      caso.operadorTraeTemaPropio
    ).slice(0, 3),
    usageData: sumarUsage(data1, data2)
  };
}

module.exports = {
  sumarUsage,
  prepararCasoSugerencias,
  filtrarSugerenciasFinales,
  generarSugerencias,
  construirFallbackSugerencias
};