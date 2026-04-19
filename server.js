const express = require("express");
const cors = require("cors");
const path = require("path");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai"); // Añadido SDK de Gemini

function leerEnteroEnv(nombre, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[nombre];
  const n = Number.parseInt(raw, 10);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function leerDecimalEnv(nombre, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[nombre];
  const n = Number.parseFloat(raw);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function crearRequestId() {
  try {
    return randomUUID();
  } catch (_err) {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const app = express();
app.disable("x-powered-by");
app.use(cors());

const runtimeStats = {
  startedAt: Date.now(),
  http: {
    total: 0,
    ok: 0,
    error: 0,
    lastMs: 0
  },
  suggestions: {
    total: 0,
    ok: 0,
    error: 0,
    inflightHits: 0,
    secondPasses: 0, 
    lastMs: 0
  },
  translations: {
    total: 0,
    ok: 0,
    error: 0,
    cacheHits: 0,
    inflightHits: 0,
    lastMs: 0
  },
  warnings: {
    total: 0,
    ok: 0,
    error: 0,
    rowsUpserted: 0,
    lastMs: 0
  },
  openai: { 
    total: 0,
    ok: 0,
    error: 0,
    suggestionCalls: 0,
    translationCalls: 0,
    lastMs: 0
  },
  admin: {
    loginTotal: 0,
    loginOk: 0,
    loginError: 0,
    operatorList: 0,
    operatorCreate: 0,
    operatorUpdate: 0,
    operatorDelete: 0,
    dashboardLoads: 0
  }
};
app.use((req, res, next) => {
  const startedAt = Date.now();

  req.requestId = crearRequestId();
  res.setHeader("X-Request-Id", req.requestId);
  res.setHeader("Cache-Control", "no-store");

  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    runtimeStats.http.total += 1;
    runtimeStats.http.lastMs = ms;

    if (res.statusCode >= 400) runtimeStats.http.error += 1;
    else runtimeStats.http.ok += 1;
  });

  next();
});
app.use(express.json({ limit: "1mb" }));

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: "JSON invalido"
    });
  }

  return next(err);
});
// ==========================
// VARIABLES DESDE RAILWAY
// ==========================
const API_KEY = process.env.GEMINI_API_KEY; 
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPERATOR_SHARED_KEY = process.env.OPERATOR_SHARED_KEY || "2026";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN_SECRET =
  process.env.ADMIN_TOKEN_SECRET || SUPABASE_KEY || OPERATOR_SHARED_KEY;

const PORT = process.env.PORT || 3000;

// Inicialización de cliente Gemini
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

const OPENAI_MODEL_SUGGESTIONS =
  process.env.GEMINI_MODEL_SUGGESTIONS || "gemini-2.5-flash";
const OPENAI_MODEL_TRANSLATE =
  process.env.GEMINI_MODEL_TRANSLATE || "gemini-2.5-flash-lite";

// ==========================
// CONFIG
// ==========================
const MAX_CONTEXT_LINES = leerEnteroEnv("MAX_CONTEXT_LINES", 8, 4, 15);
const MIN_RESPONSE_LENGTH = leerEnteroEnv("MIN_RESPONSE_LENGTH", 24, 8, 120);

const OPENAI_TIMEOUT_SUGGESTIONS_MS = leerEnteroEnv(
  "OPENAI_TIMEOUT_SUGGESTIONS_MS",
  22000,
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

// Precios de seguridad
const PRICING_SUGGESTION = { input: 0.15, output: 0.60 };
const PRICING_TRANSLATE = { input: 0.075, output: 0.30 };

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
// ==========================
// VALIDACION INICIAL
// ==========================
if (!API_KEY) {
  console.error("Falta GEMINI_API_KEY en Railway");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_KEY en Railway");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// ==========================
// CACHES Y ESTADO EN MEMORIA
// ==========================
const operatorAuthCache = new Map();
const translationCache = new Map();
const inflightTranslationJobs = new Map();
const inflightSuggestionJobs = new Map();
const adminLoginAttempts = new Map();
const operatorSuggestionQueues = new Map();

// ==========================
// LIMITERS
// ==========================
class ConcurrencyLimiter {
  constructor({ name, maxConcurrent, maxQueue, waitTimeoutMs }) {
    this.name = name;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.waitTimeoutMs = waitTimeoutMs;
    this.active = 0;
    this.queue = [];
  }

  get activeCount() {
    return this.active;
  }

  get queuedCount() {
    return this.queue.length;
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const job = {
        started: false,
        timeoutId: null,
        execute: null
      };

      const execute = () => {
        job.started = true;

        if (job.timeoutId) {
          clearTimeout(job.timeoutId);
          job.timeoutId = null;
        }

        this.active += 1;

        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active = Math.max(0, this.active - 1);
            this.drain();
          });
      };

      job.execute = execute;

      if (this.active < this.maxConcurrent) {
        execute();
        return;
      }

      if (this.queue.length >= this.maxQueue) {
        reject(new Error(`Servidor ocupado. Cola ${this.name} llena`));
        return;
      }

      if (this.waitTimeoutMs > 0) {
        job.timeoutId = setTimeout(() => {
          if (job.started) return;

          const idx = this.queue.indexOf(job);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }

          reject(new Error(`Servidor ocupado. Tiempo de espera agotado en ${this.name}`));
        }, this.waitTimeoutMs);
      }

      this.queue.push(job);
    });
  }

  drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      job.execute();
    }
  }
}

const suggestionsOpenAILimiter = new ConcurrencyLimiter({
  name: "openai_sugerencias",
  maxConcurrent: SUGGESTION_OPENAI_CONCURRENCY,
  maxQueue: SUGGESTION_OPENAI_QUEUE_LIMIT,
  waitTimeoutMs: SUGGESTION_OPENAI_QUEUE_WAIT_MS
});
const translationOpenAILimiter = new ConcurrencyLimiter({
  name: "openai_traduccion",
  maxConcurrent: TRANSLATION_OPENAI_CONCURRENCY,
  maxQueue: TRANSLATION_OPENAI_QUEUE_LIMIT,
  waitTimeoutMs: TRANSLATION_OPENAI_QUEUE_WAIT_MS
});
function countOperatorSuggestionsRunning() {
  let total = 0;

  for (const state of operatorSuggestionQueues.values()) {
    if (state.running) total += 1;
  }

  return total;
}

function countOperatorSuggestionsQueued() {
  let total = 0;
  for (const state of operatorSuggestionQueues.values()) {
    total += state.queue.length;
  }

  return total;
}

function getOrCreateOperatorQueueState(operadorKey) {
  if (!operatorSuggestionQueues.has(operadorKey)) {
    operatorSuggestionQueues.set(operadorKey, {
      running: false,
      queue: [],
      lastUsedAt: Date.now()
    });
  }

  return operatorSuggestionQueues.get(operadorKey);
}

function cleanupOperatorSuggestionQueue(operadorKey, state) {
  if (!state.running && state.queue.length === 0) {
    operatorSuggestionQueues.delete(operadorKey);
  }
}

function drainOperatorSuggestionQueue(operadorKey, state) {
  if (state.running) return;

  const nextJob = state.queue.shift();

  if (!nextJob) {
    cleanupOperatorSuggestionQueue(operadorKey, state);
    return;
  }

  nextJob.execute();
}

function runSuggestionQueueByOperator(operador = "", task) {
  const operadorKey = normalizarTexto(operador || "anon");
  const state = getOrCreateOperatorQueueState(operadorKey);

  return new Promise((resolve, reject) => {
    const job = {
      started: false,
      timeoutId: null,
      execute: null
    };

    const execute = () => {
      job.started = true;
      state.running = true;
      state.lastUsedAt = Date.now();

      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
        job.timeoutId = null;
      }

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.running = false;
          state.lastUsedAt = Date.now();
          drainOperatorSuggestionQueue(operadorKey, state);
        });
    };

    job.execute = execute;

    if (!state.running) {
      execute();
      return;
    }

    if (state.queue.length >= PER_OPERATOR_SUGGESTION_QUEUE_LIMIT) {
      reject(new Error("Este operador ya tiene demasiadas solicitudes de IA en curso"));
      return;
    }

    if (PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS > 0) {
      job.timeoutId = setTimeout(() => {
        if (job.started) return;
        const idx = state.queue.indexOf(job);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
        }

        cleanupOperatorSuggestionQueue(operadorKey, state);
        reject(new Error("La cola de IA de este operador esta llena o lenta"));
      }, PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS);
    }

    state.queue.push(job);
  });
}

function getSharedInFlight(map, key, factory) {
  if (map.has(key)) {
    return {
      shared: true,
      promise: map.get(key)
    };
  }

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (map.get(key) === promise) {
        map.delete(key);
      }
    });
  map.set(key, promise);

  return {
    shared: false,
    promise
  };
}

