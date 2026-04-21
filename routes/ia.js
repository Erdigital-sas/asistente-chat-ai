// routes/ia.js
const express = require("express");

const {
  runtimeStats,
  inflightSuggestionJobs,
  inflightTranslationJobs
} = require("../state");

const { autorizarOperador } = require("../services/operators");
const { registrarConsumoAsync } = require("../services/core");

const {
  getSharedInFlight,
  runSuggestionQueueByOperator
} = require("../services/openai");

const {
  getTranslationCacheKey,
  leerTraduccionCache,
  guardarTraduccionCache,
  traducirTexto
} = require("../services/translation");

const {
  prepararCasoSugerencias,
  filtrarSugerenciasFinales,
  generarSugerencias,
  construirFallbackSugerencias
} = require("../services/suggestions");

function limpiarListaSugerencias(items = []) {
  const seen = new Set();
  const salida = [];

  for (const item of Array.isArray(items) ? items : []) {
    const limpio = String(item || "")
      .replace(/[“”"]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const key = limpio.toLowerCase();
    if (!limpio || seen.has(key)) continue;

    seen.add(key);
    salida.push(limpio);
  }

  return salida;
}

function extraerUbicacionCaso(caso = {}) {
  return String(
    caso?.ubicacionVisiblePerfil ||
    caso?.perfilEstructurado?.ubicacionClienta ||
    ""
  ).trim();
}

function extraerInteresCaso(caso = {}) {
  return String(
    caso?.plan?.chosen_interest ||
    caso?.perfilEstructurado?.interesesEnComun?.[0] ||
    caso?.perfilEstructurado?.interesesClienta?.[0] ||
    ""
  ).trim();
}

function textoPreguntaPorUbicacion(texto = "") {
  return /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i.test(
    String(texto || "").toLowerCase()
  );
}

function textoPreguntaPorInteres(texto = "") {
  return /\b(te gusta|you like|cual equipo|which team|what team|futbol|football|deporte|sport|viajar|travel|dancing|bailar|shopping|compras|music|musica|arte|arts|gardening|jardineria|cooking|cocinar|nature|naturaleza)\b/i.test(
    String(texto || "").toLowerCase()
  );
}

function textoPreguntaPorBusqueda(texto = "") {
  return /\b(que buscas|what are you looking for|que tipo de relacion buscas|que clase de relacion buscas)\b/i.test(
    String(texto || "").toLowerCase()
  );
}

function textoPreguntaPorActividad(texto = "") {
  return /\b(que haces|que haces ahora|what are you doing|que tal tu dia|como va tu dia)\b/i.test(
    String(texto || "").toLowerCase()
  );
}

function construirUltimoRecurso(caso = {}) {
  const texto = String(caso?.textoPlano || "");
  const ubicacion = extraerUbicacionCaso(caso);
  const interes = extraerInteresCaso(caso);
  const tipoTrabajo = String(caso?.tipoTrabajo || "rewrite_operator_draft");
  const tipoContacto = String(caso?.tipoContacto || "nuevo_total");
  const hayRespuestaReal = Boolean(caso?.estadoConversacion?.hayConversacionReal);

  if (tipoTrabajo === "simple_profile_fastpath") {
    if (textoPreguntaPorUbicacion(texto) && ubicacion) {
      return [
        `Vi que eres de ${ubicacion}. Que es lo que mas te gusta de vivir ahi?`
      ];
    }

    if (textoPreguntaPorInteres(texto) && interes) {
      return [
        `Vi que te gusta ${String(interes).toLowerCase()}. Lo sigues por gusto general o hay algo puntual que te engancha mas?`
      ];
    }

    if (textoPreguntaPorBusqueda(texto)) {
      return [
        "Te hago una simple: aqui buscas algo tranquilo para hablar o algo mas serio?"
      ];
    }

    if (textoPreguntaPorActividad(texto)) {
      return [
        "Te hago una simple: que andas haciendo a esta hora?"
      ];
    }

    return [
      "Te hago una simple: que tipo de charla suele engancharte mas cuando alguien te escribe?"
    ];
  }

  if (tipoTrabajo === "reply_last_client_message" || hayRespuestaReal) {
    return [
      "Lo que comentas tiene mas fondo de lo que parece. Siempre lo ves asi o fue algo muy de ese momento?"
    ];
  }

  if (tipoContacto === "viejo_sin_respuesta") {
    if (ubicacion) {
      return [
        `Vi que eres de ${ubicacion}. Ese detalle me dio curiosidad. Que es lo mejor de estar ahi?`
      ];
    }

    if (interes) {
      return [
        `Vi que te gusta ${String(interes).toLowerCase()}. Me dio curiosidad saber que es lo que mas te engancha de eso.`
      ];
    }

    return [
      "Te escribo algo simple: que es lo primero que suele llamarte la atencion cuando alguien te escribe de verdad?"
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
    "Hay un detalle aqui que me dejo curiosidad. Que dirias que es lo primero que suele llamar la atencion de ti?"
  ];
}

function resolverSugerenciasFinales(resultado = {}, caso = {}) {
  const sugerenciasServicio = limpiarListaSugerencias(
    Array.isArray(resultado?.sugerencias) ? resultado.sugerencias : []
  );

  let sugerencias = filtrarSugerenciasFinales(sugerenciasServicio, caso);

  if (!sugerencias.length && sugerenciasServicio.length) {
    sugerencias = sugerenciasServicio;
  }

  if (!sugerencias.length) {
    const fallbackBruto = construirFallbackSugerencias(caso);
    const fallbackServicio = limpiarListaSugerencias(
      Array.isArray(fallbackBruto) ? fallbackBruto : [fallbackBruto]
    );

    const fallbackFiltrado = filtrarSugerenciasFinales(
      fallbackServicio,
      caso
    );

    sugerencias = fallbackFiltrado.length
      ? fallbackFiltrado
      : fallbackServicio;
  }

  if (!sugerencias.length) {
    sugerencias = construirUltimoRecurso(caso);
  }

  return limpiarListaSugerencias(sugerencias).slice(0, 3);
}

const router = express.Router();

router.post("/sugerencias", autorizarOperador, async (req, res) => {
  const startedAt = Date.now();
  const operador = req.operadorAutorizado;
  runtimeStats.suggestions.total += 1;

  try {
    const {
      texto = "",
      contexto = "",
      cliente = "",
      perfil = "",
      extension_id = ""
    } = req.body || {};

    if (!texto || texto.trim().length < 2) {
      return res.json({
        ok: false,
        sugerencias: [],
        error: "Texto muy corto"
      });
    }

    const caso = prepararCasoSugerencias({
      operador,
      texto,
      contexto,
      cliente,
      perfil
    });

    const sharedJob = getSharedInFlight(
      inflightSuggestionJobs,
      caso.fingerprint,
      async () => {
        return runSuggestionQueueByOperator(operador, async () => {
          return generarSugerencias(caso);
        });
      }
    );

    if (sharedJob.shared) {
      runtimeStats.suggestions.inflightHits += 1;
    }

    const resultado = await sharedJob.promise;
    const sugerencias = resolverSugerenciasFinales(resultado, caso);

    registrarConsumoAsync({
      operador,
      extension_id,
      data: sharedJob.shared ? null : (resultado?.usageData || null),
      tipo: sharedJob.shared ? "IA_SHARED" : "IA",
      mensaje_operador: texto,
      request_ok: true
    });

    runtimeStats.suggestions.ok += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      sugerencias
    });
  } catch (err) {
    console.error("Error en /sugerencias:", err.message);

    registrarConsumoAsync({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "IA",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    runtimeStats.suggestions.error += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: false,
      sugerencias: [],
      error: err.message || "Error interno"
    });
  }
});

router.post("/traducir", autorizarOperador, async (req, res) => {
  const startedAt = Date.now();
  const operador = req.operadorAutorizado;
  runtimeStats.translations.total += 1;

  try {
    const { texto = "", extension_id = "" } = req.body || {};
    const textoFinal = String(texto || "");

    if (!textoFinal.trim()) {
      return res.json({
        ok: false,
        error: "Texto vacio"
      });
    }

    const cacheKey = getTranslationCacheKey(textoFinal);
    const cached = leerTraduccionCache(cacheKey);

    if (cached) {
      runtimeStats.translations.cacheHits += 1;
      runtimeStats.translations.ok += 1;
      runtimeStats.translations.lastMs = Date.now() - startedAt;

      registrarConsumoAsync({
        operador,
        extension_id,
        data: null,
        tipo: "TRAD_CACHE",
        mensaje_operador: textoFinal,
        request_ok: true
      });

      return res.json({
        ok: true,
        traducido: cached
      });
    }

    const sharedJob = getSharedInFlight(
      inflightTranslationJobs,
      cacheKey,
      async () => traducirTexto(textoFinal)
    );

    if (sharedJob.shared) {
      runtimeStats.translations.inflightHits += 1;
    }

    const resultado = await sharedJob.promise;
    const traducido = resultado?.traducido || "";

    if (!traducido) {
      throw new Error("No se pudo traducir");
    }

    guardarTraduccionCache(cacheKey, traducido);

    registrarConsumoAsync({
      operador,
      extension_id,
      data: sharedJob.shared ? null : resultado.usageData,
      tipo: sharedJob.shared ? "TRAD_SHARED" : "TRAD",
      mensaje_operador: textoFinal,
      request_ok: true
    });

    runtimeStats.translations.ok += 1;
    runtimeStats.translations.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      traducido
    });
  } catch (err) {
    console.error("Error en /traducir:", err.message);

    registrarConsumoAsync({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "TRAD",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    runtimeStats.translations.error += 1;
    runtimeStats.translations.lastMs = Date.now() - startedAt;

    return res.json({
      ok: false,
      error: err.message || "Error interno"
    });
  }
});

module.exports = router;
