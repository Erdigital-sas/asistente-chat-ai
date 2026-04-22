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

function construirUltimoRecurso(caso = {}) {
  if (caso.tipoContacto === "nuevo_total") {
    return [
      "Hola. Prefiero empezar con algo simple y real: ¿qué tipo de conversación sí te dan ganas de seguir cuando alguien te escribe por aquí?",
      "Hola. Antes que dejarte una frase vacía, voy con algo más claro: ¿qué suele hacer que una charla te parezca interesante desde el inicio?",
      "Hola. Te escribo algo sencillo y real: ¿eres más de conversaciones tranquilas o de gente que entra con más chispa desde el principio?"
    ];
  }

  if (caso.tipoContacto === "viejo_sin_respuesta") {
    return [
      "Hola. Paso por aquí con algo más claro que un saludo sin más: ¿qué suele hacer que una conversación te resulte distinta desde el principio?",
      "Hola. En vez de repetir lo típico, prefiero preguntarte algo concreto: ¿qué es lo primero que te hace quedarte en una charla por aquí?",
      "Hola. Reaparezco con una pregunta simple y real: ¿eres de las que conectan más por la vibra o por lo que alguien sabe decir?"
    ];
  }

  return [
    "Quiero seguir esto por una línea más natural. ¿Qué parte de lo que dijiste es la que más pesa para ti?",
    "Lo que comentas tiene más fondo de lo que parece. ¿Te sale pensar así desde hace tiempo o te pasó algo que te llevó a verlo así?",
    "Tiene sentido lo que planteas. ¿Lo dices más por intuición o porque ya te tocó vivir algo parecido?"
  ];
}

function resolverSugerenciasFinales(resultado = {}, caso = {}) {
  const sugerenciasServicio = limpiarListaSugerencias(
    Array.isArray(resultado?.sugerencias) ? resultado.sugerencias : []
  );

  const filtradas = filtrarSugerenciasFinales(sugerenciasServicio, caso);
  if (filtradas.length) {
    return filtradas.slice(0, 3);
  }

  const fallbackCrudo = construirFallbackSugerencias(caso);
  const fallbackServicio = limpiarListaSugerencias(
    Array.isArray(fallbackCrudo) ? fallbackCrudo : [fallbackCrudo]
  );

  const fallbackFiltrado = filtrarSugerenciasFinales(fallbackServicio, caso);
  if (fallbackFiltrado.length) {
    return fallbackFiltrado.slice(0, 3);
  }

  return limpiarListaSugerencias(construirUltimoRecurso(caso)).slice(0, 3);
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
      extension_id = "",
      chat_signals = {}
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
      perfil,
      chatSignals: chat_signals
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