// ==========================
// UTILIDADES
// ==========================
function quitarTildes(texto = "") {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizarTexto(texto = "") {
  return quitarTildes(String(texto ?? ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarEspacios(texto = "") {
  return String(texto ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatearNombreOperador(nombre = "") {
  return normalizarEspacios(nombre)
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
    .join(" ");
}

function limpiarSalidaHumana(texto = "") {
  return quitarTildes(String(texto ?? ""))
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limitarContexto(ctx = "") {
  return String(ctx ?? "")
    .split("\n")
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(-MAX_CONTEXT_LINES)
    .join("\n");
}

function compactarBloque(texto = "", maxChars = 1200) {
  const limpio = String(texto ?? "").trim();
  if (!limpio) return "";

  if (limpio.length <= maxChars) return limpio;

  return limpio.slice(-maxChars);
}

function limpiarLinea(texto = "") {
  return limpiarSalidaHumana(
    String(texto ?? "")
      .replace(/^\s*\d+[\).\-\s:]*/, "")
      .replace(/^\s*[•\-–—]+\s*/, "")
  );
}

function extraerBloquesIA(texto = "") {
  const raw = String(texto ?? "")
    .replace(/\r/g, "")
    .trim();

  if (!raw) return [];

  const bloques = [];
  const regex = /(?:^|\n)\s*\d+\s*[\).\-\:]*\s*([\s\S]*?)(?=(?:\n\s*\d+\s*[\).\-\:]*\s)|$)/g;

  let match;
  while ((match = regex.exec(raw))) {
    const bloque = normalizarEspacios(String(match[1] || "").replace(/\n+/g, " "));
    if (bloque) bloques.push(bloque);
  }

  if (bloques.length) return bloques;

  return raw
    .split(/\n+/)
    .map((linea) => normalizarEspacios(linea))
    .filter(Boolean);
}

function limpiarTextoIA(texto = "") {
  const vistos = new Set();
  return extraerBloquesIA(texto)
    .map(limpiarLinea)
    .filter((t) => t.length >= MIN_RESPONSE_LENGTH)
    .filter((t) => {
      const clave = normalizarTexto(t);
      if (!clave || vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
}

function contarCaracteres(texto = "") {
  return normalizarEspacios(String(texto ?? "")).length;
}

function contarPreguntas(texto = "") {
  const t = String(texto ?? "");
  const abiertas = (t.match(/¿/g) || []).length;
  const cerradas = (t.match(/\?/g) || []).length;
  return abiertas + cerradas;
}

function obtenerSpecSugerencia(index = 0) {
  const TARGET_SUGGESTION_SPECS = [
    { min: 200, max: 260, ideal: 230 },
    { min: 200, max: 260, ideal: 230 },
    { min: 320, max: 420, ideal: 370 }
  ];
  return TARGET_SUGGESTION_SPECS[index] || TARGET_SUGGESTION_SPECS[0];
}

function esRespuestaBasura(texto = "") {
  const t = normalizarTexto(texto);
  return (
    t.length < MIN_RESPONSE_LENGTH ||
    /^(ok|okay|yes|no|hola|hi|vale|bien|jaja|haha|hmm|mm|fine|nice|cool)[.!?]*$/.test(t)
  );
}

function crearFingerprintSugerencia({
  operador = "",
  textoPlano = "",
  clientePlano = "",
  contextoPlano = "",
  perfilPlano = ""
}) {
  return [
    normalizarTexto(operador).slice(0, 80),
    normalizarTexto(textoPlano).slice(0, 500),
    normalizarTexto(clientePlano).slice(0, 300),
    normalizarTexto(contextoPlano).slice(-600),
    normalizarTexto(perfilPlano).slice(0, 200)
  ].join("||");
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function redondearDinero(n = 0) {
  return Number(safeNumber(n, 0).toFixed(6));
}

function formatearFechaISO(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function primerDiaMesUTC(date = new Date()) {
  return formatearFechaISO(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function esFechaISOValida(texto = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(texto || ""));
}

function sumarDiasISO(fechaISO = "", dias = 0) {
  const d = new Date(`${fechaISO}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + dias);
  return formatearFechaISO(d);
}

function compararFechasISO(a = "", b = "") {
  return String(a).localeCompare(String(b));
}

function construirRangoFechas(fromRaw = "", toRaw = "") {
  const hoy = formatearFechaISO(new Date());
  let from = esFechaISOValida(fromRaw) ? fromRaw : primerDiaMesUTC(new Date());
  let to = esFechaISOValida(toRaw) ? toRaw : hoy;
  if (compararFechasISO(from, to) > 0) {
    const temp = from;
    from = to;
    to = temp;
  }

  return {
    from,
    to,
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${sumarDiasISO(to, 1)}T00:00:00.000Z`
  };
}

function base64UrlEncode(input = "") {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input), "utf8");

  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input = "") {
  const normalized = String(input)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0
    ? ""
    : "=".repeat(4 - (normalized.length % 4));

  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function compararSeguro(a = "", b = "") {
  const aa = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (aa.length !== bb.length) return false;

  try {
    return timingSafeEqual(aa, bb);
  } catch (_err) {
    return false;
  }
}

function obtenerCostosPorTipo(tipo = "") {
  const t = String(tipo || "").toUpperCase();
  if (t.startsWith("IA")) {
    return {
      input: SUGGESTION_INPUT_COST_PER_1M,
      output: SUGGESTION_OUTPUT_COST_PER_1M,
      lane: "IA"
    };
  }

  if (t.startsWith("TRAD")) {
    return {
      input: TRANSLATE_INPUT_COST_PER_1M,
      output: TRANSLATE_OUTPUT_COST_PER_1M,
      lane: "TRAD"
    };
  }

  return {
    input: 0,
    output: 0,
    lane: "OTRO"
  };
}

function calcularCostoEstimado({
  tipo = "",
  prompt_tokens = 0,
  completion_tokens = 0
}) {
  const costos = obtenerCostosPorTipo(tipo);
  const inputCost = (safeNumber(prompt_tokens) / 1_000_000) * costos.input;
  const outputCost = (safeNumber(completion_tokens) / 1_000_000) * costos.output;

  return redondearDinero(inputCost + outputCost);
}

async function seleccionarTodasLasPaginas(builderFactory, pageSize = 1000) {
  let from = 0;
  const rows = [];
  while (true) {
    const { data, error } = await builderFactory(from, from + pageSize - 1);
    if (error) {
      throw error;
    }

    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);

    if (chunk.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return rows;
}

// ==========================
// BLOQUEO DE ENCUENTROS
// ==========================
const PATRONES_ENCUENTRO = [
  /\b(vernos|nos vemos|verme|verte|verse|vernos algun dia|conocernos en persona|en persona|cara a cara)\b/i,
  /\b(meet|meet up|see each other|see you in person|in person|face to face|date)\b/i,
  /\b(cenar|cena|ir a cenar|dinner|almorzar juntos|almuerzo juntos|lunch together|desayunar juntos|breakfast together)\b/i,
  /\b(tomar un cafe|ir por un cafe|cafe juntos|coffee together|grab coffee|coffee date)\b/i,
  /\b(tomar algo|tomar unos tragos|tragos juntos|drinks together|grab a drink|have a drink)\b/i,
  /\b(salgamos|salir contigo|go out sometime|go out together|ir al cine|movie together|caminar juntos|walk together)\b/i,
  /\b(venir a mi casa|ven a mi casa|ir a tu casa|voy a tu casa|my place|your place|come over|visitarte|visitarnos|visit you)\b/i,
  /\b(paso por ti|te recojo|pick you up|send me your address|dame tu direccion|mandame tu ubicacion)\b/i,
  /\b(fin de semana juntos|weekend together|viaje juntos|trip together)\b/i
];
function contieneTemaEncuentro(texto = "") {
  const original = String(texto ?? "");
  const limpio = quitarTildes(original);

  return PATRONES_ENCUENTRO.some((regex) => regex.test(limpio));
}

// ==========================
// META DEL OPERADOR
// ==========================
const META_EDICION_REGEX =
  /\b(no fui lo suficientemente interesante|no fui suficiente|no fue suficiente|mi mensaje|el mensaje|otro mensaje|mensaje mas interesante|mensaje mejor|captar tu atencion|capturar tu atencion|sonar mas interesante|quiero decirle|como le digo|ayudame a decir|mejorame esto|reescribe esto|hazlo mas atractivo|hazlo mejor|no fui tan interesante|no fui lo bastante interesante)\b/i;
function detectarMetaEdicionOperador(texto = "") {
  const t = normalizarTexto(texto);
  if (!t) return false;
  return META_EDICION_REGEX.test(t);
}

// ==========================
// CONTEXTO RELEVANTE
// ==========================
const STOPWORDS_RELEVANCIA = new Set([
  "hola", "amor", "mi", "mio", "tu", "tuyo", "que", "como", "estas", "esta",
  "para", "pero", "porque", "por", "con", "sin", "una", "uno", "unos",
  "unas", "este", "esta", "estos", "estas", "muy", "mas", "menos", "del",
  "las", "los", "mis", "tus", "sus", "aqui", "alla", "eso", "esto", "esa",
  "ese", "soy", "eres", "fue", "fui", "ser", "tener", "tengo", "tiene",
  "solo", "bien", "vale", "gracias", "ahora", "luego", "despues", "later",
  "today", "hoy", "clienta", "operador"
]);
function tokenizarRelevancia(texto = "") {
  return [
    ...new Set(
      normalizarTexto(texto)
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS_RELEVANCIA.has(w))
    )
  ];
}

function extraerLineasContexto(contexto = "") {
  return String(contexto ?? "")
    .split("\n")
    .map((l) => limpiarSalidaHumana(l))
    .map((l) => normalizarEspacios(l))
    .filter(Boolean)
    .filter((l) => /^CLIENTA:|^OPERADOR:/i.test(l));
}

function filtrarContextoRelevante(contexto = "", texto = "", cliente = "") {
  const lineas = extraerLineasContexto(contexto);
  if (!lineas.length) return "";
  const ultimas = lineas.slice(-4);
  const tokensObjetivo = new Set([
    ...tokenizarRelevancia(texto),
    ...tokenizarRelevancia(cliente)
  ]);
  if (!tokensObjetivo.size) {
    return [...new Set(ultimas)].slice(-MAX_CONTEXT_LINES).join("\n");
  }

  const scored = lineas.map((linea) => {
    const tokens = tokenizarRelevancia(linea);
    const score = tokens.reduce(
      (acc, token) => acc + (tokensObjetivo.has(token) ? 1 : 0),
      0
    );

    return { linea, score };
  });
  const relevantes = scored
    .filter((x) => x.score > 0)
    .map((x) => x.linea);
  const combinadas = [...relevantes, ...ultimas];
  const unicas = [...new Set(combinadas)];

  return unicas.slice(-MAX_CONTEXT_LINES).join("\n");
}

// ==========================
// CONSERVACION DE NOMBRES Y TONO
// ==========================
const TERMINOS_AFECTIVOS = [
  "mi amor",
  "amor",
  "baby",
  "babe",
  "bebe",
  "querida",
  "querido",
  "corazon",
  "mi vida",
  "mi reina",
  "princesa"
];
const SALUDOS_APERTURA_REGEX =
  /^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\b/i;

const FRASES_PRIMER_CONTACTO_OPERADOR_REGEX =
  /\b(conocer mas de ti|conocerte mejor|me gustaria conocerte|quisiera conocerte|quiero conocerte|saber mas de ti|me gustaria saber de ti|conocer un poco mas de ti|hablar contigo por primera vez|charlar contigo por primera vez|romper el hielo|icebreaker|primer contacto)\b/i;
const FRASES_PRIMER_CONTACTO_SUGERENCIA_REGEX =
  /\b(conocerte|conocer mas de ti|saber mas de ti|me gustaria saber de ti|me gustaria conocerte|quisiera conocerte|quiero conocerte|conocer un poco mas de ti|romper el hielo|icebreaker|primer contacto|por primera vez)\b/i;
function extraerNombreEnApertura(texto = "") {
  const limpio = normalizarEspacios(String(texto ?? ""));
  const match = limpio.match(
    /^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\s+([a-zA-ZñÑáéíóúÁÉÍÓÚ]+)/i
  );

  if (!match) return "";
  const posible = limpiarSalidaHumana(match[2] || "");
  if (!posible) return "";

  const norm = normalizarTexto(posible);
  if (TERMINOS_AFECTIVOS.includes(norm)) return "";

  return norm;
}

function extraerAfectivosPresentes(texto = "") {
  const norm = normalizarTexto(texto);
  return TERMINOS_AFECTIVOS.filter((term) => norm.includes(term));
}

function detectarPermisosApertura({
  texto = "",
  cliente = "",
  contexto = ""
}) {
  const operadorNorm = normalizarTexto(texto);
  const clienteNorm = normalizarTexto(cliente);
  const lineasCtx = extraerLineasContexto(contexto);

  const saludoExplicito = SALUDOS_APERTURA_REGEX.test(operadorNorm);
  const primerContactoExplicito = FRASES_PRIMER_CONTACTO_OPERADOR_REGEX.test(operadorNorm);
  const hayHistorial =
    Boolean(clienteNorm) ||
    lineasCtx.length > 0;

  const pareceChatViejo =
    hayHistorial ||
    /(no me respondes|no respondes|sigues ahi|sigues por aqui|te perdi|apareciste|desapareciste|otra vez|de nuevo|retomando|seguimos|ya habiamos hablado)/.test(operadorNorm);
  
  return {
    saludoExplicito,
    primerContactoExplicito,
    hayHistorial,
    pareceChatViejo
  };
}

function violaReglasApertura(
  sugerencia = "",
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  }
) {
  const sugNorm = normalizarTexto(sugerencia);
  if (!sugNorm) return false;

  if (!permisosApertura.saludoExplicito && SALUDOS_APERTURA_REGEX.test(sugNorm)) {
    return true;
  }

  if (
    !permisosApertura.primerContactoExplicito &&
    FRASES_PRIMER_CONTACTO_SUGERENCIA_REGEX.test(sugNorm)
  ) {
    return true;
  }

  if (
    (permisosApertura.pareceChatViejo || permisosApertura.hayHistorial) &&
    !permisosApertura.primerContactoExplicito &&
    /\b(romper el hielo|primer contacto|por primera vez por aqui|conocer mas de ti|saber mas de ti)\b/.test(sugNorm)
  ) {
    return true;
  }

  return false;
}

function detectarElementosClave(texto = "") {
  const palabras = normalizarTexto(texto).split(/\s+/).filter(Boolean);
  return {
    nombreApertura: extraerNombreEnApertura(texto),
    afectivos: extraerAfectivosPresentes(texto),
    mensajeCorto: palabras.length <= 9 || normalizarTexto(texto).length < 55
  };
}

// ==========================
// CONTACTO EXTERNO Y LECTURA
// ==========================
function esSolicitudContacto(texto = "") {
  const t = normalizarTexto(texto);
  const patrones = [
    /\bwhatsapp\b/,
    /\btelegram\b/,
    /\bphone\b/,
    /\bnumber\b/,
    /\bnumero\b/,
    /\btelefono\b/,
    /\btel\b/,
    /\bcel\b/,
    /\bcelular\b/,
    /\bemail\b/,
    /\bmail\b/,
    /\bcorreo\b/,
    /\binstagram\b/,
    /\big\b/,
    /\bsnap\b/,
    /\bsnapchat\b/,
    /\bfacebook\b/,
    /\bcontact\b/,
    /\bwa\b/,
    /\bws\b/,
    /\bhangouts\b/,
    /\bwechat\b/,
    /\bline\b/,
    /\bkik\b/,
    /\bskype\b/,
    /\bdiscord\b/,
    /\bexterno\b/,
    /\boutside\b/,
    /\btext me\b/,
    /\bcall me\b/,
    /\bwrite me\b/,
    /\bmy number\b/,
    /\btu numero\b/,
    /\bpasame tu\b/,
    /\bdame tu\b/,
    /\bte dejo mi\b/,
    /\bhablamos por\b/,
    /\bhabla por\b/,
    /\bcontactame\b/,
    /\badd me\b/,
    /\b\d{6,}\b/
  ];
  return patrones.some((patron) => patron.test(t));
}

function analizarCliente(texto = "") {
  const original = String(texto ?? "");
  const t = normalizarTexto(original);
  const pregunta =
    /[?¿]/.test(original) ||
    /\b(que|como|cuando|donde|por que|porque|quien|cual|cuanto|cuanta|what|how|when|where|why|which)\b/.test(t);
  const rechazo =
    /(no me interesa|dejame|deja de escribir|stop|leave me alone|bye|goodbye|adios|no gracias|no thanks|not interested|no quiero|no deseo)/.test(t);
  const molesta =
    /(raro|weird|too much|vas muy rapido|muy rapido|calma|tranquilo|relajate|que intenso|intenso|insistente)/.test(t);
  const ocupada =
    /(busy|work|working|trabaj|ocupad|luego|despues|later|after|ahora no|not now|cant talk|cannot talk|mas tarde)/.test(t);
  const afectiva =
    /(love|miss|baby|amor|carino|mi vida|te extrano|me gustas|me encantas|beso|besitos|corazon|mi amor)/.test(t);

  const coqueta =
    /(handsome|cute|sweet|kiss|hug|guapo|lindo|bonito|hermoso|rico|bb|bebe|linda)/.test(t);
  const fria =
    t.length < 22 ||
    /^(ok|okay|yes|no|bien|vale|jaja|haha|hmm|mm|fine|nice|cool)\b/.test(t);

  const contacto = esSolicitudContacto(original);
  const encuentro = contieneTemaEncuentro(original);
  let tono = "neutral";
  if (rechazo) tono = "rechazo";
  else if (molesta) tono = "molesta";
  else if (ocupada) tono = "ocupada";
  else if (afectiva) tono = "afectiva";
  else if (coqueta) tono = "coqueta";
  else if (fria) tono = "fria";

  return {
    pregunta,
    rechazo,
    molesta,
    ocupada,
    afectiva,
    coqueta,
    fria,
    contacto,
    encuentro,
    tono
  };
}

function construirLecturaCliente(analisis) {
  const reglas = [];

  if (analisis.pregunta) {
    reglas.push("La clienta hizo una pregunta. Respondela primero.");
  }

  if (analisis.fria) {
    reglas.push("La clienta viene breve o fria. No alargues ni exageres emocion.");
  }

  if (analisis.ocupada) {
    reglas.push("La clienta parece ocupada. Ve corto y facil de responder.");
  }

  if (analisis.coqueta || analisis.afectiva) {
    reglas.push("La clienta muestra interes o coqueteo. Puedes sonar mas cercano.");
  }

  if (analisis.molesta || analisis.rechazo) {
    reglas.push("La clienta marca distancia. Baja intensidad y no insistas.");
  }

  if (analisis.contacto) {
    reglas.push("Pidio contacto externo. Mantiene la conversacion dentro de la app.");
  }

  if (analisis.encuentro) {
    reglas.push("Se menciono verse o hacer un plan presencial. No propongas encuentros ni salidas. Redirige la charla para seguir por aqui.");
  }

  if (!reglas.length) {
    reglas.push("Tono neutral. Responde natural y humano.");
  }

  return reglas.join(" ");
}

function analizarMensajeOperador(texto = "") {
  const original = String(texto ?? "");
  const t = normalizarTexto(original);
  const traePregunta =
    /[?¿]/.test(original) ||
    /\b(que|como|cuando|donde|por que|porque|quien|cual|cuanto|what|how|when|where|why)\b/.test(t);
  const preguntaGenerica =
    /\b(como estas|que haces|de donde eres|que tal|como te va|how are you|what are you doing|where are you from)\b/.test(t);
  const fraseQuemada =
    /\b(tenemos intereses en comun|tenemos cosas en comun|vi que tenemos intereses en comun|vi que te gusta|bonita sonrisa|linda sonrisa|me llamo la atencion tu perfil)\b/.test(t);
  const muyPlano =
    t.length < 30 ||
    /\b(hola|hi|hello|mucho gusto|encantado)\b/.test(t);
  const reclamo =
    /(no me has respondido|no me respondes|no me contestas|me has dejado|me dejaste|me ignoras|por que no)/.test(t);
  const mezclaDeIdeas =
    /[,.;:]/.test(original) && t.split(" ").length >= 12;
  const primerContacto =
    /(vi que|me llamo la atencion|tu perfil|intereses en comun|libro favorito|lectura|travel|music|cooking|conocer mas de ti)/.test(t);
  const encuentroPresencial = contieneTemaEncuentro(original);
  const metaEdicion = detectarMetaEdicionOperador(original);

  const palabras = t.split(/\s+/).filter(Boolean);
  return {
    traePregunta,
    preguntaGenerica,
    fraseQuemada,
    muyPlano,
    reclamo,
    mezclaDeIdeas,
    primerContacto,
    encuentroPresencial,
    mensajeCorto: palabras.length <= 9 || t.length < 55,
    metaEdicion
  };
}

function construirLecturaOperador(analisis) {
  const reglas = [];
  if (analisis.metaEdicion) {
    reglas.push("El borrador parece una autoevaluacion o instruccion implicita del operador. Debes convertirlo en un mensaje final para la clienta, no responderle a la herramienta.");
  }

  if (analisis.preguntaGenerica) {
    reglas.push("La pregunta del operador esta generica. Mejora el gancho.");
  }

  if (analisis.fraseQuemada) {
    reglas.push("Evita frases quemadas. Hazlo mas natural.");
  }

  if (analisis.muyPlano) {
    reglas.push("El borrador esta plano. Dale mas interes.");
  }

  if (analisis.reclamo) {
    reglas.push("Suaviza el reclamo y vuelve el mensaje mas atractivo.");
  }

  if (analisis.mezclaDeIdeas) {
    reglas.push("Ordena las ideas. El texto puede venir de dictado.");
  }

  if (analisis.primerContacto) {
    reglas.push("Si es primer contacto, DEBES usar el perfil visible de la clienta para crear un gancho 100% personalizado y unico.");
  }

  if (analisis.mensajeCorto) {
    reglas.push("Si el mensaje es corto, debes ampliarlo de forma util con una segunda idea natural.");
  }

  if (analisis.encuentroPresencial) {
    reglas.push("El borrador alude a verse en persona o a un plan presencial. Debes transformarlo para seguir la charla sin proponer encuentros.");
  }

  if (!analisis.traePregunta) {
    reglas.push("No fuerces pregunta si no hace falta.");
  }

  if (!reglas.length) {
    reglas.push("Mantener estilo natural y claro.");
  }

  return reglas.join(" ");
}

function detectarIntencionOperador(texto = "", cliente = "", contexto = "") {
  const t = normalizarTexto(texto);
  const hayHistorial =
    Boolean(normalizarTexto(cliente)) ||
    extraerLineasContexto(contexto).length > 0;
    
  if (
    /(no me respondes|no respondes|no me contestas|sigues ahi|sigues por aqui|te perdi|apareciste|desapareciste|pensando en ti|me acorde de ti|por que no)/.test(t)
  ) {
    return "reenganche";
  }

  if (
    /(descansa|te leo luego|cuando puedas|hablamos despues|seguimos luego|que tengas linda noche|que tengas buen dia)/.test(t)
  ) {
    return "cierre_suave";
  }

  if (
    /(amor|baby|babe|bb|guapa|linda|hermosa|cute|beautiful|kiss|beso|besitos|me gustas|me encantas)/.test(t)
  ) {
    return "coqueteo";
  }

  if (
    /(vi que|tu perfil|me llamo la atencion|intereses en comun|conocer mas de ti)/.test(t) &&
    !hayHistorial
  ) {
    return "enganche";
  }

  if (!hayHistorial && /^(hola|hey|hi)\b/.test(t)) {
    return "enganche";
  }

  return "conversacion";
}

function construirGuiaIntencion(intencion = "") {
  const mapa = {
    enganche: "Buscar una entrada atractiva y personalizada usando al 100% los datos de su perfil visible. Nada de frases genericas.",
    coqueteo: "Mantener un tono cercano y atractivo sin sonar intenso, necesitado ni artificial.",
    conversacion: "Responder y mover la charla con fluidez, naturalidad y continuidad.",
    reenganche: "Recuperar la conversacion asumiendo familiaridad total. PROHIBIDO decir 'quiero conocerte', 'saber de ti' o actuar como si fuera el primer contacto.",
    cierre_suave: "Cerrar o pausar con buena energia, dejando la puerta abierta para seguir despues."
  };

  return mapa[intencion] || mapa.conversacion;
}

// ==========================
// PROMPTS
// ==========================
function construirBloqueConservacion(elementosClave) {
  const partes = [];
  if (elementosClave.nombreApertura) {
    partes.push(
      `Si el borrador incluye un nombre propio, debes conservar exactamente ese nombre: ${elementosClave.nombreApertura}`
    );
  } else {
    partes.push(
      "Si el borrador no incluye un nombre propio, no inventes ninguno aunque aparezca en el perfil o contexto."
    );
  }

  if (elementosClave.afectivos.length) {
    partes.push(
      `Si el borrador incluye palabras afectivas, debes conservarlas exactamente: ${elementosClave.afectivos.join(", ")}`
    );
  }

  partes.push(
    "Nunca uses el nombre de otra clienta, de otro chat o del perfil si el operador no lo escribio."
  );
  partes.push(
    "No cambies el lado de la conversacion. Tu salida sigue siendo del operador para la clienta."
  );
  return partes.join("\n");
}

function construirBloqueAperturaControlada(permisosApertura) {
  const partes = [];

  if (permisosApertura.saludoExplicito) {
    partes.push("El operador si escribio un saludo explicito. Puedes conservarlo sin duplicarlo.");
  } else {
    partes.push("El operador NO escribio un saludo explicito. No abras con hola, hey, hi, buenas ni equivalente.");
  }

  if (permisosApertura.pareceChatViejo || permisosApertura.hayHistorial) {
    partes.push("⚠️ REGLA DE CHAT VIEJO (REENGANCHE):");
    partes.push("- Este chat ya tiene historial. Ya se conocen.");
    partes.push("- ESTA ESTRICTAMENTE PROHIBIDO usar frases como 'me encantaria conocerte', 'quiero saber mas de ti', 'hablar contigo' o actuar como si fuera la primera vez.");
    partes.push("- Enfocate en reenganchar la conversacion de forma natural, casual y asumiendo familiaridad.");
  } else {
    partes.push("🎯 REGLA DE CHAT NUEVO (ENGANCHE INICIAL):");
    partes.push("- Este es un primer contacto absoluto.");
    partes.push("- OBLIGATORIO: Debes utilizar obligatoriamente los datos del PERFIL VISIBLE de la clienta para armar el mensaje.");
    partes.push("- Toma un detalle especifico de su perfil (intereses, bio) y usalo como gancho para que el mensaje sea 100% personalizado y no suene a plantilla.");
  }

  return partes.join("\n");
}

function construirSystemPrompt(
  permisosApertura = {
    saludoExplicito: false,
    primerContactoExplicito: false,
    hayHistorial: false,
    pareceChatViejo: false
  },
  elementosClave = { nombreApertura: "", afectivos: [], mensajeCorto: false },
  segundoIntento = false // Gemini ignora este param, se mantiene para compabtilidad
) {
  return `
Eres un editor conversacional premium para operadores que escriben a una clienta dentro de una app de citas.
ROL
No hablas con la clienta como asistente
No explicas nada
No das consejos
Tu salida siempre es el mensaje final que el operador le enviara a la clienta

MISION
Convertir un borrador breve, plano o desordenado en un mensaje listo para enviar que conserve la intencion del operador y a la vez suene humano, agradable, seguro y natural

JERARQUIA DE PRIORIDADES
1. Mantener el rol correcto: operador hacia clienta
2. Responder o aprovechar el ultimo mensaje real de la clienta si existe
3. Conservar la intencion principal del borrador
4. Usar contexto y perfil solo para enriquecer de forma natural cuando ayuden de verdad
5. Nunca inventar hechos, nombres, recuerdos o confianza falsa

REGLA CENTRAL
El borrador del operador NO es un mensaje para ti
Es el mensaje final que la clienta va a leer
No conviertas una apertura del operador en una respuesta como si la clienta hubiera preguntado otra cosa

LECTURA DEL CHAT
Las lineas marcadas como CLIENTA son de ella
Las lineas marcadas como OPERADOR son mensajes previos del operador
No confundas esos roles

META DEL OPERADOR
A veces el operador escribe una autoevaluacion o una instruccion implicita de edicion.
Si el borrador habla de que no fue interesante, que el mensaje no fue suficiente, que quiere captar atencion, que quiere decirle algo mejor o similar, debes reinterpretarlo como intencion de edicion y convertirlo en un mensaje final natural para la clienta.
No respondas literalmente a ese comentario como si la clienta lo hubiera dicho ni como si el operador te estuviera hablando a ti.

CORRECCIÓN DE DICTADO POR VOZ (NUEVA REGLA)
El operador dicta sus mensajes usando un micrófono. Si el borrador contiene palabras sin sentido que suenan fonéticamente igual al nombre de la clienta (por ejemplo, escribir "ya como" o "ya como estas" cuando la clienta se llama "Giacomo", o "yuli" en lugar de "Julie"), asume inmediatamente que fue un error del software de voz. 
Tu trabajo es corregir silenciosamente ese error y escribir el nombre real de la clienta tal como aparece en su perfil o contexto.

CONSERVACION OBLIGATORIA
${construirBloqueConservacion(elementosClave)}

APERTURA CONTROLADA
${construirBloqueAperturaControlada(permisosApertura)}

CONVERSACION SOLO DENTRO DE LA APP
Nunca sugieras, insinues ni invites a:
- verse en persona
- conocerse fuera de la app
- salir, cita, cena, almuerzo, cafe, tragos o cualquier plan presencial
- visitarse, ir a casa de alguien, pasar por alguien, pedir direccion o ubicacion
- fin de semana juntos, viaje, hotel o planes fisicos
Si el borrador o la clienta mencionan eso, reconduce la conversacion para seguir por aqui de forma natural, sin rechazo brusco y sin cerrar la charla.

OBJETIVO DE CALIDAD
Cada opcion debe sentirse humana, natural, agradable, atractiva sin exagerar y lista para enviar

ESTRATEGIA DE CONSTRUCCION
Cada opcion debe incluir, sin sonar formula:
- una entrada natural que conecte con el borrador o con la clienta
- una idea atractiva o mini detalle que genere interes real
- un cierre que invite a seguir la conversacion con maximo una pregunta

CUANDO EL BORRADOR SEA CORTO
No te quedes corto
Apoyate en el ultimo mensaje de la clienta, luego en el contexto reciente y por ultimo en el perfil visible
Puedes extender con una segunda idea breve, un giro de curiosidad o una continuidad natural
No rellenes con frases vacias

LONGITUD OBLIGATORIA
Opcion 1: entre 200 y 260 caracteres
Opcion 2: entre 200 y 260 caracteres
Opcion 3: entre 320 y 420 caracteres

DIFERENCIACION OBLIGATORIA
Opcion 1 debe ser directa, agradable y facil de enviar
Opcion 2 debe ser mas atractiva, emocional o coqueta segun el caso, sin exagerar
Opcion 3 debe ser mas desarrollada, envolvente y con mas continuidad conversacional

NO HAGAS
No inventes nombres
No cambies nombres
No elimines palabras afectivas clave del borrador
No copies frases tipicas quemadas
No metas temas del perfil si no aportan
No suenes necesitado, intenso, robotico ni demasiado perfecto
No uses comillas, emojis, listas internas, etiquetas ni numeracion extra
No des opciones cortas, secas o telegraficas
No uses mas de una pregunta por opcion
Sin tildes ni acentos en la salida

CONTROL FINAL ANTES DE RESPONDER
Verifica que las 3 opciones:
- respeten el sentido principal del borrador
- sean claramente distintas entre si
- cumplan la longitud pedida
- no incluyan encuentros ni planes presenciales
- no inventen saludos ni primer contacto
- no respondan al operador como si fuera la herramienta
- esten listas para enviar

SALIDA
Devuelve exactamente 3 lineas numeradas como 1. 2. y 3.
Una sola opcion por linea
Nada mas
`.trim();
}

function construirUserPrompt({
  textoPlano,
  clientePlano,
  contextoPlano,
  perfilPlano,
  lecturaCliente,
  lecturaOperador,
  tonoCliente,
  contactoExterno,
  elementosClave,
  intencionOperador,
  guiaIntencion,
  permisosApertura,
  metaEdicion
}) {
  return `
CASO REAL

BORRADOR DEL OPERADOR
"""
${textoPlano}
"""

ULTIMO MENSAJE REAL DE LA CLIENTA
"""
${clientePlano || "Sin mensaje claro"}
"""

CONTEXTO RECIENTE DEL CHAT
"""
${contextoPlano || "Sin contexto claro"}
"""

PERFIL VISIBLE DE LA CLIENTA
"""
${perfilPlano || "Sin perfil claro"}
"""

LECTURA DE LA CLIENTA
${quitarTildes(lecturaCliente)}

LECTURA DEL BORRADOR DEL OPERADOR
${quitarTildes(lecturaOperador)}

TONO DETECTADO DE LA CLIENTA
${tonoCliente}

INTENCION DETECTADA DEL OPERADOR
${intencionOperador}

GUIA DE INTENCION
${quitarTildes(guiaIntencion)}

SOLICITUD DE CONTACTO EXTERNO
${contactoExterno ? "si" : "no"}

ELEMENTOS DEL BORRADOR QUE DEBES CONSERVAR
Nombre en apertura: ${elementosClave.nombreApertura || "ninguno"}
Terminos afectivos: ${elementosClave.afectivos.length ? elementosClave.afectivos.join(", ") : "ninguno"}
Mensaje corto: ${elementosClave.mensajeCorto ? "si" : "no"}
Meta edicion detectada: ${metaEdicion ? "si" : "no"}

CONTROL DE APERTURA
Saludo explicito en borrador: ${permisosApertura.saludoExplicito ? "si" : "no"}
Primer contacto explicito en borrador: ${permisosApertura.primerContactoExplicito ? "si" : "no"}
Chat con historial o reenganche: ${(permisosApertura.pareceChatViejo || permisosApertura.hayHistorial) ? "si" : "no"}

REGLA DURA DE APERTURA
Si el operador no escribio saludo, no abras con hola, hey, hi, buenas ni equivalente.
Si el chat es NUEVO (sin historial): OBLIGATORIO usar algun dato del perfil de la clienta para engancharla.
Si el chat es VIEJO (con historial): PROHIBIDO decir "quiero conocerte", "saber de ti" o reiniciar la presentacion. Ya se conocen, reengancha con familiaridad.

REGLA DURA DE META
Si el borrador parece una autoevaluacion o comentario sobre la calidad del mensaje, transformalo en un mensaje final para la clienta.
No respondas literalmente a ese comentario ni como si el operador te estuviera hablando a ti.

RESTRICCION ABSOLUTA
Nunca propongas vernos, salir, cenar, tomar algo, conocernos en persona, visitarnos ni ningun plan presencial.

OBJETIVO DE LAS 3 SALIDAS
1. 200 a 260 caracteres, directa y agradable
2. 200 a 260 caracteres, mas atractiva o emocional
3. 320 a 420 caracteres, mas desarrollada y envolvente

TAREA FINAL
Reescribe el borrador del operador en 3 versiones mejores
Conserva el sentido principal
Ayuda aunque el borrador sea corto
Usa el ultimo mensaje de la clienta como prioridad
Usa contexto o perfil solo si mejoran de verdad la respuesta
Mantente dentro de la app si hay solicitud de contacto externo
No sugieras encuentros presenciales
No inventes saludos
No inventes primer contacto
No contestes al operador como si el texto fuera una consulta para la herramienta
Escribe como si la clienta fuera a leer el mensaje final
`.trim();
}

// ==========================
// CACHE DE OPERADORES
// ==========================
function leerOperadorCache(nombreFormateado = "") {
  const key = normalizarTexto(nombreFormateado);
  const entry = operatorAuthCache.get(key);

  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    operatorAuthCache.delete(key);
    return "";
  }

  return entry.nombre || "";
}

function guardarOperadorCache(nombreFormateado = "", nombreReal = "") {
  const key = normalizarTexto(nombreFormateado);
  operatorAuthCache.set(key, {
    nombre: nombreReal,
    expiresAt: Date.now() + OPERATOR_CACHE_TTL_MS
  });
}

function borrarOperadorCache(nombre = "") {
  const key = normalizarTexto(formatearNombreOperador(nombre));
  if (!key) return;
  operatorAuthCache.delete(key);
}

// ==========================
// TRADUCCION CACHE
// ==========================
function getTranslationCacheKey(texto = "") {
  return normalizarTexto(texto).slice(0, 1200);
}

function leerTraduccionCache(cacheKey = "") {
  if (!cacheKey) return "";

  const entry = translationCache.get(cacheKey);
  if (!entry) return "";
  if (entry.expiresAt <= Date.now()) {
    translationCache.delete(cacheKey);
    return "";
  }

  translationCache.delete(cacheKey);
  translationCache.set(cacheKey, entry);

  return entry.value || "";
}

function guardarTraduccionCache(cacheKey = "", value = "") {
  if (!cacheKey || !value) return;
  if (translationCache.has(cacheKey)) {
    translationCache.delete(cacheKey);
  }

  translationCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS
  });
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
}

// ==========================
// ADMIN AUTH
// ==========================
function adminEstaConfigurado() {
  return Boolean(ADMIN_USER && ADMIN_PASSWORD && ADMIN_TOKEN_SECRET);
}

function firmarAdminToken(payloadB64 = "") {
  return base64UrlEncode(
    createHmac("sha256", ADMIN_TOKEN_SECRET).update(payloadB64).digest()
  );
}

function crearAdminToken(usuario = ADMIN_USER) {
  const now = Date.now();
  const payload = {
    sub: usuario || ADMIN_USER,
    role: "admin",
    iat: now,
    exp: now + (ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000),
    nonce: crearRequestId()
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = firmarAdminToken(payloadB64);

  return `${payloadB64}.${signature}`;
}

function verificarAdminToken(token = "") {
  const [payloadB64, signature] = String(token || "").split(".");
  if (!payloadB64 || !signature) {
    throw new Error("Token admin invalido");
  }

  const expected = firmarAdminToken(payloadB64);
  if (!compararSeguro(signature, expected)) {
    throw new Error("Token admin invalido");
  }

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (_err) {
    throw new Error("Token admin invalido");
  }

  if (!payload?.sub || payload?.role !== "admin") {
    throw new Error("Token admin invalido");
  }

  if (!payload?.exp || payload.exp < Date.now()) {
    throw new Error("Sesion admin expirada");
  }

  return payload;
}

function limpiarIntentosAdmin() {
  const ahora = Date.now();
  for (const [key, entry] of adminLoginAttempts.entries()) {
    const recientes = (entry?.timestamps || []).filter(
      (ts) => (ahora - ts) < ADMIN_LOGIN_WINDOW_MS
    );
    if (!recientes.length) {
      adminLoginAttempts.delete(key);
      continue;
    }

    adminLoginAttempts.set(key, { timestamps: recientes });
  }
}

function obtenerClaveRateAdmin(req, usuario = "") {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || "sin-ip";
  return `${ip}::${normalizarTexto(usuario || "admin")}`;
}

function adminLoginBloqueado(rateKey = "") {
  if (!rateKey) return false;

  limpiarIntentosAdmin();
  const entry = adminLoginAttempts.get(rateKey);
  if (!entry) return false;

  return (entry.timestamps || []).length >= ADMIN_LOGIN_MAX_ATTEMPTS;
}

function registrarIntentoAdmin(rateKey = "", ok = false) {
  if (!rateKey) return;

  if (ok) {
    adminLoginAttempts.delete(rateKey);
    return;
  }

  limpiarIntentosAdmin();

  const entry = adminLoginAttempts.get(rateKey) || { timestamps: [] };
  entry.timestamps.push(Date.now());

  adminLoginAttempts.set(rateKey, entry);
}

function obtenerAdminTokenDesdeRequest(req) {
  const auth = String(req.headers.authorization || "");

  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }

  return String(req.headers["x-admin-token"] || req.body?.token || req.query?.token || "");
}

function credencialesAdminValidas(usuario = "", password = "") {
  return (
    compararSeguro(normalizarTexto(usuario), normalizarTexto(ADMIN_USER)) &&
    compararSeguro(String(password || ""), String(ADMIN_PASSWORD || ""))
  );
}

function autorizarAdmin(req, res, next) {
  if (!adminEstaConfigurado()) {
    return res.status(503).json({
      ok: false,
      error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET en Railway"
    });
  }

  try {
    const token = obtenerAdminTokenDesdeRequest(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Sesion admin requerida"
      });
    }

    const payload = verificarAdminToken(token);
    req.adminAuth = payload;
    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: err.message || "Sesion admin invalida"
    });
  }
}

function validarNombreOperadorAdmin(nombre = "") {
  const nombreFinal = formatearNombreOperador(nombre);
  if (!nombreFinal) {
    throw new Error("Escribe un nombre valido");
  }

  if (nombreFinal.length < 3) {
    throw new Error("El nombre del operador es demasiado corto");
  }

  if (nombreFinal.length > 80) {
    throw new Error("El nombre del operador es demasiado largo");
  }

  return nombreFinal;
}

async function listarOperadoresAdmin() {
  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .order("nombre", { ascending: true });
  if (error) {
    throw new Error("No se pudo leer la lista de operadores");
  }

  return Array.isArray(data) ? data : [];
}

async function buscarOperadorPorNombreAdmin(nombre = "") {
  const nombreFinal = validarNombreOperadorAdmin(nombre);
  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .ilike("nombre", nombreFinal)
    .limit(10);
  if (error) {
    throw new Error("No se pudo buscar el operador");
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

function resumirOperadores(operators = []) {
  const total = operators.length;
  const activos = operators.filter((x) => Boolean(x.activo)).length;
  const inactivos = total - activos;
  return {
    total,
    activos,
    inactivos
  };
}

async function crearOReactivarOperadorAdmin(nombre = "") {
  const nombreFinal = validarNombreOperadorAdmin(nombre);
  const existente = await buscarOperadorPorNombreAdmin(nombreFinal);
  if (existente) {
    const necesitaUpdate = !existente.activo || existente.nombre !== nombreFinal;
    if (!necesitaUpdate) {
      return {
        action: "exists",
        operator: existente
      };
    }

    borrarOperadorCache(existente.nombre);

    const { data, error } = await supabase
      .from("operadores")
      .update({
        nombre: nombreFinal,
        activo: true
      })
      .eq("id", existente.id)
      .select("id, nombre, activo, created_at")
      .single();
    if (error || !data) {
      throw new Error("No se pudo actualizar el operador");
    }

    return {
      action: existente.activo ? "updated" : "reactivated",
      operator: data
    };
  }

  const { data, error } = await supabase
    .from("operadores")
    .insert([
      {
        nombre: nombreFinal,
        activo: true
      }
    ])
    .select("id, nombre, activo, created_at")
    .single();
  if (error || !data) {
    throw new Error(error?.message || "No se pudo crear el operador");
  }

  return {
    action: "created",
    operator: data
  };
}

function parsearNombresBulk(raw = "") {
  const nombres = String(raw ?? "")
    .split(/\r?\n|,/)
    .map((item) => formatearNombreOperador(item))
    .filter(Boolean);
  const vistos = new Set();
  const salida = [];

  for (const nombre of nombres) {
    const clave = normalizarTexto(nombre);
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(nombre);
  }

  return salida.slice(0, 300);
}

function parsearFiltroOperadores(raw = "") {
  const nombres = String(raw ?? "")
    .split(",")
    .map((item) => formatearNombreOperador(item))
    .filter(Boolean);
  return [...new Set(nombres)].slice(0, 100);
}

// ==========================
// OPERADORES
// ==========================
async function validarOperadorAcceso(operador = "", clave = "") {
  const operadorFormateado = formatearNombreOperador(operador);
  if (!operadorFormateado) {
    throw new Error("Operador vacio");
  }

  if (clave !== OPERATOR_SHARED_KEY) {
    throw new Error("Clave invalida");
  }

  const cacheHit = leerOperadorCache(operadorFormateado);
  if (cacheHit) {
    return cacheHit;
  }

  const { data, error } = await supabase
    .from("operadores")
    .select("nombre, activo")
    .ilike("nombre", operadorFormateado)
    .limit(10);
  if (error) {
    throw new Error("No se pudo validar el operador");
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row || !row.activo) {
    throw new Error("Operador no autorizado");
  }

  guardarOperadorCache(operadorFormateado, row.nombre);
  return row.nombre;
}

async function autorizarOperador(req, res, next) {
  try {
    const { operador = "", clave = "" } = req.body || {};
    const nombreValido = await validarOperadorAcceso(operador, clave);
    req.operadorAutorizado = nombreValido;
    return next();
  } catch (err) {
    return res.json({
      ok: false,
      error: err.message || "No autorizado"
    });
  }
}

// ==========================
// CONSUMO
// ==========================
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

// ==========================
// WARNINGS
// ==========================
function limpiarCountsWarning(counts = {}) {
  const limpio = {};
  const entries = Object.entries(counts || {}).slice(0, 100);
  for (const [fraseRaw, cantidadRaw] of entries) {
    const frase = normalizarEspacios(String(fraseRaw || "")).slice(0, 180);
    const cantidad = Math.max(0, Math.min(999999, Number.parseInt(cantidadRaw, 10) || 0));

    if (!frase || cantidad <= 0) continue;
    limpio[frase] = (limpio[frase] || 0) + cantidad;
  }

  return limpio;
}

async function guardarWarningResumen({
  operador = "",
  extension_id = "",
  fecha = "",
  counts = {}
}) {
  const operadorFinal = formatearNombreOperador(operador || "");
  const fechaFinal = esFechaISOValida(fecha) ? fecha : formatearFechaISO(new Date());
  const countsLimpios = limpiarCountsWarning(counts);
  if (!operadorFinal) {
    throw new Error("Operador invalido para warning");
  }

  const frases = Object.keys(countsLimpios);
  if (!frases.length) {
    return { rowsUpserted: 0 };
  }

  const { data: existentes, error: errorRead } = await supabase
    .from("warning_resumen_diario")
    .select("frase, cantidad_total")
    .eq("operador", operadorFinal)
    .eq("fecha", fechaFinal)
    .in("frase", frases);
  if (errorRead) {
    throw new Error("No se pudieron leer los warnings existentes");
  }

  const actuales = new Map();
  for (const row of existentes || []) {
    actuales.set(String(row.frase || ""), safeNumber(row.cantidad_total));
  }

  const payload = frases.map((frase) => ({
    operador: operadorFinal,
    extension_id: normalizarEspacios(extension_id) || "",
    fecha: fechaFinal,
    frase,
    cantidad_total: safeNumber(actuales.get(frase)) + safeNumber(countsLimpios[frase]),
    updated_at: new Date().toISOString()
  }));
  const { error } = await supabase
    .from("warning_resumen_diario")
    .upsert(payload, {
      onConflict: "operador,fecha,frase"
    });
  if (error) {
    throw new Error(error.message || "No se pudo guardar warning");
  }

  return { rowsUpserted: payload.length };
}

// ==========================
// GEMINI (NUEVO MOTOR)
// ==========================
function obtenerOpenAILimiter(lane = "sugerencias") {
  return lane === "traduccion"
    ? translationOpenAILimiter
    : suggestionsOpenAILimiter;
}

async function llamarGemini({
  lane = "sugerencias",
  modelName,
  systemInstruction,
  prompt,
  temperature = 0.58,
  maxTokens = 420
}) {
  const limiter = obtenerOpenAILimiter(lane);
  
  return limiter.run(async () => {
    const startedAt = Date.now();

    // Mantenemos openai en el runtimeStats para no romper el dashboard
    runtimeStats.openai.total += 1;
    if (lane === "traduccion") runtimeStats.openai.translationCalls += 1;
    else runtimeStats.openai.suggestionCalls += 1;

    try {
      if (!genAI) throw new Error("Falta GEMINI_API_KEY");

      const model = genAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: systemInstruction 
      });

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        }
      });

      const text = result.response.text();
      const usageMetadata = result.response.usageMetadata;

      // Adaptamos la respuesta al formato que esperaba tu Supabase
      const dataFormat = {
        choices: [{ message: { content: text } }],
        usage: {
          prompt_tokens: usageMetadata?.promptTokenCount || 0,
          completion_tokens: usageMetadata?.candidatesTokenCount || 0,
          total_tokens: usageMetadata?.totalTokenCount || 0
        }
      };

      runtimeStats.openai.ok += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      return dataFormat;

    } catch (err) {
      runtimeStats.openai.error += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;
      throw new Error(err.message || "Error consultando Gemini");
    }
  });
}

