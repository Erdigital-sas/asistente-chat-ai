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
    let sugerencias = filtrarSugerenciasFinales(
      Array.isArray(resultado?.sugerencias) ? resultado.sugerencias : [],
      caso
    );

    if (!sugerencias.length) {
      sugerencias = filtrarSugerenciasFinales(
        construirFallbackSugerencias({
          texto: caso.textoPlano,
          cliente: caso.clientePlano,
          estadoConversacion: caso.estadoConversacion,
          perfilEstructurado: caso.perfilEstructurado
        }),
        caso
      );
    }

    if (!sugerencias.length) {
      sugerencias = caso.estadoConversacion.hayConversacionReal
        ? ["Queria responderte mejor y con un poco mas de intencion."]
        : ["Queria escribirte algo mejor y menos generico."];
    }

    registrarConsumoAsync({
      operador,
      extension_id,
      data: sharedJob.shared ? null : resultado.usageData,
      tipo: sharedJob.shared ? "IA_SHARED" : "IA",
      mensaje_operador: texto,
      request_ok: true
    });

    runtimeStats.suggestions.ok += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      sugerencias: sugerencias.slice(0, 3)
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

    if (!texto || !texto.trim()) {
      return res.json({
        ok: false,
        error: "Texto vacio"
      });
    }

    const cacheKey = getTranslationCacheKey(texto);
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
        mensaje_operador: texto,
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
      async () => traducirTexto(texto)
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
      mensaje_operador: texto,
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