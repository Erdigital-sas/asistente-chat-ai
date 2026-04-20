// services/core.js
const path = require("path");

const {
  supabase,
  ADMIN_USER,
  ADMIN_PASSWORD,
  ADMIN_TOKEN_SECRET,
  ADMIN_TOKEN_TTL_HOURS,
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_MODEL_TRANSLATE,
  SUGGESTION_INPUT_COST_PER_1M,
  SUGGESTION_OUTPUT_COST_PER_1M,
  TRANSLATE_INPUT_COST_PER_1M,
  TRANSLATE_OUTPUT_COST_PER_1M,
  SUGGESTION_OPENAI_CONCURRENCY,
  TRANSLATION_OPENAI_CONCURRENCY,
  PER_OPERATOR_SUGGESTION_QUEUE_LIMIT
} = require("../config");

const { runtimeStats } = require("../state");

const {
  normalizarEspacios,
  normalizarTexto
} = require("../lib/utils");

const {
  suggestionsOpenAILimiter,
  translationOpenAILimiter,
  countOperatorSuggestionsRunning,
  countOperatorSuggestionsQueued
} = require("./openai");

function adminEstaConfigurado() {
  return Boolean(ADMIN_USER && ADMIN_PASSWORD && ADMIN_TOKEN_SECRET);
}

async function registrarConsumo({
  operador,
  extension_id = "",
  data = null,
  tipo = "",
  mensaje_operador = "",
  request_ok = true
}) {
  try {
    const usage = data?.usage || {};

    const payload = {
      operador: operador || "anon",
      extension_id: normalizarEspacios(extension_id) || "sin_extension",
      tipo,
      tokens: usage.total_tokens || 0,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      mensaje_operador: String(mensaje_operador ?? ""),
      mensaje_normalizado: normalizarTexto(mensaje_operador || ""),
      request_ok
    };

    const { error } = await supabase.from("consumo").insert([payload]);

    if (error) {
      console.error("Error guardando consumo:", error.message);
    }
  } catch (err) {
    console.error("Error guardando consumo:", err.message);
  }
}

function registrarConsumoAsync(payload) {
  setImmediate(async () => {
    try {
      await registrarConsumo(payload);
    } catch (err) {
      console.error("Error guardando consumo async:", err.message);
    }
  });
}

function getHealthPayload() {
  return {
    ok: true,
    service: "server pro",
    uptime_seconds: Math.floor((Date.now() - runtimeStats.startedAt) / 1000),
    admin: {
      configured: adminEstaConfigurado(),
      token_ttl_hours: ADMIN_TOKEN_TTL_HOURS
    },
    pricing: {
      suggestions_model: OPENAI_MODEL_SUGGESTIONS,
      translate_model: OPENAI_MODEL_TRANSLATE,
      suggestion_input_cost_per_1m: SUGGESTION_INPUT_COST_PER_1M,
      suggestion_output_cost_per_1m: SUGGESTION_OUTPUT_COST_PER_1M,
      translate_input_cost_per_1m: TRANSLATE_INPUT_COST_PER_1M,
      translate_output_cost_per_1m: TRANSLATE_OUTPUT_COST_PER_1M
    },
    models: {
      sugerencias: OPENAI_MODEL_SUGGESTIONS,
      traduccion: OPENAI_MODEL_TRANSLATE
    },
    queues: {
      operator_suggestions: {
        running: countOperatorSuggestionsRunning(),
        waiting: countOperatorSuggestionsQueued(),
        operators: require("../state").operatorSuggestionQueues.size,
        max_waiting_per_operator: PER_OPERATOR_SUGGESTION_QUEUE_LIMIT
      },
      openai_suggestions: {
        active: suggestionsOpenAILimiter.activeCount,
        waiting: suggestionsOpenAILimiter.queuedCount,
        max_concurrent: SUGGESTION_OPENAI_CONCURRENCY
      },
      openai_translate: {
        active: translationOpenAILimiter.activeCount,
        waiting: translationOpenAILimiter.queuedCount,
        max_concurrent: TRANSLATION_OPENAI_CONCURRENCY
      }
    },
    stats: runtimeStats
  };
}

function getAdminHtmlPath() {
  return path.join(__dirname, "..", "admin.html");
}

function getAdminJsPath() {
  return path.join(__dirname, "..", "admin.js");
}

module.exports = {
  adminEstaConfigurado,
  registrarConsumo,
  registrarConsumoAsync,
  getHealthPayload,
  getAdminHtmlPath,
  getAdminJsPath
};