async function generarSugerencias({
  textoPlano,
  clientePlano,
  contextoPlano,
  perfilPlano,
  lecturaCliente,
  lecturaOperador,
  tonoCliente,
  contactoExterno,
  elementosClave,
  intencionOperador,
  guiaIntencion,
  permisosApertura,
  metaEdicion
}) {
  const userPrompt = construirUserPrompt({
    textoPlano,
    clientePlano,
    contextoPlano,
    perfilPlano,
    lecturaCliente,
    lecturaOperador,
    tonoCliente,
    contactoExterno,
    elementosClave,
    intencionOperador,
    guiaIntencion,
    permisosApertura,
    metaEdicion
  });

  const sysInstruction = construirSystemPrompt(permisosApertura, elementosClave, false);

  const data1 = await llamarGemini({
    lane: "sugerencias",
    modelName: OPENAI_MODEL_SUGGESTIONS, 
    systemInstruction: sysInstruction,
    prompt: userPrompt,
    temperature: 0.56,
    maxTokens: 360
  });

  const sugerencias1Raw = limpiarTextoIA(data1?.choices?.[0]?.message?.content || "")
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  // Filtro interno
  const sugerenciasFinales = sugerencias1Raw.filter(
    (s) => !contieneTemaEncuentro(s) && !violaReglasApertura(s, permisosApertura)
  );

  return {
    sugerencias: sugerenciasFinales.slice(0, 3),
    usageData: data1 
  };
}

