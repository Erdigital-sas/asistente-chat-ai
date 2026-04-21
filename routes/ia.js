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
  const interes =
    caso?.perfilEstructurado?.interesesEnComun?.[0] ||
    caso?.perfilEstructurado?.interesesClienta?.[0] ||
    "";

  if (caso?.estadoConversacion?.hayConversacionReal) {
    return [
      "Lo que dijiste cambia bastante el tono de la charla, y por eso preferi seguir justo por ahi en vez de responder con algo vacio. A veces un detalle bien dicho vale mas que una frase armada, y contigo me dejo curiosidad real."
    ];
  }

  if (interes) {
    return [
      `Vi que ${String(interes).toLowerCase()} aparece en tu perfil y me parecio mejor entrar por ahi que por una frase comun. Cuando alguien tiene un gusto asi de claro, casi siempre dice bastante mas de lo que parece al principio.`
    ];
  }

  return [
    "Vi un detalle aqui que da mas para una charla con sustancia que para una entrada comun. Cuando alguien deja algo asi, casi siempre hay mas fondo del que parece, y eso fue justo lo que me dio curiosidad seguir."
  ];
}

const router = express.Router();

router.post("/sugerencias", autorizarOperador, async (req, res) => {
  console.log("====== DEBUG REQUEST ======");
console.log({
  texto: req.body?.texto,
  cliente: req.body?.cliente,
  contexto: req.body?.contexto,
  perfil: req.body?.perfil
});
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

  console.log("====== DEBUG CASO ======");
  console.log({
    textoPlano: caso.textoPlano,
    clientePlano: caso.clientePlano,
    estadoConversacion: caso.estadoConversacion,
    lineasClienteRecientes: caso.lineasClienteRecientes,
    anclar: caso.anclarEnUltimoMensajeCliente,
    mode: caso.mode,
    anchor: caso.anchor,
    objetivoLongitud: caso.objetivoLongitud,
    ubicacionPerfil: caso.ubicacionVisiblePerfil
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

    const sugerenciasServicio = limpiarListaSugerencias(
      Array.isArray(resultado?.sugerencias) ? resultado.sugerencias : []
    );

    // 1) Primero intenta usar lo que ya devolvio el servicio
    let sugerencias = filtrarSugerenciasFinales(sugerenciasServicio, caso);

    // 2) Si el re-filtrado mata todo, confia en la salida del servicio
    if (!sugerencias.length && sugerenciasServicio.length) {
      sugerencias = sugerenciasServicio;
    }

    // 3) Si de verdad no vino nada util, prueba fallback del servicio
    if (!sugerencias.length) {
      const fallbackServicio = limpiarListaSugerencias(
        construirFallbackSugerencias(caso)
      );

      const fallbackFiltrado = filtrarSugerenciasFinales(
        fallbackServicio,
        caso
      );

      sugerencias = fallbackFiltrado.length
        ? fallbackFiltrado
        : fallbackServicio;
    }

    // 4) Ultimo recurso humano, pero nunca el mensaje robotico anterior
    if (!sugerencias.length) {
      sugerencias = construirUltimoRecurso(caso);
    }

    registrarConsumoAsync({
      operador,
      extension_id,
      data: sharedJob.shared ? null : resultado?.usageData || null,
      tipo: sharedJob.shared ? "IA_SHARED" : "IA",
      mensaje_operador: texto,
      request_ok: true
    });

    runtimeStats.suggestions.ok += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      sugerencias: limpiarListaSugerencias(sugerencias).slice(0, 3)
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
