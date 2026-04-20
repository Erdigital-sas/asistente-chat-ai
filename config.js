// config.js
const { createClient } = require("@supabase/supabase-js");
const { leerEnteroEnv, leerDecimalEnv, normalizarTexto } = require("./lib/utils");

const API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPERATOR_SHARED_KEY = process.env.OPERATOR_SHARED_KEY || "2026";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN_SECRET =
  process.env.ADMIN_TOKEN_SECRET || SUPABASE_KEY || OPERATOR_SHARED_KEY;

const PORT = process.env.PORT || 3000;

const OPENAI_URL =
  process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions";

const OPENAI_MODEL_SUGGESTIONS =
  process.env.OPENAI_MODEL_SUGGESTIONS ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const OPENAI_MODEL_TRANSLATE =
  process.env.OPENAI_MODEL_TRANSLATE ||
  process.env.OPENAI_MODEL_FAST ||
  "gpt-4o-mini";

const MAX_CONTEXT_LINES = leerEnteroEnv("MAX_CONTEXT_LINES", 7, 4, 15);
const MIN_RESPONSE_LENGTH = leerEnteroEnv("MIN_RESPONSE_LENGTH", 24, 8, 120);

const OPENAI_TIMEOUT_SUGGESTIONS_MS = leerEnteroEnv(
  "OPENAI_TIMEOUT_SUGGESTIONS_MS",
  17000,
  8000,
  45000
);

const OPENAI_TIMEOUT_TRANSLATE_MS = leerEnteroEnv(
  "OPENAI_TIMEOUT_TRANSLATE_MS",
  10000,
  4000,
  25000
);

const SUGGESTION_OPENAI_CONCURRENCY = leerEnteroEnv(
  "SUGGESTION_OPENAI_CONCURRENCY",
  6,
  1,
  20
);

const TRANSLATION_OPENAI_CONCURRENCY = leerEnteroEnv(
  "TRANSLATION_OPENAI_CONCURRENCY",
  2,
  1,
  10
);

const SUGGESTION_OPENAI_QUEUE_LIMIT = leerEnteroEnv(
  "SUGGESTION_OPENAI_QUEUE_LIMIT",
  60,
  1,
  300
);

const TRANSLATION_OPENAI_QUEUE_LIMIT = leerEnteroEnv(
  "TRANSLATION_OPENAI_QUEUE_LIMIT",
  30,
  1,
  200
);

const SUGGESTION_OPENAI_QUEUE_WAIT_MS = leerEnteroEnv(
  "SUGGESTION_OPENAI_QUEUE_WAIT_MS",
  12000,
  1000,
  30000
);

const TRANSLATION_OPENAI_QUEUE_WAIT_MS = leerEnteroEnv(
  "TRANSLATION_OPENAI_QUEUE_WAIT_MS",
  6000,
  1000,
  20000
);

const PER_OPERATOR_SUGGESTION_QUEUE_LIMIT = leerEnteroEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_LIMIT",
  3,
  1,
  10
);

const PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS = leerEnteroEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS",
  12000,
  1000,
  30000
);

const OPERATOR_CACHE_TTL_MS = leerEnteroEnv(
  "OPERATOR_CACHE_TTL_MS",
  5 * 60 * 1000,
  30000,
  60 * 60 * 1000
);

const TRANSLATION_CACHE_TTL_MS = leerEnteroEnv(
  "TRANSLATION_CACHE_TTL_MS",
  15 * 60 * 1000,
  60000,
  2 * 60 * 60 * 1000
);

const TRANSLATION_CACHE_LIMIT = leerEnteroEnv(
  "TRANSLATION_CACHE_LIMIT",
  500,
  50,
  5000
);

const ADMIN_TOKEN_TTL_HOURS = leerEnteroEnv(
  "ADMIN_TOKEN_TTL_HOURS",
  12,
  1,
  168
);

const ADMIN_LOGIN_WINDOW_MS = leerEnteroEnv(
  "ADMIN_LOGIN_WINDOW_MS",
  15 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000
);

const ADMIN_LOGIN_MAX_ATTEMPTS = leerEnteroEnv(
  "ADMIN_LOGIN_MAX_ATTEMPTS",
  8,
  3,
  50
);

const DEFAULT_MODEL_PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 }
};

const TARGET_SUGGESTION_SPECS = [
  { min: 200, max: 260, ideal: 230 },
  { min: 200, max: 260, ideal: 230 },
  { min: 320, max: 420, ideal: 370 }
];

function obtenerPricingDefaultPorModelo(model = "") {
  const key = normalizarTexto(model);
  return DEFAULT_MODEL_PRICING[key] || { input: 0, output: 0 };
}

const PRICING_SUGGESTION = obtenerPricingDefaultPorModelo(OPENAI_MODEL_SUGGESTIONS);
const PRICING_TRANSLATE = obtenerPricingDefaultPorModelo(OPENAI_MODEL_TRANSLATE);

const SUGGESTION_INPUT_COST_PER_1M = leerDecimalEnv(
  "SUGGESTION_INPUT_COST_PER_1M",
  PRICING_SUGGESTION.input,
  0,
  100000
);

const SUGGESTION_OUTPUT_COST_PER_1M = leerDecimalEnv(
  "SUGGESTION_OUTPUT_COST_PER_1M",
  PRICING_SUGGESTION.output,
  0,
  100000
);

const TRANSLATE_INPUT_COST_PER_1M = leerDecimalEnv(
  "TRANSLATE_INPUT_COST_PER_1M",
  PRICING_TRANSLATE.input,
  0,
  100000
);

const TRANSLATE_OUTPUT_COST_PER_1M = leerDecimalEnv(
  "TRANSLATE_OUTPUT_COST_PER_1M",
  PRICING_TRANSLATE.output,
  0,
  100000
);

if (!API_KEY) {
  console.error("Falta OPENAI_API_KEY en Railway");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_KEY en Railway");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

module.exports = {
  API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  OPERATOR_SHARED_KEY,
  ADMIN_USER,
  ADMIN_PASSWORD,
  ADMIN_TOKEN_SECRET,
  PORT,
  OPENAI_URL,
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_MODEL_TRANSLATE,
  MAX_CONTEXT_LINES,
  MIN_RESPONSE_LENGTH,
  OPENAI_TIMEOUT_SUGGESTIONS_MS,
  OPENAI_TIMEOUT_TRANSLATE_MS,
  SUGGESTION_OPENAI_CONCURRENCY,
  TRANSLATION_OPENAI_CONCURRENCY,
  SUGGESTION_OPENAI_QUEUE_LIMIT,
  TRANSLATION_OPENAI_QUEUE_LIMIT,
  SUGGESTION_OPENAI_QUEUE_WAIT_MS,
  TRANSLATION_OPENAI_QUEUE_WAIT_MS,
  PER_OPERATOR_SUGGESTION_QUEUE_LIMIT,
  PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS,
  OPERATOR_CACHE_TTL_MS,
  TRANSLATION_CACHE_TTL_MS,
  TRANSLATION_CACHE_LIMIT,
  ADMIN_TOKEN_TTL_HOURS,
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_LOGIN_MAX_ATTEMPTS,
  TARGET_SUGGESTION_SPECS,
  SUGGESTION_INPUT_COST_PER_1M,
  SUGGESTION_OUTPUT_COST_PER_1M,
  TRANSLATE_INPUT_COST_PER_1M,
  TRANSLATE_OUTPUT_COST_PER_1M,
  supabase
};