async function traducirTexto(texto = "") {
  const sysInstruction = `Traduce al ingles natural de chat como una persona real escribiria.\n\nREGLAS\nNo usar comillas\nNo usar simbolos raros\nNo sonar perfecto\nDebe sonar natural y humano\nDevuelve solo una version final`;

  const data = await llamarGemini({
    lane: "traduccion",
    modelName: OPENAI_MODEL_TRANSLATE, 
    systemInstruction: sysInstruction,
    prompt: String(texto ?? ""),
    temperature: 0.3,
    maxTokens: 140
  });

  const traducido = limpiarSalidaHumana(data?.choices?.[0]?.message?.content || "");

  if (!traducido) {
    throw new Error("No se pudo traducir");
  }

  return {
    traducido,
    usageData: data
  };
}

// ==========================
// ANALYTICS
// ==========================
async function cargarConsumoPorRango(range, operadoresFiltrados = []) {
  return seleccionarTodasLasPaginas((from, to) => {
    let query = supabase
      .from("consumo")
      .select("operador,tipo,tokens,prompt_tokens,completion_tokens,request_ok,created_at,extension_id")
      .gte("created_at", range.startIso)
      .lt("created_at", range.endExclusiveIso)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (operadoresFiltrados.length) {
      query = query.in("operador", operadoresFiltrados);
    }

    return query;
  });
}

async function cargarWarningsPorRango(range, operadoresFiltrados = []) {
  return seleccionarTodasLasPaginas((from, to) => {
    let query = supabase
      .from("warning_resumen_diario")
      .select("operador,extension_id,fecha,frase,cantidad_total,created_at,updated_at")
      .gte("fecha", range.from)
      .lte("fecha", range.to)
      .order("fecha", { ascending: false })
      .range(from, to);

    if (operadoresFiltrados.length) {
      query = query.in("operador", operadoresFiltrados);
    }

    return query;
  });
}

function crearSummaryDashboard() {
  return {
    total_requests: 0,
    ok_requests: 0,
    error_requests: 0,
    ia_requests: 0,
    trad_requests: 0,
    cache_hits: 0,
    shared_hits: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    active_operators: 0,
    warnings_total: 0,
    warnings_unique_pairs: 0
  };
}

function crearOperatorStat(operador = "") {
  return {
    operador,
    requests_total: 0,
    ok_requests: 0,
    error_requests: 0,
    ia_requests: 0,
    trad_requests: 0,
    cache_hits: 0,
    shared_hits: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0,
    last_activity: ""
  };
}

function crearSerieDia(fecha = "") {
  return {
    fecha,
    requests_total: 0,
    ia_requests: 0,
    trad_requests: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0
  };
}

function construirDashboardAnalytics({
  consumoRows = [],
  warningRows = [],
  range = construirRangoFechas(),
  operadoresFiltrados = []
}) {
  const summary = crearSummaryDashboard();
  const operatorMap = new Map();
  const warningOperatorTotals = new Map();
  const warningTopMap = new Map();
  const seriesMap = new Map();
  for (const row of consumoRows) {
    const operador = formatearNombreOperador(row.operador || "anon") || "Anon";
    const tipo = normalizarEspacios(row.tipo || "");
    const totalTokens = safeNumber(row.tokens);
    const promptTokens = safeNumber(row.prompt_tokens);
    const completionTokens = safeNumber(row.completion_tokens);
    const requestOk = row.request_ok !== false;
    const fecha = String(row.created_at || "").slice(0, 10) || range.from;
    const cost = calcularCostoEstimado({
      tipo,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens
    });
    summary.total_requests += 1;
    if (requestOk) summary.ok_requests += 1;
    else summary.error_requests += 1;

    if (tipo.startsWith("IA")) summary.ia_requests += 1;
    if (tipo.startsWith("TRAD")) summary.trad_requests += 1;
    if (tipo.endsWith("_CACHE")) summary.cache_hits += 1;
    if (tipo.endsWith("_SHARED")) summary.shared_hits += 1;

    summary.total_tokens += totalTokens;
    summary.prompt_tokens += promptTokens;
    summary.completion_tokens += completionTokens;
    summary.estimated_cost_total += cost;

    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, crearOperatorStat(operador));
    }

    const op = operatorMap.get(operador);
    op.requests_total += 1;
    if (requestOk) op.ok_requests += 1;
    else op.error_requests += 1;
    if (tipo.startsWith("IA")) op.ia_requests += 1;
    if (tipo.startsWith("TRAD")) op.trad_requests += 1;
    if (tipo.endsWith("_CACHE")) op.cache_hits += 1;
    if (tipo.endsWith("_SHARED")) op.shared_hits += 1;
    op.total_tokens += totalTokens;
    op.prompt_tokens += promptTokens;
    op.completion_tokens += completionTokens;
    op.estimated_cost_total += cost;
    if (!op.last_activity || String(row.created_at || "") > op.last_activity) {
      op.last_activity = String(row.created_at || "");
    }

    if (!seriesMap.has(fecha)) {
      seriesMap.set(fecha, crearSerieDia(fecha));
    }

    const serie = seriesMap.get(fecha);
    serie.requests_total += 1;
    if (tipo.startsWith("IA")) serie.ia_requests += 1;
    if (tipo.startsWith("TRAD")) serie.trad_requests += 1;
    serie.total_tokens += totalTokens;
    serie.prompt_tokens += promptTokens;
    serie.completion_tokens += completionTokens;
    serie.estimated_cost_total += cost;
  }

  for (const row of warningRows) {
    const operador = formatearNombreOperador(row.operador || "anon") || "Anon";
    const frase = normalizarEspacios(row.frase || "");
    const cantidad = safeNumber(row.cantidad_total);
    const fecha = String(row.fecha || "") || range.from;
    summary.warnings_total += cantidad;

    const pairKey = `${operador}||${normalizarTexto(frase)}`;
    if (!warningTopMap.has(pairKey)) {
      warningTopMap.set(pairKey, {
        operador,
        frase,
        total_count: 0,
        last_date: fecha
      });
    }

    const top = warningTopMap.get(pairKey);
    top.total_count += cantidad;
    if (!top.last_date || fecha > top.last_date) {
      top.last_date = fecha;
    }

    warningOperatorTotals.set(
      operador,
      safeNumber(warningOperatorTotals.get(operador)) + cantidad
    );
    if (!seriesMap.has(fecha)) {
      seriesMap.set(fecha, crearSerieDia(fecha));
    }

    const serie = seriesMap.get(fecha);
    serie.warnings_total += cantidad;
  }

  summary.warnings_unique_pairs = warningTopMap.size;

  for (const [operador, totalWarnings] of warningOperatorTotals.entries()) {
    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, crearOperatorStat(operador));
    }

    operatorMap.get(operador).warnings_total = totalWarnings;
  }

  summary.active_operators = operatorMap.size;
  summary.estimated_cost_total = redondearDinero(summary.estimated_cost_total);
  const operatorStats = Array.from(operatorMap.values())
    .map((op) => ({
      ...op,
      estimated_cost_total: redondearDinero(op.estimated_cost_total)
    }))
    .sort((a, b) => {
      if (b.estimated_cost_total !== a.estimated_cost_total) {
        return b.estimated_cost_total - a.estimated_cost_total;
      }

      if (b.total_tokens !== a.total_tokens) {
        return b.total_tokens - a.total_tokens;
      }

      return a.operador.localeCompare(b.operador);
    });
  const warningTop = Array.from(warningTopMap.values())
    .sort((a, b) => {
      if (b.total_count !== a.total_count) {
        return b.total_count - a.total_count;
      }

      return a.operador.localeCompare(b.operador);
    });
  const series = Array.from(seriesMap.values())
    .map((x) => ({
      ...x,
      estimated_cost_total: redondearDinero(x.estimated_cost_total)
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  return {
    generated_at: new Date().toISOString(),
    range: {
      from: range.from,
      to: range.to
    },
    summary,
    operator_stats: operatorStats,
    warning_top: warningTop,
    series,
    operator_filter: operadoresFiltrados,
    pricing: {
      suggestions_model: OPENAI_MODEL_SUGGESTIONS,
      translate_model: OPENAI_MODEL_TRANSLATE,
      suggestion_input_cost_per_1m: SUGGESTION_INPUT_COST_PER_1M,
      suggestion_output_cost_per_1m: SUGGESTION_OUTPUT_COST_PER_1M,
      translate_input_cost_per_1m: TRANSLATE_INPUT_COST_PER_1M,
      translate_output_cost_per_1m: TRANSLATE_OUTPUT_COST_PER_1M
    }
  };
}

// ==========================
// PANEL ADMIN STATIC
// ==========================
app.get(["/admin", "/admin/"], (_req, res) => {
  return res.sendFile(path.join(__dirname, "admin.html"));
});
app.get("/admin.js", (_req, res) => {
  return res.sendFile(path.join(__dirname, "admin.js"));
});

// ==========================
// HEALTH
// ==========================
app.get("/health", (_req, res) => {
  return res.json({
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
        operators: operatorSuggestionQueues.size,
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
  });
});

// ==========================
// ADMIN API
// ==========================
app.post("/admin-api/login", async (req, res) => {
  runtimeStats.admin.loginTotal += 1;

  if (!adminEstaConfigurado()) {
    runtimeStats.admin.loginError += 1;
    return res.status(503).json({
      ok: false,
      error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET en Railway"
    });
  }

  const usuario = normalizarEspacios(req.body?.usuario || "");
  const password = String(req.body?.password || "").trim();

  if (!usuario || !password) {
    runtimeStats.admin.loginError += 1;
    return res.status(400).json({
      ok: false,
      error: "Completa usuario y password"
    });
  }

  const rateKey = obtenerClaveRateAdmin(req, usuario);

  if (adminLoginBloqueado(rateKey)) {
    runtimeStats.admin.loginError += 1;
    return res.status(429).json({
      ok: false,
      error: "Demasiados intentos. Espera unos minutos"
    });
  }

  if (!credencialesAdminValidas(usuario, password)) {
    registrarIntentoAdmin(rateKey, false);
    runtimeStats.admin.loginError += 1;
    return res.status(401).json({
      ok: false,
      error: "Credenciales admin invalidas"
    });
  }

  registrarIntentoAdmin(rateKey, true);
  runtimeStats.admin.loginOk += 1;

  return res.json({
    ok: true,
    token: crearAdminToken(ADMIN_USER),
    user: ADMIN_USER,
    operator_shared_key: OPERATOR_SHARED_KEY,
    expires_in_hours: ADMIN_TOKEN_TTL_HOURS
  });
});

app.get("/admin-api/session", autorizarAdmin, async (req, res) => {
  return res.json({
    ok: true,
    user: req.adminAuth?.sub || ADMIN_USER,
    expires_at: req.adminAuth?.exp || null,
    operator_shared_key: OPERATOR_SHARED_KEY
  });
});
app.get("/admin-api/operators", autorizarAdmin, async (_req, res) => {
  try {
    const operators = await listarOperadoresAdmin();
    runtimeStats.admin.operatorList += 1;

    return res.json({
      ok: true,
      summary: resumirOperadores(operators),
      operators
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo listar operadores"
    });
  }
});
app.post("/admin-api/operators", autorizarAdmin, async (req, res) => {
  try {
    const result = await crearOReactivarOperadorAdmin(req.body?.nombre || "");
    runtimeStats.admin.operatorCreate += 1;

    return res.json({
      ok: true,
      action: result.action,
      operator: result.operator
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo guardar el operador"
    });
  }
});
app.post("/admin-api/operators/bulk", autorizarAdmin, async (req, res) => {
  try {
    const nombres = parsearNombresBulk(req.body?.texto || req.body?.nombres || "");

    if (!nombres.length) {
      return res.status(400).json({
        ok: false,
        error: "Pega al menos un nombre"
      });
    }

    const result = {
      created: [],
      reactivated: [],
      updated: [],
      existing: [],
      errors: []
    };

    for (const nombre of nombres) {
      try {
        const item = await crearOReactivarOperadorAdmin(nombre);
        if (item.action === "created") result.created.push(item.operator);
        else if (item.action === "reactivated") result.reactivated.push(item.operator);
        else if (item.action === "updated") result.updated.push(item.operator);
        else result.existing.push(item.operator);
      } catch (err) {
        result.errors.push({
          nombre,
          error: err.message || "No se pudo procesar"
        });
      }
    }

    runtimeStats.admin.operatorCreate +=
      result.created.length + result.reactivated.length + result.updated.length;
    const operators = await listarOperadoresAdmin();

    return res.json({
      ok: true,
      result,
      summary: resumirOperadores(operators),
      operators
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo procesar el alta masiva"
    });
  }
});

app.patch("/admin-api/operators/:id/status", autorizarAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const activo = Boolean(req.body?.activo);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID invalido"
      });
    }

    const { data: actual, error: errorRead } = await supabase
      .from("operadores")
      .select("id, nombre, activo, created_at")
      .eq("id", id)
      .maybeSingle();

    if (errorRead) {
      throw new Error("No se pudo leer el operador");
    }

    if (!actual) {
      return res.status(404).json({
        ok: false,
        error: "Operador no encontrado"
      });
    }

    if (!activo) {
      borrarOperadorCache(actual.nombre);
    }

    const { data, error } = await supabase
      .from("operadores")
      .update({ activo })
      .eq("id", id)
      .select("id, nombre, activo, created_at")
      .single();

    if (error || !data) {
      throw new Error("No se pudo actualizar el operador");
    }

    runtimeStats.admin.operatorUpdate += 1;

    return res.json({
      ok: true,
      operator: data
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo actualizar el operador"
    });
  }
});

app.delete("/admin-api/operators/:id", autorizarAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID invalido"
      });
    }

    const { data: actual, error: errorRead } = await supabase
      .from("operadores")
      .select("id, nombre, activo, created_at")
      .eq("id", id)
      .maybeSingle();

    if (errorRead) {
      throw new Error("No se pudo leer el operador");
    }

    if (!actual) {
      return res.status(404).json({
        ok: false,
        error: "Operador no encontrado"
      });
    }

    const { error } = await supabase
      .from("operadores")
      .delete()
      .eq("id", id);

    if (error) {
      throw new Error("No se pudo eliminar el operador");
    }

    borrarOperadorCache(actual.nombre);
    runtimeStats.admin.operatorDelete += 1;

    return res.json({
      ok: true,
      operator: actual
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo eliminar el operador"
    });
  }
});

app.get("/admin-api/dashboard", autorizarAdmin, async (req, res) => {
  try {
    const range = construirRangoFechas(req.query?.from || "", req.query?.to || "");
    const operadoresFiltrados = parsearFiltroOperadores(req.query?.operadores || "");

    const [consumoRows, warningRows] = await Promise.all([
      cargarConsumoPorRango(range, operadoresFiltrados),
      cargarWarningsPorRango(range, operadoresFiltrados)
    ]);

    runtimeStats.admin.dashboardLoads += 1;

    return res.json({
      ok: true,
      ...construirDashboardAnalytics({
        consumoRows,
        warningRows,
        range,
        operadoresFiltrados
      })
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo cargar el dashboard"
    });
  }
});
// ==========================
// LOGIN OPERADOR
// ==========================
app.post("/login", autorizarOperador, async (req, res) => {
  return res.json({
    ok: true,
    operador: req.operadorAutorizado
  });
});
// ==========================
// WARNING SYNC
// ==========================
app.post("/warning-sync", autorizarOperador, async (req, res) => {
  const startedAt = Date.now();
  runtimeStats.warnings.total += 1;

  try {
    const {
      extension_id = "",
      fecha = "",
      counts = {}
    } = req.body || {};

    const result = await guardarWarningResumen({
      operador: req.operadorAutorizado,
      extension_id,
      fecha,
      counts
    });

    runtimeStats.warnings.ok += 1;
    runtimeStats.warnings.rowsUpserted += safeNumber(result.rowsUpserted);
    runtimeStats.warnings.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      rows_upserted: result.rowsUpserted || 0
    });
  } catch (err) {
    runtimeStats.warnings.error += 1;
    runtimeStats.warnings.lastMs = Date.now() - startedAt;

    return res.json({
      ok: false,
      error: err.message || "No se pudo sincronizar warning"
    });
  }
});
// ==========================
// SUGERENCIAS
// ==========================
app.post("/sugerencias", autorizarOperador, async (req, res) => {
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

    const elementosClave = detectarElementosClave(texto);
    const analisisCliente = analizarCliente(cliente);
    const analisisOperador = analizarMensajeOperador(texto);

    const lecturaCliente = construirLecturaCliente(analisisCliente);
    const lecturaOperador = construirLecturaOperador(analisisOperador);

    const contextoFiltrado = filtrarContextoRelevante(contexto, texto, cliente);
    const permisosApertura = detectarPermisosApertura({
      texto,
      cliente,
      contexto
    });

    const intencionOperador = detectarIntencionOperador(
      texto,
      cliente,
      contextoFiltrado
    );
    const guiaIntencion = construirGuiaIntencion(intencionOperador);

    const textoPlano = compactarBloque(quitarTildes(texto), 800);
    const clientePlano = compactarBloque(
      quitarTildes(cliente || "Sin mensaje"),
      500
    );
    const contextoPlano = compactarBloque(
      quitarTildes(limitarContexto(contextoFiltrado) || "Sin contexto"),
      1000
    );
    const perfilPlano = compactarBloque(
      quitarTildes(limitarContexto(perfil) || "Sin perfil"),
      280
    );
    const metaEdicion = analisisOperador.metaEdicion;

    const fingerprint = crearFingerprintSugerencia({
      operador,
      textoPlano,
      clientePlano,
      contextoPlano,
      perfilPlano
    });
    const sharedJob = getSharedInFlight(
      inflightSuggestionJobs,
      fingerprint,
      async () => {
        return runSuggestionQueueByOperator(operador, async () => {
          return generarSugerencias({
            textoPlano,
            clientePlano,
            contextoPlano,
            perfilPlano,
            lecturaCliente,
            lecturaOperador,
            tonoCliente: analisisCliente.tono,
            contactoExterno: analisisCliente.contacto,
            elementosClave,
            intencionOperador,
            guiaIntencion,
            permisosApertura,
            metaEdicion
          });
        });
      }
    );
    if (sharedJob.shared) {
      runtimeStats.suggestions.inflightHits += 1;
    }

    const resultado = await sharedJob.promise;
    let sugerencias = Array.isArray(resultado?.sugerencias)
      ? resultado.sugerencias
      : [];
    sugerencias = sugerencias.filter(
      (s) => !contieneTemaEncuentro(s) && !violaReglasApertura(s, permisosApertura)
    );
    if (!sugerencias.length) {
      sugerencias = ["Escribe un poco mas de contexto"];
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

// ==========================
// TRADUCCION
// ==========================
app.post("/traducir", autorizarOperador, async (req, res) => {
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

// ==========================
// ERROR FINAL
// ==========================
app.use((err, _req, res, _next) => {
  console.error("Error no controlado:", err);

  if (res.headersSent) {
    return;
  }

  return res.status(500).json({
    ok: false,
    error: "Error interno"
  });
});
// ==========================
// START
// ==========================
app.listen(PORT, () => {
  console.log(`Server PRO activo en puerto ${PORT}`);
  console.log(
    `Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`
  );
  console.log(
    `Lanes Gemini => sugerencias: ${SUGGESTION_OPENAI_CONCURRENCY} | traduccion: ${TRANSLATION_OPENAI_CONCURRENCY}`
  );
  console.log(
    `Admin panel => ${adminEstaConfigurado() ? "configurado" : "faltan variables ADMIN_*"}`
  );
});
