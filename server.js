const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID, timingSafeEqual, createHmac } = require("crypto");

/* =========================================================
 * HELPERS
 * ======================================================= */

function readIntEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readFloatEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseFloat(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function removeAccents(text = "") {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(text = "") {
  return removeAccents(String(text ?? ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpaces(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function cleanHuman(text = "") {
  return String(text ?? "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(n = 0) {
  return Number(safeNumber(n, 0).toFixed(6));
}

function countChars(text = "") {
  return normalizeSpaces(String(text || "")).length;
}

function countQuestions(text = "") {
  const t = String(text || "");
  const abiertas = (t.match(/¿/g) || []).length;
  const cerradas = (t.match(/\?/g) || []).length;
  return Math.max(abiertas, cerradas);
}

function dedupeStrings(items = []) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const clean = cleanHuman(item);
    const key = normalizeText(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function formatDateISO(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function firstDayOfMonthUTC(date = new Date()) {
  return formatDateISO(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  );
}

function isValidISODate(text = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text || ""));
}

function addDaysISO(dateISO = "", days = 0) {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateISO(d);
}

function compareISODate(a = "", b = "") {
  return String(a).localeCompare(String(b));
}

function buildDateRange(fromRaw = "", toRaw = "") {
  const today = formatDateISO(new Date());

  let from = isValidISODate(fromRaw) ? fromRaw : firstDayOfMonthUTC(new Date());
  let to = isValidISODate(toRaw) ? toRaw : today;

  if (compareISODate(from, to) > 0) {
    const temp = from;
    from = to;
    to = temp;
  }

  return {
    from,
    to,
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${addDaysISO(to, 1)}T00:00:00.000Z`
  };
}

function createRequestId() {
  try {
    return randomUUID();
  } catch (_err) {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function safeCompare(a = "", b = "") {
  const aa = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");

  if (aa.length !== bb.length) return false;

  try {
    return timingSafeEqual(aa, bb);
  } catch (_err) {
    return false;
  }
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

function escapeRegExp(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function selectAllPages(builderFactory, pageSize = 1000) {
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await builderFactory(from, from + pageSize - 1);
    if (error) throw error;

    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);

    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function combineUsageData(items = []) {
  const total = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  let found = false;

  for (const item of items) {
    const usage = item?.usage || item;
    if (!usage) continue;

    total.prompt_tokens += safeNumber(usage.prompt_tokens);
    total.completion_tokens += safeNumber(usage.completion_tokens);
    total.total_tokens += safeNumber(usage.total_tokens);

    if (
      safeNumber(usage.prompt_tokens) ||
      safeNumber(usage.completion_tokens) ||
      safeNumber(usage.total_tokens)
    ) {
      found = true;
    }
  }

  return found ? { usage: total } : null;
}

/* =========================================================
 * ENV
 * ======================================================= */

const PORT = readIntEnv("PORT", 3000, 1, 65535);

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "");
const OPENAI_URL = String(
  process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions"
);

const OPENAI_MODEL_SUGGESTIONS = String(
  process.env.OPENAI_MODEL_SUGGESTIONS ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini"
);

const OPENAI_MODEL_TRANSLATE = String(
  process.env.OPENAI_MODEL_TRANSLATE ||
  process.env.OPENAI_MODEL_FAST ||
  "gpt-4o-mini"
);

const OPENAI_TIMEOUT_SUGGESTIONS_MS = readIntEnv(
  "OPENAI_TIMEOUT_SUGGESTIONS_MS",
  24000,
  8000,
  60000
);

const OPENAI_TIMEOUT_TRANSLATE_MS = readIntEnv(
  "OPENAI_TIMEOUT_TRANSLATE_MS",
  10000,
  4000,
  30000
);

const SUGGESTION_MAX_TOKENS = readIntEnv(
  "SUGGESTION_MAX_TOKENS",
  580,
  300,
  1200
);

const MAX_CONTEXT_LINES = readIntEnv("MAX_CONTEXT_LINES", 10, 4, 18);
const MIN_RESPONSE_LENGTH = readIntEnv("MIN_RESPONSE_LENGTH", 80, 20, 180);

const OPERATOR_SHARED_KEY = String(process.env.OPERATOR_SHARED_KEY || "2026");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "");
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || "");

const ADMIN_USER = String(process.env.ADMIN_USER || "admin");
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const ADMIN_TOKEN_SECRET = String(
  process.env.ADMIN_TOKEN_SECRET || SUPABASE_KEY || OPERATOR_SHARED_KEY
);

const ADMIN_TOKEN_TTL_HOURS = readIntEnv("ADMIN_TOKEN_TTL_HOURS", 12, 1, 168);
const ADMIN_LOGIN_WINDOW_MS = readIntEnv(
  "ADMIN_LOGIN_WINDOW_MS",
  15 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000
);
const ADMIN_LOGIN_MAX_ATTEMPTS = readIntEnv(
  "ADMIN_LOGIN_MAX_ATTEMPTS",
  8,
  3,
  50
);

const OPERATOR_CACHE_TTL_MS = readIntEnv(
  "OPERATOR_CACHE_TTL_MS",
  5 * 60 * 1000,
  30000,
  60 * 60 * 1000
);

const TRANSLATION_CACHE_TTL_MS = readIntEnv(
  "TRANSLATION_CACHE_TTL_MS",
  15 * 60 * 1000,
  60000,
  2 * 60 * 60 * 1000
);

const TRANSLATION_CACHE_LIMIT = readIntEnv(
  "TRANSLATION_CACHE_LIMIT",
  500,
  50,
  5000
);

const SUGGESTION_OPENAI_CONCURRENCY = readIntEnv(
  "SUGGESTION_OPENAI_CONCURRENCY",
  6,
  1,
  20
);

const TRANSLATION_OPENAI_CONCURRENCY = readIntEnv(
  "TRANSLATION_OPENAI_CONCURRENCY",
  2,
  1,
  10
);

const SUGGESTION_OPENAI_QUEUE_LIMIT = readIntEnv(
  "SUGGESTION_OPENAI_QUEUE_LIMIT",
  80,
  1,
  500
);

const TRANSLATION_OPENAI_QUEUE_LIMIT = readIntEnv(
  "TRANSLATION_OPENAI_QUEUE_LIMIT",
  40,
  1,
  300
);

const SUGGESTION_OPENAI_QUEUE_WAIT_MS = readIntEnv(
  "SUGGESTION_OPENAI_QUEUE_WAIT_MS",
  15000,
  1000,
  45000
);

const TRANSLATION_OPENAI_QUEUE_WAIT_MS = readIntEnv(
  "TRANSLATION_OPENAI_QUEUE_WAIT_MS",
  8000,
  1000,
  25000
);

const PER_OPERATOR_SUGGESTION_QUEUE_LIMIT = readIntEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_LIMIT",
  3,
  1,
  10
);

const PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS = readIntEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS",
  15000,
  1000,
  45000
);

const DEFAULT_MODEL_PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 }
};

function getDefaultPricingForModel(model = "") {
  return DEFAULT_MODEL_PRICING[normalizeText(model)] || { input: 0, output: 0 };
}

const pricingSuggestionDefault = getDefaultPricingForModel(OPENAI_MODEL_SUGGESTIONS);
const pricingTranslateDefault = getDefaultPricingForModel(OPENAI_MODEL_TRANSLATE);

const SUGGESTION_INPUT_COST_PER_1M = readFloatEnv(
  "SUGGESTION_INPUT_COST_PER_1M",
  pricingSuggestionDefault.input,
  0,
  100000
);

const SUGGESTION_OUTPUT_COST_PER_1M = readFloatEnv(
  "SUGGESTION_OUTPUT_COST_PER_1M",
  pricingSuggestionDefault.output,
  0,
  100000
);

const TRANSLATE_INPUT_COST_PER_1M = readFloatEnv(
  "TRANSLATE_INPUT_COST_PER_1M",
  pricingTranslateDefault.input,
  0,
  100000
);

const TRANSLATE_OUTPUT_COST_PER_1M = readFloatEnv(
  "TRANSLATE_OUTPUT_COST_PER_1M",
  pricingTranslateDefault.output,
  0,
  100000
);

const TARGET_SUGGESTION_SPECS = [
  { min: 150, max: 200, ideal: 175 },
  { min: 200, max: 300, ideal: 245 },
  { min: 250, max: 400, ideal: 320 }
];

const SUGGESTION_MEMORY_TTL_MS = 20 * 60 * 1000;
const SUGGESTION_MEMORY_LIMIT = 700;

if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* =========================================================
 * APP / STATE
 * ======================================================= */

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const operatorAuthCache = new Map();
const translationCache = new Map();
const inflightTranslationJobs = new Map();
const inflightSuggestionJobs = new Map();
const recentSuggestionMemory = new Map();
const operatorSuggestionQueues = new Map();
const adminLoginAttempts = new Map();

const runtimeStats = {
  startedAt: Date.now(),
  http: { total: 0, ok: 0, error: 0, lastMs: 0 },
  suggestions: {
    total: 0,
    ok: 0,
    error: 0,
    inflightHits: 0,
    secondPasses: 0,
    fallbackOnly: 0,
    forcedFill: 0,
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
  req.requestId = createRequestId();

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

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ ok: false, error: "JSON invalido" });
  }
  return next(err);
});

/* =========================================================
 * OPERATOR AUTH
 * ======================================================= */

function formatOperatorName(name = "") {
  return normalizeSpaces(name)
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readOperatorCache(name = "") {
  const key = normalizeText(formatOperatorName(name));
  const entry = operatorAuthCache.get(key);

  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    operatorAuthCache.delete(key);
    return "";
  }

  return entry.value || "";
}

function writeOperatorCache(name = "", value = "") {
  const key = normalizeText(formatOperatorName(name));
  if (!key || !value) return;

  operatorAuthCache.set(key, {
    value,
    expiresAt: Date.now() + OPERATOR_CACHE_TTL_MS
  });
}

function deleteOperatorCache(name = "") {
  const key = normalizeText(formatOperatorName(name));
  if (!key) return;
  operatorAuthCache.delete(key);
}

async function validateOperatorAccess(operador = "", clave = "") {
  const operadorFmt = formatOperatorName(operador);

  if (!operadorFmt) {
    throw new Error("Operador vacio");
  }

  if (!safeCompare(String(clave || ""), OPERATOR_SHARED_KEY)) {
    throw new Error("Clave invalida");
  }

  const cached = readOperatorCache(operadorFmt);
  if (cached) {
    return cached;
  }

  const { data, error } = await supabase
    .from("operadores")
    .select("nombre,activo")
    .ilike("nombre", operadorFmt)
    .limit(10);

  if (error) {
    throw new Error("No se pudo validar el operador");
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row || !row.activo) {
    throw new Error("Operador no autorizado");
  }

  writeOperatorCache(operadorFmt, row.nombre);
  return row.nombre;
}

async function authorizeOperator(req, res, next) {
  try {
    const { operador = "", clave = "" } = req.body || {};
    req.operadorAutorizado = await validateOperatorAccess(operador, clave);
    return next();
  } catch (err) {
    return res.json({
      ok: false,
      error: err.message || "No autorizado"
    });
  }
}

/* =========================================================
 * ADMIN AUTH
 * ======================================================= */

function adminConfigured() {
  return Boolean(ADMIN_USER && ADMIN_PASSWORD && ADMIN_TOKEN_SECRET);
}

function signAdminToken(payloadB64 = "") {
  return base64UrlEncode(
    createHmac("sha256", ADMIN_TOKEN_SECRET).update(payloadB64).digest()
  );
}

function createAdminToken(usuario = ADMIN_USER) {
  const now = Date.now();

  const payload = {
    sub: usuario || ADMIN_USER,
    role: "admin",
    iat: now,
    exp: now + (ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000),
    nonce: createRequestId()
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signAdminToken(payloadB64);

  return `${payloadB64}.${signature}`;
}

function verifyAdminToken(token = "") {
  const [payloadB64, signature] = String(token || "").split(".");

  if (!payloadB64 || !signature) {
    throw new Error("Token admin invalido");
  }

  const expected = signAdminToken(payloadB64);
  if (!safeCompare(signature, expected)) {
    throw new Error("Token admin invalido");
  }

  let payload = null;

  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (_err) {
    throw new Error("Token admin invalido");
  }

  if (!payload?.sub || payload.role !== "admin") {
    throw new Error("Token admin invalido");
  }

  if (!payload?.exp || payload.exp < Date.now()) {
    throw new Error("Sesion admin expirada");
  }

  return payload;
}

function cleanupAdminLoginAttempts() {
  const now = Date.now();

  for (const [key, entry] of adminLoginAttempts.entries()) {
    const fresh = (entry?.timestamps || []).filter(
      (ts) => (now - ts) < ADMIN_LOGIN_WINDOW_MS
    );

    if (!fresh.length) {
      adminLoginAttempts.delete(key);
      continue;
    }

    adminLoginAttempts.set(key, { timestamps: fresh });
  }
}

function getAdminRateKey(req, usuario = "") {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || "sin-ip";
  return `${ip}::${normalizeText(usuario || "admin")}`;
}

function isAdminLoginBlocked(rateKey = "") {
  if (!rateKey) return false;
  cleanupAdminLoginAttempts();
  const entry = adminLoginAttempts.get(rateKey);
  if (!entry) return false;
  return (entry.timestamps || []).length >= ADMIN_LOGIN_MAX_ATTEMPTS;
}

function registerAdminAttempt(rateKey = "", ok = false) {
  if (!rateKey) return;

  if (ok) {
    adminLoginAttempts.delete(rateKey);
    return;
  }

  cleanupAdminLoginAttempts();

  const entry = adminLoginAttempts.get(rateKey) || { timestamps: [] };
  entry.timestamps.push(Date.now());
  adminLoginAttempts.set(rateKey, entry);
}

function getAdminTokenFromRequest(req) {
  const auth = String(req.headers.authorization || "");

  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }

  return String(
    req.headers["x-admin-token"] ||
    req.body?.token ||
    req.query?.token ||
    ""
  );
}

function adminCredentialsValid(usuario = "", password = "") {
  return (
    safeCompare(normalizeText(usuario), normalizeText(ADMIN_USER)) &&
    safeCompare(String(password || ""), String(ADMIN_PASSWORD || ""))
  );
}

function authorizeAdmin(req, res, next) {
  if (!adminConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET"
    });
  }

  try {
    const token = getAdminTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Sesion admin requerida"
      });
    }

    const payload = verifyAdminToken(token);
    req.adminAuth = payload;
    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: err.message || "Sesion admin invalida"
    });
  }
}

/* =========================================================
 * QUEUES / LIMITERS
 * ======================================================= */

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
      if (!job) return;
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

function getOrCreateOperatorQueueState(operadorKey) {
  if (!operatorSuggestionQueues.has(operadorKey)) {
    operatorSuggestionQueues.set(operadorKey, {
      running: false,
      queue: []
    });
  }

  return operatorSuggestionQueues.get(operadorKey);
}

function cleanupOperatorQueue(operadorKey, state) {
  if (!state.running && state.queue.length === 0) {
    operatorSuggestionQueues.delete(operadorKey);
  }
}

function drainOperatorQueue(operadorKey, state) {
  if (state.running) return;

  const next = state.queue.shift();
  if (!next) {
    cleanupOperatorQueue(operadorKey, state);
    return;
  }

  next.execute();
}

function runSuggestionQueueByOperator(operador = "", task) {
  const operadorKey = normalizeText(operador || "anon");
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

      if (job.timeoutId) {
        clearTimeout(job.timeoutId);
        job.timeoutId = null;
      }

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.running = false;
          drainOperatorQueue(operadorKey, state);
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
        if (idx >= 0) state.queue.splice(idx, 1);

        cleanupOperatorQueue(operadorKey, state);
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

/* =========================================================
 * OPENAI
 * ======================================================= */

async function callOpenAI({
  lane = "sugerencias",
  model,
  messages,
  temperature = 0.75,
  maxTokens = 420,
  timeoutMs = 15000,
  topP = 1,
  frequencyPenalty = 0,
  presencePenalty = 0
}) {
  const limiter = lane === "traduccion"
    ? translationOpenAILimiter
    : suggestionsOpenAILimiter;

  return limiter.run(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    runtimeStats.openai.total += 1;
    if (lane === "traduccion") runtimeStats.openai.translationCalls += 1;
    else runtimeStats.openai.suggestionCalls += 1;

    try {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          top_p: topP,
          frequency_penalty: frequencyPenalty,
          presence_penalty: presencePenalty,
          max_tokens: maxTokens
        })
      });

      let data;
      try {
        data = await response.json();
      } catch (_err) {
        throw new Error("La respuesta de OpenAI no vino en JSON");
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("OpenAI esta ocupado. Intenta de nuevo en unos segundos");
        }

        throw new Error(data?.error?.message || "Error consultando OpenAI");
      }

      runtimeStats.openai.ok += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      return data;
    } catch (err) {
      runtimeStats.openai.error += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      if (err.name === "AbortError") {
        throw new Error(
          lane === "traduccion"
            ? "La traduccion tardo demasiado"
            : "OpenAI tardo demasiado en responder"
        );
      }

      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

/* =========================================================
 * SUGGESTION ENGINE
 * ======================================================= */

const STOPWORDS_SUGGESTIONS = new Set([
  "a", "al", "algo", "alguien", "alla", "and", "ante", "antes", "asi",
  "aqui", "be", "but", "by", "como", "con", "cual", "cuales", "de", "del",
  "do", "donde", "el", "ella", "ellas", "ellos", "en", "eres", "es", "esa",
  "esas", "ese", "eso", "esos", "esta", "estas", "este", "esto", "estos",
  "for", "from", "gracias", "ha", "hay", "he", "hola", "how", "i", "is",
  "it", "la", "las", "lo", "los", "me", "mi", "mis", "mucho", "muy", "my",
  "no", "nos", "o", "of", "on", "or", "para", "pero", "por", "porque",
  "que", "quien", "se", "si", "sin", "so", "su", "sus", "te", "that",
  "the", "this", "to", "tu", "tus", "un", "una", "uno", "unos", "unas",
  "was", "we", "what", "where", "which", "who", "why", "y", "ya", "yo",
  "you", "your"
]);

const BANNED_TOPIC_WORDS = new Set([
  "minutes",
  "minute",
  "hours",
  "hour",
  "today",
  "yesterday",
  "typing",
  "unseen",
  "seen",
  "original",
  "draft",
  "online"
]);

const INTERNAL_LABEL_REGEX = /\b(NOMBRE_CLIENTA|PAIS_CLIENTA|FECHA_NACIMIENTO|ESTADO_CIVIL|INTERESES_EN_COMUN|INTERESTED_IN|INTERESES_CLIENTA|LOOKING_FOR|ABOUT_ME|ABOUT_TEXT|DATOS_CLIENTA|PROFILE_ANCHORS|RAW_PROFILE|no disponible|ninguno)\b/i;
const META_REGEX = /\b(responderte mejor|escribirte mejor|tu vibra|tu energia|como te decia|frase vacia|mejor dicho|te respondi mejor)\b/i;
const FALSE_FAMILIARITY_REGEX = /\b(nuestras conversaciones|lo que hablamos|como me dijiste|me acorde de ti|me qued[eé] pensando en ti|hace tiempo|otra vez por aqui|retomar lo nuestro|seguir donde lo dejamos)\b/i;
const DISALLOWED_CONTACT_REGEX = /\b(whatsapp|telegram|instagram|insta|snapchat|snap|discord|email|correo|telefono|numero|phone)\b/i;
const DISALLOWED_MEET_REGEX = /\b(vernos|en persona|salir|cafe|cena|drink|dinner|direccion|hotel|llamame|llamarte|call me)\b/i;
const EMPTY_MIRROR_REGEX = /^(entiendo|tiene sentido|lo que dices|gracias por decirme|te entiendo|suena bien|claro)\b/i;
const EMPTY_GENERIC_START_REGEX = /^(hola|hey|buenas|como estas|que tal)\b/i;
const ONE_WORD_MIRROR_REGEX = /\b(eso que dijiste sobre|lo que dijiste sobre|ahi en lo de)\b/i;
const OVER_AFFECTION_REGEX = /\b(mi amor|amor|love|baby|darling|honey|carino|bebe)\b/gi;
const THIRD_PERSON_GENERIC_REGEX = /\b(la historia de|la vida de|el perfil de|los datos de|la forma de ser de|la personalidad de)\b/i;

const RISK_CATALOG = {
  contacto_externo: {
    key: "contacto_externo",
    label: "Contacto externo",
    severity: 100,
    guidance: "No pidas ni aceptes contacto externo. Redirige con naturalidad a seguir por este chat."
  },
  pregunta_pago_plataforma: {
    key: "pregunta_pago_plataforma",
    label: "Duda de pago o plataforma",
    severity: 92,
    guidance: "No inventes politicas ni cobros. Responde con prudencia y sin vender humo."
  },
  redes_externas: {
    key: "redes_externas",
    label: "Redes externas detectadas",
    severity: 90,
    guidance: "No confirmes identidades externas ni saques la conversacion fuera."
  },
  abandono_ritmo_contacto: {
    key: "abandono_ritmo_contacto",
    label: "Abandono por ritmo o contacto",
    severity: 95,
    guidance: "Baja presion, valida el ritmo y evita que la conversacion se pierda."
  },
  desconfianza_realidad: {
    key: "desconfianza_realidad",
    label: "Desconfianza o prueba de realidad",
    severity: 75,
    guidance: "Sonar claro, concreto y humano. No ponerse a la defensiva."
  }
};

function normalizeChatSignals(raw = {}) {
  return {
    ultimo_role_visible: String(raw?.ultimo_role_visible || "").trim().toLowerCase(),
    hay_clienta_visible: Boolean(raw?.hay_clienta_visible),
    hay_operador_visible: Boolean(raw?.hay_operador_visible),
    solo_operador_visible: Boolean(raw?.solo_operador_visible),
    total_clienta_visible: Number(raw?.total_clienta_visible || 0),
    total_operador_visible: Number(raw?.total_operador_visible || 0)
  };
}

function parseContextLines(context = "") {
  return String(context ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .map((line) => {
      if (/^CLIENTA:/i.test(line)) {
        return {
          role: "clienta",
          text: normalizeSpaces(line.replace(/^CLIENTA:\s*/i, ""))
        };
      }

      if (/^OPERADOR:/i.test(line)) {
        return {
          role: "operador",
          text: normalizeSpaces(line.replace(/^OPERADOR:\s*/i, ""))
        };
      }

      return { role: "contexto", text: line };
    });
}

function formatContextLines(lines = []) {
  return lines
    .slice(-MAX_CONTEXT_LINES)
    .map((line) => {
      if (line.role === "clienta") return `CLIENTA: ${line.text}`;
      if (line.role === "operador") return `OPERADOR: ${line.text}`;
      return `CONTEXTO: ${line.text}`;
    })
    .join("\n");
}

function getProfileLine(raw = "", label = "") {
  const escaped = escapeRegExp(label);
  const re = new RegExp(`^${escaped}:\\s*(.*)$`, "im");
  const match = String(raw || "").match(re);
  return match ? normalizeSpaces(match[1] || "") : "";
}

function isBadProfileValue(value = "") {
  const clean = normalizeSpaces(value);
  const n = normalizeText(clean);

  if (!clean) return true;
  if (["no disponible", "ninguno", "none", "null", "undefined", "n/a"].includes(n)) return true;
  if (n === "me") return true;

  const labels = [
    "nombre_clienta",
    "pais_clienta",
    "fecha_nacimiento",
    "estado_civil",
    "intereses_en_comun",
    "interested_in",
    "intereses_clienta",
    "looking_for",
    "about_me",
    "about_text",
    "datos_clienta",
    "profile_anchors",
    "raw_profile",
    "about me",
    "bio",
    "interested in",
    "looking for",
    "my content",
    "newsfeed",
    "icebreakers",
    "manage media"
  ];

  return labels.includes(n);
}

function sanitizeProfileValue(value = "", maxLen = 80) {
  const clean = normalizeSpaces(value)
    .replace(/^[-•]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (isBadProfileValue(clean)) return "";
  if (clean.length > maxLen) return clean.slice(0, maxLen).trim();

  return clean;
}

function splitProfileValues(text = "") {
  return dedupeStrings(
    String(text || "")
      .split("|")
      .map((x) => sanitizeProfileValue(x, 90))
      .filter(Boolean)
  );
}

function sanitizeClientName(name = "") {
  const clean = sanitizeProfileValue(name, 40);
  const n = normalizeText(clean);

  if (!clean) return "";
  if (n === "me") return "";
  if (n.startsWith("about ")) return "";
  if (/\d/.test(clean)) return "";
  if (clean.length < 2 || clean.length > 40) return "";

  return clean;
}

function parseProfile(perfil = "") {
  const raw = String(perfil || "");

  const interestedIn = splitProfileValues(getProfileLine(raw, "INTERESTED_IN"));
  const interesesClienta = splitProfileValues(getProfileLine(raw, "INTERESES_CLIENTA"));
  const interesesEnComun = splitProfileValues(getProfileLine(raw, "INTERESES_EN_COMUN"));
  const lookingFor = splitProfileValues(getProfileLine(raw, "LOOKING_FOR"));
  const aboutMe = splitProfileValues(getProfileLine(raw, "ABOUT_ME"));
  const datosClienta = splitProfileValues(getProfileLine(raw, "DATOS_CLIENTA"));

  const profile = {
    nombreClienta: sanitizeClientName(getProfileLine(raw, "NOMBRE_CLIENTA")),
    paisClienta: sanitizeProfileValue(getProfileLine(raw, "PAIS_CLIENTA") || getProfileLine(raw, "UBICACION_CLIENTA"), 60),
    fechaNacimiento: sanitizeProfileValue(getProfileLine(raw, "FECHA_NACIMIENTO"), 40),
    estadoCivil: sanitizeProfileValue(getProfileLine(raw, "ESTADO_CIVIL"), 40),
    interesesEnComun,
    interesesClienta: dedupeStrings([...interestedIn, ...interesesClienta]),
    lookingFor,
    aboutMe,
    aboutText: sanitizeProfileValue(getProfileLine(raw, "ABOUT_TEXT"), 900),
    datosClienta,
    profileAnchors: sanitizeProfileValue(getProfileLine(raw, "PROFILE_ANCHORS"), 300),
    rawProfile: sanitizeProfileValue(getProfileLine(raw, "RAW_PROFILE"), 1200)
  };

  profile.allProfileFacts = dedupeStrings([
    profile.nombreClienta,
    profile.paisClienta,
    profile.fechaNacimiento,
    profile.estadoCivil,
    ...profile.interesesEnComun,
    ...profile.interesesClienta,
    ...profile.lookingFor,
    ...profile.aboutMe,
    profile.aboutText,
    ...profile.datosClienta
  ]).filter(Boolean);

  profile.profileKeywords = extractKeywordSignals(profile.allProfileFacts.join(" "));

  return profile;
}

function hasUsableProfile(profile = {}) {
  return Boolean(
    profile.nombreClienta ||
    profile.paisClienta ||
    profile.estadoCivil ||
    profile.interesesClienta?.length ||
    profile.lookingFor?.length ||
    profile.aboutMe?.length ||
    profile.aboutText ||
    profile.datosClienta?.length
  );
}

function getClientName(caso = {}) {
  return cleanHuman(caso.perfil?.nombreClienta || "");
}

function namePrefix(caso = {}) {
  const name = getClientName(caso);
  return name ? `${name}, ` : "";
}

function pickProfileDetail(perfil = {}, text = "") {
  const joined = normalizeText(text);

  const pool = [
    perfil.aboutText ? { type: "about_text", value: perfil.aboutText, priority: 120 } : null,
    ...(perfil.aboutMe || []).map((value) => ({ type: "about_me", value, priority: 100 })),
    ...(perfil.interesesClienta || []).map((value) => ({ type: "interes_clienta", value, priority: 90 })),
    ...(perfil.lookingFor || []).map((value) => ({ type: "looking_for", value, priority: 80 })),
    ...(perfil.interesesEnComun || []).map((value) => ({ type: "interes_comun", value, priority: 70 })),
    ...(perfil.datosClienta || []).map((value) => ({ type: "dato_clienta", value, priority: 60 }))
  ].filter((x) => x && x.value && !isBadProfileValue(x.value));

  for (const item of pool) {
    const key = normalizeText(item.value);
    if (key && joined.includes(key)) return item;
  }

  pool.sort((a, b) => b.priority - a.priority);

  if (pool.length) return pool[0];
  if (perfil.paisClienta) return { type: "pais", value: perfil.paisClienta, priority: 50 };
  if (perfil.estadoCivil) return { type: "estado_civil", value: perfil.estadoCivil, priority: 40 };

  return { type: "none", value: "", priority: 0 };
}

function inferContactType(chatSignals = {}, contextLines = []) {
  const hasDialog = contextLines.some(
    (x) => x.role === "clienta" || x.role === "operador"
  );

  if (
    hasDialog ||
    chatSignals.total_clienta_visible > 0 ||
    chatSignals.total_operador_visible > 0
  ) {
    return "viejo";
  }

  return "nuevo";
}

function getLastDialogRole(contextLines = []) {
  const line = [...contextLines].reverse().find(
    (x) => x.role === "clienta" || x.role === "operador"
  );
  return line?.role || "";
}

function detectMode({ textoPlano = "", clientePlano = "", contextLines = [], chatSignals = {} }) {
  const clientCount = contextLines.filter((x) => x.role === "clienta").length;
  const operatorCount = contextLines.filter((x) => x.role === "operador").length;
  const lastDialogRole = getLastDialogRole(contextLines);

  if (clientCount === 0 && operatorCount > 0) {
    return "APERTURA_SIN_RESPUESTA";
  }

  if (
    (chatSignals.total_clienta_visible || 0) === 0 &&
    (chatSignals.total_operador_visible || 0) > 0
  ) {
    return "APERTURA_SIN_RESPUESTA";
  }

  if (
    (chatSignals.ultimo_role_visible === "clienta" && chatSignals.hay_clienta_visible) ||
    (clientePlano && lastDialogRole === "clienta")
  ) {
    return "RESPUESTA_CHAT";
  }

  if (
    chatSignals.solo_operador_visible ||
    chatSignals.ultimo_role_visible === "operador"
  ) {
    return "REAPERTURA_SUAVE";
  }

  if (
    /\b(sigues ahi|no respondes|desapareciste|me dejaste en visto|retomar|retomo)\b/.test(
      normalizeText(textoPlano)
    )
  ) {
    return "REAPERTURA_SUAVE";
  }

  return contextLines.length ? "REAPERTURA_SUAVE" : "APERTURA_FRIA";
}

function detectRisks({ textoPlano = "", clientePlano = "", contextoPlano = "" }) {
  const text = normalizeText(
    [textoPlano, clientePlano, contextoPlano].filter(Boolean).join("\n")
  );

  const seen = new Set();
  const risks = [];

  const pushRisk = (risk) => {
    if (!risk || seen.has(risk.key)) return;
    seen.add(risk.key);
    risks.push(risk);
  };

  const hasContactWords = /\b(whatsapp|telegram|instagram|insta|snapchat|snap|discord|facebook|tiktok|twitter|numero|telefono|phone|mail|email|correo)\b/.test(text);
  const hasOffAppWords = /\b(fuera de la app|por otra app|otra app|outside the app|text me|call me|add me|escribeme|pasame|pasa tu|dame tu|te dejo mi|my number|mi numero|mi telefono)\b/.test(text);
  if (hasContactWords || hasOffAppWords) {
    pushRisk(RISK_CATALOG.contacto_externo);
  }

  const hasPaymentWords = /\b(gratis|gratuito|free|premium|suscripcion|subscription|tokens|coins|credits|billing|pago|pagar|pay|cuesta|cobra|cobran)\b/.test(text);
  const hasPlatformWords = /\b(plataforma|platform|app|cuenta|account|usuario|user)\b/.test(text);
  if (hasPaymentWords && hasPlatformWords) {
    pushRisk(RISK_CATALOG.pregunta_pago_plataforma);
  }

  const hasSocialWords = /\b(instagram|insta|facebook|tiktok|snapchat|snap|twitter|redes sociales|social media)\b/.test(text);
  const hasFoundWords = /\b(encontre|vi|found|i found|te vi|saw|tu perfil|your profile|outside|afuera)\b/.test(text);
  if (hasSocialWords && hasFoundWords) {
    pushRisk(RISK_CATALOG.redes_externas);
  }

  const hasRhythmWords = /\b(no puedo seguir el ritmo|no puedo mantener el ritmo|cant keep up|cannot keep up|too fast|demasiado rapido|mucha intensidad|me abruma|me supera|no tengo tiempo|sin tiempo|busy|ocupad[oa]|hablamos luego|talk later)\b/.test(text);
  const hasLeaveContactWords = /\b(te dejo mi|mi numero|mi telefono|whatsapp|telegram|email|correo)\b/.test(text);
  if (hasRhythmWords || (hasLeaveContactWords && /\b(no puedo|sin tiempo|ocupad[oa]|busy|ritmo)\b/.test(text))) {
    pushRisk(RISK_CATALOG.abandono_ritmo_contacto);
  }

  const hasDistrustWords = /\b(fake|falso|falsa|real|eres real|scam|estafa|bot|catfish)\b/.test(text);
  if (hasDistrustWords) {
    pushRisk(RISK_CATALOG.desconfianza_realidad);
  }

  risks.sort((a, b) => b.severity - a.severity || a.label.localeCompare(b.label));

  return {
    primary: risks[0] || {
      key: "none",
      label: "Sin riesgo especial",
      severity: 0,
      guidance: "Mantener una conversacion natural y util dentro del chat."
    },
    all: risks
  };
}

function detectIntent(caso = {}) {
  if (caso.risk?.primary?.key === "pregunta_pago_plataforma") {
    return "ACLARAR_Y_REDIRECCIONAR";
  }

  if (
    caso.risk?.primary?.key === "contacto_externo" ||
    caso.risk?.primary?.key === "redes_externas"
  ) {
    return "CONTENER_Y_MANTENER_AQUI";
  }

  if (caso.risk?.primary?.key === "abandono_ritmo_contacto") {
    return "RETENER_SIN_PRESION";
  }

  if (caso.risk?.primary?.key === "desconfianza_realidad") {
    return "DAR_CONFIANZA";
  }

  if (caso.mode === "APERTURA_FRIA") return "ENGANCHAR";
  if (caso.mode === "APERTURA_SIN_RESPUESTA") return "ABRIR_CON_PERFIL";
  if (caso.mode === "REAPERTURA_SUAVE") return "REENGANCHAR";

  return "MANTENER_CONVERSACION";
}

function detectObjective(caso = {}) {
  switch (caso.intent) {
    case "ACLARAR_Y_REDIRECCIONAR":
      return "Aclarar sin inventar politicas ni pagos y mantener viva la conversacion dentro del chat";
    case "CONTENER_Y_MANTENER_AQUI":
      return "Redirigir con naturalidad para seguir aqui sin sonar cortante";
    case "RETENER_SIN_PRESION":
      return "Bajar intensidad, validar el ritmo y evitar que la conversacion se caiga";
    case "DAR_CONFIANZA":
      return "Reducir desconfianza con una respuesta clara, humana y nada defensiva";
    case "ABRIR_CON_PERFIL":
      return "Abrir conversacion desde datos reales del perfil sin fingir confianza previa";
    case "ENGANCHAR":
      return "Abrir con curiosidad concreta usando perfil o contexto real";
    case "REENGANCHAR":
      return "Reabrir sin reclamo usando perfil o un dato real para dar motivo de respuesta";
    default:
      return "Responder lo ultimo de ella y avanzar con un gancho claro";
  }
}

function detectTone(caso = {}) {
  switch (caso.risk?.primary?.key) {
    case "pregunta_pago_plataforma":
      return "claro, prudente y natural";
    case "contacto_externo":
    case "redes_externas":
      return "calido, firme y relajado";
    case "abandono_ritmo_contacto":
      return "tranquilo, empatico y sin presion";
    case "desconfianza_realidad":
      return "claro, sereno y humano";
    default:
      break;
  }

  if (caso.mode === "APERTURA_FRIA") return "ligero, curioso y humano";
  if (caso.mode === "APERTURA_SIN_RESPUESTA") return "natural, respetuoso y basado en perfil";
  if (caso.mode === "REAPERTURA_SUAVE") return "suave, relajado y sin reclamo";
  return "natural, calido y util";
}

function extractKeywordSignals(text = "") {
  const counts = new Map();

  for (const word of normalizeText(text).split(/\s+/)) {
    if (!word) continue;
    if (word.length < 4) continue;
    if (STOPWORDS_SUGGESTIONS.has(word)) continue;
    if (BANNED_TOPIC_WORDS.has(word)) continue;
    if (!/^[a-z0-9]+$/i.test(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word]) => word);
}

function keywordOverlap(text = "", keywords = []) {
  const set = new Set(normalizeText(text).split(/\s+/).filter(Boolean));
  let total = 0;

  for (const keyword of keywords) {
    const parts = normalizeText(keyword).split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (parts.every((part) => set.has(part))) total += 1;
  }

  return total;
}

function countEndearments(text = "") {
  return (String(text || "").match(OVER_AFFECTION_REGEX) || []).length;
}

function talksAboutClientInThirdPerson(text = "", caso = {}) {
  const n = normalizeText(text);
  const name = normalizeText(caso.perfil?.nombreClienta || "");

  if (THIRD_PERSON_GENERIC_REGEX.test(n)) return true;

  if (name) {
    const badStarts = [
      `${name} parece`,
      `${name} suena`,
      `${name} es una`,
      `${name} es alguien`,
      `la historia de ${name}`,
      `la vida de ${name}`,
      `el perfil de ${name}`
    ];

    if (badStarts.some((x) => n.startsWith(x))) return true;
  }

  return false;
}

function addressesClientDirectly(text = "", caso = {}) {
  const n = normalizeText(text);
  const name = normalizeText(caso.perfil?.nombreClienta || "");

  if (name && n.startsWith(`${name},`)) return true;
  if (/\b(vi que|me llamo la atencion|me dio curiosidad|note que|entiendo que|imagino que|me gusta que)\b/.test(n)) return true;

  return false;
}

function getSuggestionMemoryKey(caso = {}) {
  return [
    normalizeText(caso.operador || "anon").slice(0, 80),
    normalizeText(caso.mode || "x"),
    normalizeText(caso.textoPlano || "").slice(0, 220),
    normalizeText(caso.clientePlano || "").slice(0, 180),
    normalizeText(caso.contextoPlano || "").slice(-260),
    normalizeText(caso.perfil?.profileAnchors || "").slice(0, 220),
    normalizeText(caso.perfil?.aboutText || "").slice(0, 220)
  ].join("||");
}

function pruneSuggestionMemory() {
  const now = Date.now();

  for (const [key, entry] of recentSuggestionMemory.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentSuggestionMemory.delete(key);
    }
  }

  while (recentSuggestionMemory.size > SUGGESTION_MEMORY_LIMIT) {
    const oldestKey = recentSuggestionMemory.keys().next().value;
    recentSuggestionMemory.delete(oldestKey);
  }
}

function readRecentSuggestions(memoryKey = "") {
  pruneSuggestionMemory();
  const entry = recentSuggestionMemory.get(memoryKey);
  if (!entry) return [];

  if (entry.expiresAt <= Date.now()) {
    recentSuggestionMemory.delete(memoryKey);
    return [];
  }

  return Array.isArray(entry.values) ? entry.values : [];
}

function writeRecentSuggestions(memoryKey = "", values = []) {
  if (!memoryKey || !values.length) return;

  pruneSuggestionMemory();
  recentSuggestionMemory.set(memoryKey, {
    values: values.slice(0, 9),
    expiresAt: Date.now() + SUGGESTION_MEMORY_TTL_MS
  });
}

function cleanSuggestion(text = "") {
  return cleanHuman(
    String(text ?? "")
      .replace(/^\s*\d+[\).\-\s:]*/, "")
      .replace(/^\s*[•\-–—]+\s*/, "")
      .replace(/\s+([,.;!?])/g, "$1")
  );
}

function extractOptions(raw = "") {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const options = [];
  const regex = /(?:^|\n)\s*\d+\s*[\.\)\-:]\s*([\s\S]*?)(?=(?:\n\s*\d+\s*[\.\)\-:])|$)/g;

  let match;
  while ((match = regex.exec(text))) {
    const item = cleanSuggestion(match[1]);
    if (item) options.push(item);
  }

  if (options.length) return options;

  return text
    .split(/\n+/)
    .map((line) => cleanSuggestion(line))
    .filter(Boolean);
}

function scoreLength(length = 0, spec = {}) {
  const min = Number(spec.min || MIN_RESPONSE_LENGTH);
  const max = Number(spec.max || min + 100);
  const ideal = Number(spec.ideal || Math.round((min + max) / 2));

  if (length < MIN_RESPONSE_LENGTH) return 0;

  if (length >= min && length <= max) {
    const span = Math.max(1, Math.max(ideal - min, max - ideal));
    const dist = Math.abs(length - ideal);
    return Math.max(0, Math.min(1, 1 - ((dist / span) * 0.35)));
  }

  if (length < min) {
    const gap = min - length;
    return Math.max(0, Math.min(1, 0.50 - (gap / Math.max(1, min))));
  }

  const gap = length - max;
  return Math.max(0, Math.min(1, 0.65 - (gap / Math.max(1, max))));
}

function looksTooSimilar(a = "", b = "") {
  const na = normalizeText(a);
  const nb = normalizeText(b);

  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const setA = new Set(na.split(/\s+/).filter(Boolean));
  const wordsB = nb.split(/\s+/).filter(Boolean);
  if (!wordsB.length) return false;

  const overlap = wordsB.filter((w) => setA.has(w)).length;
  return overlap / wordsB.length >= 0.8;
}

function isSuggestionForbidden(suggestion = "", caso = {}) {
  const s = cleanSuggestion(suggestion);
  const n = normalizeText(s);

  if (!s) return true;
  if (countChars(s) < MIN_RESPONSE_LENGTH) return true;
  if (countQuestions(s) > 1) return true;
  if (INTERNAL_LABEL_REGEX.test(s)) return true;
  if (DISALLOWED_CONTACT_REGEX.test(n)) return true;
  if (DISALLOWED_MEET_REGEX.test(n)) return true;
  if (META_REGEX.test(n)) return true;
  if (talksAboutClientInThirdPerson(s, caso)) return true;

  if (caso.mode === "APERTURA_SIN_RESPUESTA" && FALSE_FAMILIARITY_REGEX.test(n)) {
    return true;
  }

  if (caso.mode !== "APERTURA_FRIA" && EMPTY_GENERIC_START_REGEX.test(n) && countChars(s) < 130) {
    return true;
  }

  return false;
}

function scoreSuggestion(suggestion = "", caso = {}, index = 0) {
  if (isSuggestionForbidden(suggestion, caso)) return 0;

  const s = cleanSuggestion(suggestion);
  const n = normalizeText(s);
  const length = countChars(s);
  const spec = TARGET_SUGGESTION_SPECS[Math.min(index, TARGET_SUGGESTION_SPECS.length - 1)];

  let score = 0;

  score += scoreLength(length, spec) * 0.34;
  score += countQuestions(s) <= 1 ? 0.08 : -0.15;

  const overlapClient = keywordOverlap(s, caso.clientKeywords || []);
  const overlapDraft = keywordOverlap(s, caso.draftKeywords || []);
  const overlapDetail = keywordOverlap(s, caso.detailKeywords || []);
  const overlapOperator = keywordOverlap(s, caso.operatorKeywords || []);
  const overlapThemes = keywordOverlap(s, caso.activeThemes || []);
  const overlapProfile = keywordOverlap(s, caso.profileKeywords || []);

  if (caso.mode === "RESPUESTA_CHAT") {
    score += overlapClient > 0 ? 0.16 : -0.08;
    score += overlapOperator > 0 ? 0.07 : 0;
  } else {
    score += (overlapDraft > 0 || overlapDetail > 0 || overlapOperator > 0) ? 0.10 : 0;
  }

  if (caso.profileAvailable) {
    score += overlapProfile > 0 ? 0.22 : -0.10;
    score += addressesClientDirectly(s, caso) ? 0.08 : -0.05;
  }

  if (caso.mode === "APERTURA_SIN_RESPUESTA") {
    score += FALSE_FAMILIARITY_REGEX.test(n) ? -0.40 : 0.08;
  }

  if (overlapThemes > 0) score += 0.07;
  if (caso.detallePerfil?.value && overlapDetail > 0) score += 0.06;

  if (EMPTY_MIRROR_REGEX.test(n)) score -= 0.18;
  if (ONE_WORD_MIRROR_REGEX.test(n)) score -= 0.20;
  if (EMPTY_GENERIC_START_REGEX.test(n) && caso.mode !== "APERTURA_FRIA") score -= 0.10;

  if (
    ["contacto_externo", "redes_externas"].includes(caso.risk?.primary?.key) &&
    /\b(aqui|por aqui|por este chat|por el chat)\b/.test(n)
  ) {
    score += 0.12;
  }

  if (
    caso.risk?.primary?.key === "abandono_ritmo_contacto" &&
    /\b(con calma|sin presion|a tu ritmo|tranqui)\b/.test(n)
  ) {
    score += 0.12;
  }

  if (
    caso.risk?.primary?.key === "desconfianza_realidad" &&
    /\b(real|claro|natural)\b/.test(n)
  ) {
    score += 0.08;
  }

  if (
    caso.risk?.primary?.key === "pregunta_pago_plataforma" &&
    /\b(prefiero no inventar|no quiero inventarte|sin inventar)\b/.test(n)
  ) {
    score += 0.10;
  }

  if (caso.affectionLoadHigh && countEndearments(s) >= 2) {
    score -= 0.08;
  }

  if (caso.mode === "RESPUESTA_CHAT" && caso.lastClientIsQuestion && overlapClient === 0) {
    score -= 0.08;
  }

  return Math.max(0, Math.min(1, score));
}

function mapOptionsToCandidates(options = [], source = "", caso = {}) {
  return dedupeStrings(options)
    .map((text, index) => {
      const clean = cleanSuggestion(text);
      return {
        text: clean,
        source,
        length: countChars(clean),
        sourceIndex: index,
        score: scoreSuggestion(clean, caso, index)
      };
    })
    .filter((item) => item.text && item.score > 0);
}

function selectFinalCandidates(pool = []) {
  const ranked = [...pool].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.length !== a.length) return b.length - a.length;
    return a.text.localeCompare(b.text);
  });

  const selected = [];

  for (let slot = 0; slot < TARGET_SUGGESTION_SPECS.length; slot += 1) {
    const spec = TARGET_SUGGESTION_SPECS[slot];

    let candidate = ranked.find((item) => {
      if (selected.some((x) => looksTooSimilar(x.text, item.text))) return false;
      return item.length >= spec.min && item.length <= spec.max;
    });

    if (!candidate) {
      candidate = ranked.find((item) => {
        if (selected.some((x) => looksTooSimilar(x.text, item.text))) return false;
        return item.length >= Math.round(spec.min * 0.75) && item.length <= Math.round(spec.max * 1.2);
      });
    }

    if (!candidate) {
      candidate = ranked.find((item) => {
        return !selected.some((x) => looksTooSimilar(x.text, item.text));
      });
    }

    if (candidate) {
      selected.push(candidate);
    }
  }

  return selected.slice(0, 3);
}

function isWeakResult(candidates = [], selected = []) {
  if (selected.length < 3) return true;

  const avg = selected.reduce((sum, item) => sum + item.score, 0) / selected.length;
  if (avg < 0.58) return true;

  for (let i = 0; i < selected.length; i += 1) {
    const spec = TARGET_SUGGESTION_SPECS[i];
    const item = selected[i];
    if (!item) return true;

    if (item.length < Math.round(spec.min * 0.75)) return true;
    if (i === 2 && item.length < 230) return true;
  }

  return false;
}

function buildWeaknessFeedback(candidates = [], caso = {}) {
  const notes = [];

  if (!candidates.length) {
    notes.push("- No salieron opciones utilizables.");
  }

  const avgLength = candidates.length
    ? candidates.reduce((sum, item) => sum + item.length, 0) / candidates.length
    : 0;

  if (avgLength && avgLength < 180) {
    notes.push("- Las opciones estan demasiado cortas.");
  }

  if (
    caso.profileAvailable &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.profileKeywords || []) === 0)
  ) {
    notes.push("- Falta usar datos reales del perfil. Cada opcion debe apoyarse en 1 o 2 datos del perfil si estan disponibles.");
  }

  if (
    candidates.length &&
    candidates.some((item) => INTERNAL_LABEL_REGEX.test(item.text))
  ) {
    notes.push("- No uses etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME o PROFILE_ANCHORS.");
  }

  if (
    candidates.length &&
    candidates.some((item) => talksAboutClientInThirdPerson(item.text, caso))
  ) {
    notes.push("- No hables sobre la clienta en tercera persona. Habla directamente con ella.");
  }

  if (
    caso.mode === "APERTURA_SIN_RESPUESTA" &&
    candidates.length &&
    candidates.some((item) => FALSE_FAMILIARITY_REGEX.test(normalizeText(item.text)))
  ) {
    notes.push("- No finjas confianza previa. No digas 'nuestras conversaciones', 'me acorde de ti' ni 'lo que hablamos'.");
  }

  if (
    caso.mode === "RESPUESTA_CHAT" &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.clientKeywords || []) === 0)
  ) {
    notes.push("- Falta alusion real a lo ultimo de la clienta.");
  }

  if (
    candidates.length &&
    candidates.some((item) => ONE_WORD_MIRROR_REGEX.test(normalizeText(item.text)))
  ) {
    notes.push("- Evita formulas tipo 'eso que dijiste sobre X' o 'ahi en lo de X'.");
  }

  if (!notes.length) {
    notes.push("- Hazlas mas especificas, mas utiles y menos genericas.");
  }

  notes.push("- Recuerda: opcion 1 de 150 a 200 caracteres, opcion 2 de 200 a 300, opcion 3 de 250 a 400.");

  return notes.join("\n");
}

function buildSpecText() {
  return TARGET_SUGGESTION_SPECS
    .map((spec, index) => `${index + 1}. ${spec.min}-${spec.max} caracteres`)
    .join("\n");
}

function buildSystemPrompt(caso = {}) {
  const name = caso.perfil?.nombreClienta || "la clienta";

  return [
    "Eres el motor de sugerencias de una herramienta interna de chat.",
    "Debes devolver exactamente 3 opciones finales en espanol, listas para enviar.",
    "Tu trabajo es transformar el borrador del operador en mensajes directos para la clienta.",
    "",
    "REGLA CENTRAL",
    "- el borrador del operador NO es una pregunta para ti",
    "- el borrador del operador es una intencion mal escrita que debes convertir en un mensaje listo para enviar",
    `- escribe directamente a ${name}, no hables sobre ella en tercera persona`,
    "- prohibido escribir frases tipo: 'La historia de Gabriela...', 'Gabriela parece...', 'La vida de Gabriela...'",
    "- prohibido usar etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME, ABOUT_TEXT, RAW_PROFILE o PROFILE_ANCHORS",
    "- si hay nombre disponible, puedes iniciar con el nombre de forma natural",
    "",
    `Objetivo principal: ${caso.objective}`,
    `Tono: ${caso.tone}`,
    `Modo: ${caso.mode}`,
    `Riesgo primario: ${caso.risk?.primary?.label || "Sin riesgo especial"}`,
    "",
    "SI EL MODO ES APERTURA_SIN_RESPUESTA",
    "- significa que hay mensajes previos del operador pero la clienta no ha contestado",
    "- no finjas que ya hubo conversacion real",
    "- prohibido decir: nuestras conversaciones, lo que hablamos, me acorde de ti, como me dijiste, seguimos donde quedamos",
    "- usa el perfil como ancla principal",
    "",
    "USO DEL PERFIL",
    "- si hay ABOUT_TEXT, ese texto personal tiene prioridad alta",
    "- si hay datos reales de perfil, usalos como fuente principal cuando el chat esta vacio, viejo o con poco dialogo",
    "- cada opcion debe apoyarse en 1 o 2 datos reales del perfil si existen",
    "- prioriza ABOUT_TEXT, personalidad visible, intereses, lo que busca y pais",
    "- usa estado civil solo si la intencion habla de amor, confianza, pasado, nueva etapa o conexion emocional",
    "- no inventes viudez, divorcio, hijos, ciudad, pais ni intenciones",
    "- si el perfil dice Married, no lo conviertas en Divorced o Widowed",
    "- si el perfil dice Divorced, no lo conviertas en Widowed",
    "- no uses todos los datos juntos; elige los mas naturales",
    "",
    "NUCLEO DE TRANSFORMACION",
    "- interpreta la intencion del operador antes de escribir",
    "- no copies frases debiles del operador",
    "- si el operador escribe algo generico, conserva la intencion y vuelve el mensaje especifico",
    "- si el operador intenta sonar interesado, hazlo mas natural y menos necesitado",
    "- si el operador intenta reenganchar, evita suplica, culpa o ansiedad",
    "- si el operador intenta coquetear, hazlo sutil, conversacional y no repetitivo",
    "- si hay riesgo, sal de la situacion sin cortar el vinculo ni perder la conversacion",
    "",
    "PRIORIDADES",
    "- responder primero a lo ultimo de la clienta cuando exista mensaje real",
    "- si no hay mensaje nuevo de la clienta, usar perfil como ancla principal",
    "- conservar el hilo que el operador ya viene construyendo sin inventar respuesta de ella",
    "- sonar humano, concreto y util",
    "- usar hechos reales del chat o perfil antes que frases genericas",
    "- dejar una salida facil para que la clienta responda",
    "",
    "REGLAS OBLIGATORIAS",
    "- si no existe mensaje nuevo de la clienta, no escribas como si ya hubiera contestado",
    "- cada opcion debe ser distinta de verdad",
    "- maximo 1 pregunta por opcion",
    "- sin emojis",
    "- sin comillas",
    "- sin nombres inventados",
    "- sin ciudades inventadas",
    "- no inventes politicas, pagos, tarifas, soporte ni condiciones de la plataforma",
    "- no pidas ni aceptes contacto externo",
    "- no invites a salir de la app",
    "- no propongas encuentros, direcciones ni llamadas",
    "- evita presion, culpa o manipulacion",
    "- evita frases espejo o vacias",
    "- evita formulas como 'eso que dijiste sobre X' si X es solo una palabra suelta",
    "- si el borrador esta flojo, rehacelo por completo",
    "",
    "VARIACION DESEADA",
    "1. Directa: 150 a 200 caracteres. Clara, natural y facil de enviar.",
    "2. Atractiva: 200 a 300 caracteres. Mejor alusion al contexto o perfil y una respuesta facil de continuar.",
    "3. Desarrollada: 250 a 400 caracteres. Mayor profundidad emocional, mejor lectura del perfil/contexto y un gancho mas fuerte, sin sonar intensa ni pesada.",
    "",
    "IMPORTANTE SOBRE LONGITUD",
    "- respeta el rango de caracteres de cada opcion",
    "- no hagas opciones demasiado cortas",
    "- la tercera opcion nunca debe ser breve",
    "- extender no significa rellenar; extender significa usar perfil o contexto real",
    "",
    "LARGO EXACTO ESPERADO",
    buildSpecText(),
    "",
    "Devuelve solo:",
    "1. ...",
    "2. ...",
    "3. ..."
  ].join("\n").trim();
}

function buildUserPrompt(caso = {}, recent = [], previousOptions = [], feedback = "") {
  const blocks = [
    [
      "RESUMEN DEL CASO",
      `- tipo de contacto: ${caso.tipoContacto}`,
      `- intencion detectada: ${caso.intent}`,
      `- objetivo: ${caso.objective}`,
      `- tono: ${caso.tone}`,
      `- modo: ${caso.mode}`,
      `- riesgo primario: ${caso.risk?.primary?.label || "Sin riesgo especial"}`,
      `- guia de riesgo: ${caso.risk?.primary?.guidance || "Mantener conversacion natural y util"}`
    ].join("\n"),
    [
      "BORRADOR DEL OPERADOR",
      '"""',
      caso.textoPlano || "Sin borrador claro",
      '"""'
    ].join("\n"),
    [
      "ULTIMO MENSAJE REAL DE LA CLIENTA",
      '"""',
      caso.clientePlano || "Sin mensaje claro de la clienta",
      '"""'
    ].join("\n"),
    [
      "CONTEXTO RECIENTE",
      '"""',
      caso.contextoPlano || "Sin contexto util",
      '"""'
    ].join("\n"),
    [
      "HILO DEL OPERADOR",
      (caso.operatorRecent || []).length
        ? caso.operatorRecent.map((x, i) => `${i + 1}. ${x}`).join("\n")
        : "Sin mensajes recientes del operador"
    ].join("\n"),
    [
      "HILO DE LA CLIENTA",
      (caso.clientRecent || []).length
        ? caso.clientRecent.map((x, i) => `${i + 1}. ${x}`).join("\n")
        : "Sin mensajes recientes de la clienta"
    ].join("\n"),
    [
      "PERFIL REAL DISPONIBLE",
      `- nombre: ${caso.perfil?.nombreClienta || ""}`,
      `- pais: ${caso.perfil?.paisClienta || ""}`,
      `- fecha nacimiento: ${caso.perfil?.fechaNacimiento || ""}`,
      `- estado civil: ${caso.perfil?.estadoCivil || ""}`,
      `- intereses: ${(caso.perfil?.interesesClienta || []).join(" | ")}`,
      `- busca: ${(caso.perfil?.lookingFor || []).join(" | ")}`,
      `- personalidad visible: ${(caso.perfil?.aboutMe || []).join(" | ")}`,
      `- texto personal: ${caso.perfil?.aboutText || ""}`
    ].join("\n"),
    [
      "KEYWORDS",
      `- clienta: ${(caso.clientKeywords || []).join(" | ") || "ninguna"}`,
      `- operador: ${(caso.operatorKeywords || []).join(" | ") || "ninguna"}`,
      `- perfil: ${(caso.profileKeywords || []).join(" | ") || "ninguna"}`,
      `- temas activos: ${(caso.activeThemes || []).join(" | ") || "ninguno"}`
    ].join("\n"),
    [
      "RESPUESTAS RECIENTES A EVITAR",
      recent.length
        ? recent.map((x, i) => `${i + 1}. ${x}`).join("\n")
        : "ninguna"
    ].join("\n")
  ];

  if (previousOptions.length) {
    blocks.push([
      "OPCIONES ANTERIORES FLOJAS",
      previousOptions.map((x, i) => `${i + 1}. ${x}`).join("\n")
    ].join("\n"));
  }

  if (feedback) {
    blocks.push([
      "CORRECCIONES QUE DEBES APLICAR",
      feedback
    ].join("\n"));
  }

  blocks.push([
    "INTERPRETACION DEL BORRADOR",
    "Antes de generar, decide mentalmente:",
    "1. que quiere lograr el operador",
    "2. que datos reales del perfil conviene usar",
    "3. que parte del borrador debe eliminarse por generica, repetitiva o riesgosa",
    "4. como hablarle directamente a la clienta sin hablar sobre ella en tercera persona",
    "5. si no hay respuesta de la clienta, no finjas familiaridad previa"
  ].join("\n"));

  blocks.push([
    "IMPORTANTE",
    "- habla directamente con la clienta",
    "- no digas 'La historia de Gabriela' ni 'Gabriela parece'",
    "- no uses etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME, ABOUT_TEXT, RAW_PROFILE o PROFILE_ANCHORS",
    "- si hay ABOUT_TEXT, usalo como dato emocional de alta prioridad",
    "- si hay perfil, usa perfil real como base",
    "- no copies el borrador si esta pobre",
    "- no inventes datos",
    "- deja una salida facil para que la otra persona responda",
    "- manten todo dentro de la plataforma",
    "- opcion 1: 150-200 caracteres",
    "- opcion 2: 200-300 caracteres",
    "- opcion 3: 250-400 caracteres"
  ].join("\n"));

  return blocks.join("\n\n").trim();
}

function pickTemperature(caso = {}, isRepair = false) {
  let t = 0.76;

  if (caso.mode === "APERTURA_FRIA") t = 0.82;
  if (caso.mode === "APERTURA_SIN_RESPUESTA") t = 0.76;
  if (caso.mode === "REAPERTURA_SUAVE") t = 0.78;
  if (caso.mode === "RESPUESTA_CHAT") t = 0.70;

  switch (caso.risk?.primary?.key) {
    case "pregunta_pago_plataforma":
      t = 0.60;
      break;
    case "contacto_externo":
    case "redes_externas":
      t = 0.68;
      break;
    case "abandono_ritmo_contacto":
      t = 0.66;
      break;
    case "desconfianza_realidad":
      t = 0.64;
      break;
    default:
      break;
  }

  if (isRepair) {
    return Math.max(0.56, Math.min(0.86, t - 0.08));
  }

  return Math.max(0.56, Math.min(0.86, t));
}

function buildProfileBasedFallbacks(caso = {}) {
  const name = namePrefix(caso);
  const profile = caso.perfil || {};
  const aboutText = profile.aboutText || "";
  const about = profile.aboutMe || [];
  const interests = profile.interesesClienta || [];
  const looking = profile.lookingFor || [];
  const country = profile.paisClienta || "";

  const aboutTextShort = aboutText.length > 180 ? `${aboutText.slice(0, 180).trim()}...` : aboutText;
  const aboutTextTiny = aboutText.length > 95 ? `${aboutText.slice(0, 95).trim()}...` : aboutText;
  const aboutTextMedium = aboutText.length > 135 ? `${aboutText.slice(0, 135).trim()}...` : aboutText;

  const aboutTextLower = normalizeText(aboutText);
  const hasNewChapter = /\b(new chapter|nueva etapa|starting a new chapter|separated|divorcing|divorcio|amistades|friendships|cool friendships)\b/.test(aboutTextLower);

  const aboutTextAngle = hasNewChapter
    ? "una nueva etapa y amistades tranquilas"
    : "algo honesto sobre la etapa que estas viviendo";

  const aboutTextCore = hasNewChapter
    ? "Me gusto porque suena a que buscas algo sin presion, pero con una energia real y tranquila."
    : "Me gusto porque se siente mas humano que una descripcion perfecta y deja ver algo real de ti.";

  const aboutTextQuestion = hasNewChapter
    ? "Que tipo de amistad te hace sentir comoda ahora?"
    : "Que parte de esa etapa te gustaria vivir con mas calma?";

  const aboutTextLong = hasNewChapter
    ? "No lo leo como algo triste, sino como una etapa donde una conversacion simple, honesta y sin presion puede sentirse bastante bien."
    : "No lo tomo como una frase cualquiera, sino como una pista de que hay una historia real detras y una forma mas consciente de ver las cosas.";

  const aboutTextClosing = hasNewChapter
    ? "Me dio curiosidad saber que clase de persona te transmite paz en este momento de tu vida."
    : "Me dio curiosidad saber que tipo de conversacion te hace sentir realmente comoda.";

  if (aboutText) {
    return [
      `${name}lei en tu perfil que estas viviendo ${aboutTextAngle}. ${aboutTextCore} ${aboutTextQuestion}`,
      `${name}me llamo la atencion lo que escribiste: ${aboutTextTiny}. Se siente directo y honesto, no como una frase vacia. ${aboutTextQuestion}`,
      `${name}lei esta parte de tu perfil: ${aboutTextMedium}. ${aboutTextLong} ${aboutTextClosing}`
    ];
  }

  const aboutTextList = about.slice(0, 3).join(", ");
  const interestText = interests.slice(0, 2).join(" y ");
  const lookingText = looking.slice(0, 2).join(", ");

  if (about.length && interests.length) {
    return [
      `${name}vi que te describes como ${aboutTextList} y que te interesa ${interestText}. Eso me dio curiosidad, porque suena a alguien que valora una conversacion real y tranquila.`,
      `${name}me llamo la atencion que entre tus intereses este ${interestText}, y tambien que te describas como ${aboutTextList}. Me gusta cuando un perfil deja ver un poco de personalidad, no solo una foto bonita.`,
      `${name}vi varias cosas en tu perfil que me dieron curiosidad: ${aboutTextList}, y tambien tu interes por ${interestText}. No quiero sonar como un mensaje copiado, pero si me hizo pensar que quizas tienes una forma bonita y bastante consciente de vivir las cosas.`
    ];
  }

  if (interests.length && country) {
    return [
      `${name}vi que estas en ${country} y que te interesa ${interestText}. Eso me dio curiosidad, porque suena a que disfrutas mas las experiencias reales que las conversaciones vacias.`,
      `${name}me llamo la atencion que estes en ${country} y que te guste ${interestText}. Hay algo bonito en las personas que disfrutan ese tipo de cosas, porque suelen tener historias mas interesantes.`,
      `${name}vi que estas en ${country} y que entre tus intereses aparece ${interestText}. Eso me hizo imaginar que quizas valoras los lugares, los momentos y las conversaciones que dejan algo, no solo pasar el rato sin sentido.`
    ];
  }

  if (about.length) {
    return [
      `${name}vi que te describes como ${aboutTextList}. Eso me llamo la atencion porque no todo el mundo muestra esa parte de si mismo desde el perfil.`,
      `${name}me gusto ver que te describes como ${aboutTextList}. Me dio curiosidad saber si esa forma de ser es algo que siempre has tenido o algo que la vida te fue ensenando.`,
      `${name}hay algo de tu perfil que me parecio bonito: ${aboutTextList}. No quiero convertirlo en algo demasiado serio, pero si me hizo pensar que detras de esas palabras debe haber una forma interesante de mirar la vida.`
    ];
  }

  if (looking.length) {
    return [
      `${name}vi un poco lo que buscas aqui: ${lookingText}. Me parecio interesante porque una buena conversacion tambien empieza por saber que tipo de energia espera uno encontrar.`,
      `${name}me llamo la atencion lo que aparece en tu perfil sobre lo que buscas. No lo tomo como una lista fria, sino como una pista de la clase de conexion que podria hacerte sentir comoda.`,
      `${name}vi que tu perfil deja algunas pistas sobre lo que buscas: ${lookingText}. Me gusta cuando alguien no solo aparece por aparecer, sino que parece tener una idea de la clase de persona con la que quiere hablar.`
    ];
  }

  if (country) {
    return [
      `${name}vi que estas en ${country} y me dio curiosidad saber un poco mas de ti. Prefiero empezar por algo real que por una frase generica.`,
      `${name}me llamo la atencion tu perfil y el detalle de ${country}. A veces un dato simple abre una conversacion mas natural que un saludo del monton.`,
      `${name}vi tu perfil y preferi escribirte desde algo mas real que una frase generica. Me dio curiosidad saber que tipo de conversacion te hace sentir mas comoda aqui.`
    ];
  }

  return [];
}

function fallbackRiskSuggestions(caso = {}) {
  const profileFallback = buildProfileBasedFallbacks(caso);

  switch (caso.risk?.primary?.key) {
    case "contacto_externo":
      return [
        `${namePrefix(caso)}prefiero que sigamos por aqui y sin correr. Me interesa mas que la conversacion se sienta real antes que moverla fuera del chat.`,
        `${namePrefix(caso)}podemos llevarlo tranquilo por este chat. Para mi tiene mas sentido ver si la conversacion fluye bien aqui antes que saltar de una app a otra.`,
        profileFallback[2] || `${namePrefix(caso)}antes de mover nada fuera de aqui prefiero ver si de verdad la charla tiene sentido. Me gusta mas descubrir si hay una conexion real que apurar algo que todavia estamos empezando.`
      ];

    case "pregunta_pago_plataforma":
      return [
        `${namePrefix(caso)}sobre como lo maneja la plataforma prefiero no inventarte nada. Lo que si me importa es que por aqui la charla se sienta real.`,
        `${namePrefix(caso)}no quiero darte una respuesta dudosa sobre pagos o cuentas. Prefiero ser claro y seguir con lo que si podemos construir aqui: una conversacion real.`,
        profileFallback[2] || `${namePrefix(caso)}con temas de plataforma prefiero no suponer cosas que no se. Mejor sigamos desde algo mas humano: me interesa saber que te hizo entrar aqui y que clase de conexion esperas encontrar.`
      ];

    case "redes_externas":
      return [
        `${namePrefix(caso)}aunque hayas visto algo fuera, prefiero que lo llevemos por aqui y sin mezclar cosas. Me interesa mas conocerte desde esta conversacion.`,
        `${namePrefix(caso)}yo mantendria la charla por este chat para que sea mas simple y natural. Si algo te dio curiosidad, prefiero que lo hablemos aqui con calma.`,
        profileFallback[2] || `${namePrefix(caso)}antes de cruzar nada con otras redes prefiero que aqui la conversacion se sienta clara y real. Si hay curiosidad, podemos darle espacio sin sacar la charla de aqui.`
      ];

    case "abandono_ritmo_contacto":
      return [
        `${namePrefix(caso)}tranquila, no hace falta llevar esto con prisa ni estar pendiente todo el tiempo. Podemos hablar con calma y ver si la charla se da natural.`,
        `${namePrefix(caso)}si el ritmo te pesa, mejor bajarlo y seguir sin presion. A veces funciona mucho mas una conversacion tranquila que estar encima.`,
        profileFallback[2] || `${namePrefix(caso)}no necesito que respondas rapido ni que esto se vuelva una obligacion. Me basta con que cuando entres aqui la charla se sienta comoda, real y con ganas de seguir.`
      ];

    case "desconfianza_realidad":
      return [
        `${namePrefix(caso)}te respondo simple y claro: prefiero que esto suene natural antes que perfecto. Si algo te genera duda, dimelo directo y lo hablamos.`,
        `${namePrefix(caso)}no me interesa sonar armado ni vender una imagen rara. Prefiero una conversacion clara y normal, de esas que se sostienen solas.`,
        profileFallback[2] || `${namePrefix(caso)}si algo te hace ruido, mejor decirlo de frente y seguir desde ahi. Para mi tiene mas valor una charla clara que una respuesta demasiado ensayada.`
      ];

    default:
      return [];
  }
}

function fallbackReplySuggestions(caso = {}) {
  const profileFallback = buildProfileBasedFallbacks(caso);
  if (profileFallback.length) return profileFallback;

  return [
    `${namePrefix(caso)}me gusto leerte. Quiero que esto vaya por una linea natural, no por frases hechas. Eso que dices te sale mas por intuicion o por experiencia?`,
    `${namePrefix(caso)}suena a que ahi hay una idea real detras. Me dio curiosidad saber si lo ves asi desde hace tiempo o si te paso algo que te hizo pensarlo.`,
    `${namePrefix(caso)}lo que dices tiene un punto interesante. Me gustaria saber si lo sientes asi por caracter o porque ya te toco vivir algo parecido, porque ahi una conversacion empieza a sentirse menos tipica.`
  ];
}

function fallbackReengagementSuggestions(caso = {}) {
  const profileFallback = buildProfileBasedFallbacks(caso);
  if (profileFallback.length) return profileFallback;

  return [
    `${namePrefix(caso)}paso por aqui con una pregunta simple y real: que suele hacer que una conversacion te parezca interesante desde el principio?`,
    `${namePrefix(caso)}en vez de dejar un mensaje mas del monton, prefiero preguntarte algo concreto: que te hace seguir una charla por aqui?`,
    `${namePrefix(caso)}reaparezco con una facil para no sonar copiado: eres mas de conversaciones tranquilas o de gente que entra con un poco mas de chispa y logra sacarte una respuesta real?`
  ];
}

function fallbackOpeningSuggestions(caso = {}) {
  const profileFallback = buildProfileBasedFallbacks(caso);
  if (profileFallback.length) return profileFallback;

  return [
    `${namePrefix(caso)}prefiero empezar con algo simple y real: que tipo de conversacion si te dan ganas de seguir cuando alguien te escribe por aqui?`,
    `${namePrefix(caso)}no quise abrir con una frase vacia, asi que voy con una sencilla: que suele llamar tu atencion cuando alguien te empieza a hablar?`,
    `${namePrefix(caso)}antes que sonar igual que todos, prefiero preguntarte algo directo: eres mas de charlas tranquilas o de gente que entra con mas chispa y logra que la conversacion se sienta diferente?`
  ];
}

function fallbackSuggestions(caso = {}) {
  const risk = fallbackRiskSuggestions(caso);
  if (risk.length) return risk;

  if (caso.mode === "RESPUESTA_CHAT") return fallbackReplySuggestions(caso);
  if (caso.mode === "APERTURA_SIN_RESPUESTA") return fallbackOpeningSuggestions(caso);
  if (caso.mode === "REAPERTURA_SUAVE") return fallbackReengagementSuggestions(caso);

  return fallbackOpeningSuggestions(caso);
}

function emergencySuggestions(caso = {}) {
  const name = namePrefix(caso);
  return [
    `${name}quise escribirte algo mas real que un saludo comun. Me dio curiosidad tu perfil y me gustaria saber que tipo de conversacion te hace sentir comoda por aqui.`,
    `${name}prefiero empezar con algo sencillo y honesto. A veces una buena charla no necesita presion, solo una pregunta que de verdad abra un poco la puerta.`,
    `${name}me dio curiosidad saber un poco mas de ti sin sonar como un mensaje copiado. Me interesa mas una conversacion tranquila y natural que una entrada demasiado perfecta.`
  ];
}

function ensureExactlyThreeSuggestions(selected = [], caso = {}) {
  const final = [];

  const pushClean = (text = "") => {
    const clean = cleanSuggestion(text);
    if (!clean) return;
    if (INTERNAL_LABEL_REGEX.test(clean)) return;
    if (DISALLOWED_CONTACT_REGEX.test(normalizeText(clean))) return;
    if (DISALLOWED_MEET_REGEX.test(normalizeText(clean))) return;
    if (FALSE_FAMILIARITY_REGEX.test(normalizeText(clean)) && caso.mode === "APERTURA_SIN_RESPUESTA") return;
    if (final.some((x) => looksTooSimilar(x, clean))) return;
    final.push(clean);
  };

  for (const item of selected || []) {
    pushClean(typeof item === "string" ? item : item.text);
  }

  for (const item of fallbackSuggestions(caso)) {
    if (final.length >= 3) break;
    pushClean(item);
  }

  for (const item of emergencySuggestions(caso)) {
    if (final.length >= 3) break;
    pushClean(item);
  }

  while (final.length < 3) {
    final.push(emergencySuggestions(caso)[final.length] || emergencySuggestions(caso)[0]);
  }

  if (final.length > 3) {
    return final.slice(0, 3);
  }

  return final;
}

function buildCase(input = {}) {
  const operador = String(input.operador || "").trim();
  const pageType = String(input.page_type || "").trim().toLowerCase();

  const rawContextLines = parseContextLines(input.contexto || "").slice(-MAX_CONTEXT_LINES);
  const contextoPlano = formatContextLines(rawContextLines);

  let clientePlano = cleanSuggestion(String(input.cliente || "").slice(0, 420));
  if (!clientePlano) {
    const lastClient = [...rawContextLines].reverse().find((x) => x.role === "clienta");
    clientePlano = lastClient ? cleanSuggestion(lastClient.text) : "";
  }

  const textoPlano = cleanSuggestion(String(input.texto || "").slice(0, 700));
  const perfil = parseProfile(input.perfil || "");
  const chatSignals = normalizeChatSignals(input.chat_signals || {});

  const mode = detectMode({
    textoPlano,
    clientePlano,
    contextLines: rawContextLines,
    chatSignals
  });

  const risk = detectRisks({
    textoPlano,
    clientePlano,
    contextoPlano
  });

  const tipoContacto = inferContactType(chatSignals, rawContextLines);

  const detallePerfil = pickProfileDetail(
    perfil,
    [
      textoPlano,
      clientePlano,
      contextoPlano,
      perfil.profileAnchors,
      perfil.rawProfile,
      perfil.aboutText
    ].filter(Boolean).join("\n")
  );

  const operatorRecent = rawContextLines
    .filter((x) => x.role === "operador")
    .slice(-5)
    .map((x) => x.text);

  const clientRecent = rawContextLines
    .filter((x) => x.role === "clienta")
    .slice(-5)
    .map((x) => x.text);

  const operatorKeywords = extractKeywordSignals(operatorRecent.join(" "));
  const clientKeywords = extractKeywordSignals(clientePlano || clientRecent.join(" "));
  const draftKeywords = extractKeywordSignals(textoPlano);
  const detailKeywords = detallePerfil?.value ? extractKeywordSignals(detallePerfil.value) : [];
  const profileKeywords = perfil.profileKeywords || [];

  const activeThemes = dedupeStrings([
    ...clientKeywords.slice(0, 4),
    ...operatorKeywords.slice(0, 4),
    ...draftKeywords.slice(0, 4),
    ...profileKeywords.slice(0, 6)
  ]).slice(0, 12);

  const affectionLoadHigh = countEndearments(operatorRecent.join(" ")) >= 4;
  const profileAvailable = hasUsableProfile(perfil);

  const baseCase = {
    operador,
    pageType,
    textoPlano,
    clientePlano,
    contextoPlano,
    contextLines: rawContextLines,
    perfil,
    chatSignals,
    mode,
    tipoContacto,
    risk,
    detallePerfil,
    operatorRecent,
    clientRecent,
    operatorKeywords,
    clientKeywords,
    draftKeywords,
    detailKeywords,
    profileKeywords,
    activeThemes,
    affectionLoadHigh,
    profileAvailable,
    lastClientIsQuestion: /\?/.test(clientePlano || "")
  };

  const intent = detectIntent(baseCase);
  const objective = detectObjective({ ...baseCase, intent });
  const tone = detectTone({ ...baseCase, intent });

  const caso = {
    ...baseCase,
    intent,
    objective,
    tone
  };

  caso.memoryKey = getSuggestionMemoryKey(caso);
  return caso;
}

function buildInFlightSuggestionKey(input = {}) {
  return [
    normalizeText(input.operador || "anon").slice(0, 80),
    normalizeText(input.page_type || "chat"),
    normalizeText(input.texto || "").slice(0, 260),
    normalizeText(input.cliente || "").slice(0, 220),
    normalizeText(input.contexto || "").slice(-320),
    normalizeText(input.perfil || "").slice(0, 520),
    normalizeText(JSON.stringify(input.chat_signals || {})).slice(0, 200)
  ].join("||");
}

async function callSuggestionModel(caso = {}, recent = [], previousOptions = [], feedback = "", isRepair = false) {
  const data = await callOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      { role: "system", content: buildSystemPrompt(caso) },
      { role: "user", content: buildUserPrompt(caso, recent, previousOptions, feedback) }
    ],
    temperature: pickTemperature(caso, isRepair),
    maxTokens: SUGGESTION_MAX_TOKENS,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS,
    topP: 0.95,
    frequencyPenalty: isRepair ? 0.12 : 0.22,
    presencePenalty: isRepair ? 0.04 : 0.10
  });

  return {
    options: extractOptions(data?.choices?.[0]?.message?.content || ""),
    usageData: data
  };
}

async function generateSuggestionsCore(input = {}) {
  const caso = buildCase(input);

  if (caso.pageType && caso.pageType !== "chat") {
    throw new Error("La IA solo funciona en una vista real de chat");
  }

  const recent = readRecentSuggestions(caso.memoryKey);
  const usages = [];
  const pool = [];
  let secondPassUsed = false;

  try {
    const firstPass = await callSuggestionModel(caso, recent);
    if (firstPass.usageData) usages.push(firstPass.usageData);

    const firstCandidates = mapOptionsToCandidates(firstPass.options, "openai_1", caso);
    pool.push(...firstCandidates);

    const selectedFirst = selectFinalCandidates(firstCandidates);

    if (isWeakResult(firstCandidates, selectedFirst)) {
      secondPassUsed = true;
      runtimeStats.suggestions.secondPasses += 1;

      const feedback = buildWeaknessFeedback(firstCandidates, caso);

      const repairPass = await callSuggestionModel(
        caso,
        recent,
        firstPass.options,
        feedback,
        true
      );

      if (repairPass.usageData) usages.push(repairPass.usageData);

      pool.push(...mapOptionsToCandidates(repairPass.options, "openai_2", caso));
    }
  } catch (_err) {
    // Si OpenAI falla, se usa fallback seguro.
  }

  pool.push(...mapOptionsToCandidates(fallbackSuggestions(caso), "fallback", caso));
  pool.push(...mapOptionsToCandidates(emergencySuggestions(caso), "emergency", caso));

  const selected = selectFinalCandidates(pool);
  const final = ensureExactlyThreeSuggestions(selected, caso);

  if (final.length < 3 || selected.length < 3) {
    runtimeStats.suggestions.forcedFill += 1;
  }

  writeRecentSuggestions(caso.memoryKey, final);

  return {
    sugerencias: final,
    usageData: combineUsageData(usages),
    secondPassUsed,
    usedFallbackOnly: selected.length ? selected.every((x) => x.source === "fallback" || x.source === "emergency") : true
  };
}

async function generateSuggestions(input = {}) {
  const sharedJob = getSharedInFlight(
    inflightSuggestionJobs,
    buildInFlightSuggestionKey(input),
    () => runSuggestionQueueByOperator(input.operador || "", () => generateSuggestionsCore(input))
  );

  if (sharedJob.shared) {
    runtimeStats.suggestions.inflightHits += 1;
  }

  const result = await sharedJob.promise;
  return { ...result, shared: sharedJob.shared };
}

/* =========================================================
 * TRANSLATION
 * ======================================================= */

function getTranslationCacheKey(text = "") {
  return normalizeText(text).slice(0, 1200);
}

function readTranslationCache(key = "") {
  if (!key) return "";

  const entry = translationCache.get(key);
  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    translationCache.delete(key);
    return "";
  }

  translationCache.delete(key);
  translationCache.set(key, entry);

  return entry.value || "";
}

function writeTranslationCache(key = "", value = "") {
  if (!key || !value) return;

  if (translationCache.has(key)) {
    translationCache.delete(key);
  }

  translationCache.set(key, {
    value,
    expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS
  });

  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
}

async function translateTextCore(text = "") {
  const data = await callOpenAI({
    lane: "traduccion",
    model: OPENAI_MODEL_TRANSLATE,
    messages: [
      {
        role: "system",
        content: [
          "Traduce al ingles natural de chat como una persona real escribiria.",
          "Reglas:",
          "- no uses comillas",
          "- no uses simbolos raros",
          "- no suenes perfecto ni robotico",
          "- conserva intencion y tono",
          "- devuelve solo una version final"
        ].join("\n")
      },
      { role: "user", content: String(text ?? "") }
    ],
    temperature: 0.25,
    maxTokens: 180,
    timeoutMs: OPENAI_TIMEOUT_TRANSLATE_MS
  });

  const translated = cleanHuman(data?.choices?.[0]?.message?.content || "");

  if (!translated) {
    throw new Error("No se pudo traducir");
  }

  return {
    traducido: translated,
    usageData: data
  };
}

async function translateText(text = "") {
  const sharedJob = getSharedInFlight(
    inflightTranslationJobs,
    getTranslationCacheKey(text),
    () => translateTextCore(text)
  );

  if (sharedJob.shared) {
    runtimeStats.translations.inflightHits += 1;
  }

  const result = await sharedJob.promise;

  return {
    ...result,
    shared: sharedJob.shared
  };
}

/* =========================================================
 * WARNINGS
 * ======================================================= */

function cleanWarningCounts(raw = {}) {
  const clean = {};
  const entries = Object.entries(raw || {}).slice(0, 100);

  for (const [phraseRaw, countRaw] of entries) {
    const phrase = normalizeSpaces(String(phraseRaw || "")).slice(0, 180);
    const count = Math.max(0, Math.min(999999, Number.parseInt(countRaw, 10) || 0));

    if (!phrase || count <= 0) continue;
    clean[phrase] = (clean[phrase] || 0) + count;
  }

  return clean;
}

async function saveWarningSummary({ operador = "", extension_id = "", fecha = "", counts = {} }) {
  const operadorFinal = formatOperatorName(operador || "");
  const fechaFinal = isValidISODate(fecha) ? fecha : formatDateISO(new Date());
  const countsClean = cleanWarningCounts(counts);

  if (!operadorFinal) {
    throw new Error("Operador invalido para warning");
  }

  const phrases = Object.keys(countsClean);
  if (!phrases.length) {
    return { rowsUpserted: 0 };
  }

  const { data: existing, error: readError } = await supabase
    .from("warning_resumen_diario")
    .select("frase,cantidad_total")
    .eq("operador", operadorFinal)
    .eq("fecha", fechaFinal)
    .in("frase", phrases);

  if (readError) {
    throw new Error("No se pudieron leer los warnings existentes");
  }

  const current = new Map();
  for (const row of existing || []) {
    current.set(String(row.frase || ""), Number(row.cantidad_total || 0));
  }

  const payload = phrases.map((phrase) => ({
    operador: operadorFinal,
    extension_id: normalizeSpaces(extension_id) || "",
    fecha: fechaFinal,
    frase: phrase,
    cantidad_total: Number(current.get(phrase) || 0) + Number(countsClean[phrase] || 0),
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

/* =========================================================
 * CONSUMPTION / COST
 * ======================================================= */

async function registerConsumption({
  operador = "",
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
      extension_id: normalizeSpaces(extension_id) || "sin_extension",
      tipo,
      tokens: Number(usage.total_tokens || 0),
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      mensaje_operador: String(mensaje_operador ?? ""),
      mensaje_normalizado: normalizeText(mensaje_operador || ""),
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

function registerConsumptionAsync(payload) {
  setImmediate(async () => {
    try {
      await registerConsumption(payload);
    } catch (err) {
      console.error("Error guardando consumo async:", err.message);
    }
  });
}

function getCostsByType(tipo = "") {
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

function calculateEstimatedCost({ tipo = "", prompt_tokens = 0, completion_tokens = 0 }) {
  const costs = getCostsByType(tipo);

  const inputCost = (safeNumber(prompt_tokens) / 1000000) * costs.input;
  const outputCost = (safeNumber(completion_tokens) / 1000000) * costs.output;

  return roundMoney(inputCost + outputCost);
}

/* =========================================================
 * DASHBOARD / ANALYTICS
 * ======================================================= */

async function loadConsumptionRange(range, operadoresFiltrados = []) {
  return selectAllPages((from, to) => {
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

async function loadWarningsRange(range, operadoresFiltrados = []) {
  return selectAllPages((from, to) => {
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

function createDashboardSummary() {
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

function createOperatorStat(operador = "") {
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

function createSerieDia(fecha = "") {
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

function buildDashboardAnalytics({ consumoRows = [], warningRows = [], range, operadoresFiltrados = [] }) {
  const summary = createDashboardSummary();
  const operatorMap = new Map();
  const warningOperatorTotals = new Map();
  const warningTopMap = new Map();
  const seriesMap = new Map();

  for (const row of consumoRows) {
    const operador = formatOperatorName(row.operador || "anon") || "Anon";
    const tipo = normalizeSpaces(row.tipo || "");
    const totalTokens = safeNumber(row.tokens);
    const promptTokens = safeNumber(row.prompt_tokens);
    const completionTokens = safeNumber(row.completion_tokens);
    const requestOk = row.request_ok !== false;
    const fecha = String(row.created_at || "").slice(0, 10) || range.from;

    const cost = calculateEstimatedCost({
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
      operatorMap.set(operador, createOperatorStat(operador));
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
      seriesMap.set(fecha, createSerieDia(fecha));
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
    const operador = formatOperatorName(row.operador || "anon") || "Anon";
    const frase = normalizeSpaces(row.frase || "");
    const cantidad = safeNumber(row.cantidad_total);
    const fecha = String(row.fecha || "") || range.from;

    summary.warnings_total += cantidad;

    const pairKey = `${operador}||${normalizeText(frase)}`;
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
      seriesMap.set(fecha, createSerieDia(fecha));
    }

    const serie = seriesMap.get(fecha);
    serie.warnings_total += cantidad;
  }

  summary.warnings_unique_pairs = warningTopMap.size;

  for (const [operador, totalWarnings] of warningOperatorTotals.entries()) {
    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, createOperatorStat(operador));
    }

    operatorMap.get(operador).warnings_total = totalWarnings;
  }

  summary.active_operators = operatorMap.size;
  summary.estimated_cost_total = roundMoney(summary.estimated_cost_total);

  const operatorStats = Array.from(operatorMap.values())
    .map((op) => ({
      ...op,
      estimated_cost_total: roundMoney(op.estimated_cost_total)
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
      estimated_cost_total: roundMoney(x.estimated_cost_total)
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

/* =========================================================
 * ADMIN OPERATORS
 * ======================================================= */

function validateAdminOperatorName(name = "") {
  const finalName = formatOperatorName(name);

  if (!finalName) {
    throw new Error("Escribe un nombre valido");
  }

  if (finalName.length < 3) {
    throw new Error("El nombre del operador es demasiado corto");
  }

  if (finalName.length > 80) {
    throw new Error("El nombre del operador es demasiado largo");
  }

  return finalName;
}

async function listOperatorsAdmin() {
  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .order("nombre", { ascending: true });

  if (error) {
    throw new Error("No se pudo leer la lista de operadores");
  }

  return Array.isArray(data) ? data : [];
}

async function findOperatorByNameAdmin(name = "") {
  const finalName = validateAdminOperatorName(name);

  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .ilike("nombre", finalName)
    .limit(10);

  if (error) {
    throw new Error("No se pudo buscar el operador");
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

function summarizeOperators(operators = []) {
  const total = operators.length;
  const activos = operators.filter((x) => Boolean(x.activo)).length;
  const inactivos = total - activos;

  return { total, activos, inactivos };
}

async function createOrReactivateOperatorAdmin(name = "") {
  const finalName = validateAdminOperatorName(name);
  const existing = await findOperatorByNameAdmin(finalName);

  if (existing) {
    const needsUpdate = !existing.activo || existing.nombre !== finalName;

    if (!needsUpdate) {
      return {
        action: "exists",
        operator: existing
      };
    }

    deleteOperatorCache(existing.nombre);

    const { data, error } = await supabase
      .from("operadores")
      .update({
        nombre: finalName,
        activo: true
      })
      .eq("id", existing.id)
      .select("id, nombre, activo, created_at")
      .single();

    if (error || !data) {
      throw new Error("No se pudo actualizar el operador");
    }

    return {
      action: existing.activo ? "updated" : "reactivated",
      operator: data
    };
  }

  const { data, error } = await supabase
    .from("operadores")
    .insert([
      {
        nombre: finalName,
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

async function updateOperatorStatusAdmin(id = 0, activo = true) {
  const operatorId = Math.max(0, Number.parseInt(id, 10) || 0);

  if (!operatorId) {
    throw new Error("ID de operador invalido");
  }

  const { data: existing, error: readError } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .eq("id", operatorId)
    .single();

  if (readError || !existing) {
    throw new Error("Operador no encontrado");
  }

  deleteOperatorCache(existing.nombre);

  const { data, error } = await supabase
    .from("operadores")
    .update({
      activo: Boolean(activo)
    })
    .eq("id", operatorId)
    .select("id, nombre, activo, created_at")
    .single();

  if (error || !data) {
    throw new Error("No se pudo actualizar el operador");
  }

  if (data.activo) {
    writeOperatorCache(data.nombre, data.nombre);
  }

  return data;
}

async function deleteOperatorAdmin(id = 0) {
  const operatorId = Math.max(0, Number.parseInt(id, 10) || 0);

  if (!operatorId) {
    throw new Error("ID de operador invalido");
  }

  const { data: existing, error: readError } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .eq("id", operatorId)
    .single();

  if (readError || !existing) {
    throw new Error("Operador no encontrado");
  }

  deleteOperatorCache(existing.nombre);

  const { error } = await supabase
    .from("operadores")
    .delete()
    .eq("id", operatorId);

  if (error) {
    throw new Error("No se pudo eliminar el operador");
  }

  return existing;
}

function parseBulkNames(raw = "") {
  const names = String(raw ?? "")
    .split(/\r?\n|,/)
    .map((item) => formatOperatorName(item))
    .filter(Boolean);

  const seen = new Set();
  const out = [];

  for (const name of names) {
    const key = normalizeText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out.slice(0, 300);
}

function parseOperatorFilter(raw = "") {
  const names = String(raw ?? "")
    .split(",")
    .map((item) => formatOperatorName(item))
    .filter(Boolean);

  const seen = new Set();
  const out = [];

  for (const name of names) {
    const key = normalizeText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out.slice(0, 100);
}

/* =========================================================
 * HEALTH / ADMIN ASSETS
 * ======================================================= */

function getHealthPayload() {
  return {
    ok: true,
    service: "server unico completo profile-aware v3",
    uptime_seconds: Math.floor((Date.now() - runtimeStats.startedAt) / 1000),
    admin: {
      configured: adminConfigured(),
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
    suggestion_config: {
      max_tokens: SUGGESTION_MAX_TOKENS,
      target_lengths: TARGET_SUGGESTION_SPECS,
      profile_aware: true,
      about_text_priority: true,
      apertura_sin_respuesta: true,
      force_three_options: true
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
  };
}

function getAdminHtmlPath() {
  return path.join(__dirname, "admin.html");
}

function getAdminJsPath() {
  return path.join(__dirname, "admin.js");
}

function sendAdminHtml(_req, res) {
  const filePath = getAdminHtmlPath();

  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  return res.status(200).type("html").send(`
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Admin</title>
  <style>
    body { font-family: Arial, sans-serif; background:#07111d; color:#fff; padding:40px; }
    .box { max-width:760px; margin:auto; background:#0f172a; border:1px solid rgba(255,255,255,.08); padding:24px; border-radius:18px; }
    h1 { margin-top:0; }
    code { background:rgba(255,255,255,.08); padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Admin disponible</h1>
    <p>El backend ya expone <code>/admin-api/*</code>, pero no encontro el archivo <code>admin.html</code> en Railway.</p>
    <p>Sube tus archivos <code>admin.html</code> y <code>admin.js</code> para recuperar el panel visual completo.</p>
  </div>
</body>
</html>
  `);
}

function sendAdminJs(_req, res) {
  const filePath = getAdminJsPath();

  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  return res
    .status(200)
    .type("application/javascript")
    .send(`console.warn("No se encontro admin.js en Railway");`);
}

/* =========================================================
 * ROUTES
 * ======================================================= */

app.get("/", (_req, res) => {
  return res.redirect("/admin");
});

app.get("/health", (_req, res) => {
  return res.json(getHealthPayload());
});

app.get("/admin", sendAdminHtml);
app.get("/admin.js", sendAdminJs);

/* =========================
 * ADMIN API
 * ======================= */

app.post("/admin-api/login", async (req, res) => {
  runtimeStats.admin.loginTotal += 1;

  try {
    if (!adminConfigured()) {
      runtimeStats.admin.loginError += 1;
      return res.status(503).json({
        ok: false,
        error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET"
      });
    }

    const { usuario = "", password = "" } = req.body || {};
    const rateKey = getAdminRateKey(req, usuario);

    if (isAdminLoginBlocked(rateKey)) {
      runtimeStats.admin.loginError += 1;
      return res.status(429).json({
        ok: false,
        error: "Demasiados intentos. Vuelve a intentarlo mas tarde"
      });
    }

    if (!adminCredentialsValid(usuario, password)) {
      registerAdminAttempt(rateKey, false);
      runtimeStats.admin.loginError += 1;

      return res.status(401).json({
        ok: false,
        error: "Credenciales admin invalidas"
      });
    }

    registerAdminAttempt(rateKey, true);
    runtimeStats.admin.loginOk += 1;

    const user = String(usuario || "").trim() || "admin";

    return res.json({
      ok: true,
      token: createAdminToken(user),
      user,
      operator_shared_key: OPERATOR_SHARED_KEY
    });
  } catch (err) {
    runtimeStats.admin.loginError += 1;

    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo iniciar sesion admin"
    });
  }
});

app.get("/admin-api/session", authorizeAdmin, async (req, res) => {
  return res.json({
    ok: true,
    user: req.adminAuth?.sub || "admin",
    operator_shared_key: OPERATOR_SHARED_KEY
  });
});

app.get("/admin-api/operators", authorizeAdmin, async (_req, res) => {
  try {
    runtimeStats.admin.operatorList += 1;

    const operators = await listOperatorsAdmin();
    const summary = summarizeOperators(operators);

    return res.json({
      ok: true,
      operators,
      summary
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo cargar la lista de operadores"
    });
  }
});

app.post("/admin-api/operators", authorizeAdmin, async (req, res) => {
  try {
    const { nombre = "" } = req.body || {};
    const result = await createOrReactivateOperatorAdmin(nombre);

    if (result.action === "created") runtimeStats.admin.operatorCreate += 1;
    if (result.action === "updated" || result.action === "reactivated") {
      runtimeStats.admin.operatorUpdate += 1;
    }

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

app.post("/admin-api/operators/bulk", authorizeAdmin, async (req, res) => {
  try {
    const { texto = "" } = req.body || {};
    const names = parseBulkNames(texto);

    if (!names.length) {
      return res.status(400).json({
        ok: false,
        error: "No se detectaron nombres validos"
      });
    }

    const result = {
      created: [],
      reactivated: [],
      updated: [],
      existing: [],
      errors: []
    };

    for (const name of names) {
      try {
        const item = await createOrReactivateOperatorAdmin(name);

        if (item.action === "created") result.created.push(item.operator);
        if (item.action === "reactivated") result.reactivated.push(item.operator);
        if (item.action === "updated") result.updated.push(item.operator);
        if (item.action === "exists") result.existing.push(item.operator);
      } catch (err) {
        result.errors.push({
          nombre: name,
          error: err.message || "Error procesando operador"
        });
      }
    }

    runtimeStats.admin.operatorCreate += result.created.length;
    runtimeStats.admin.operatorUpdate += result.reactivated.length + result.updated.length;

    const operators = await listOperatorsAdmin();
    const summary = summarizeOperators(operators);

    return res.json({
      ok: true,
      result,
      operators,
      summary
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo procesar el alta masiva"
    });
  }
});

app.patch("/admin-api/operators/:id/status", authorizeAdmin, async (req, res) => {
  try {
    const activo = req.body?.activo === true || String(req.body?.activo) === "true";
    const operator = await updateOperatorStatusAdmin(req.params.id, activo);

    runtimeStats.admin.operatorUpdate += 1;

    return res.json({
      ok: true,
      operator
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo actualizar el estado del operador"
    });
  }
});

app.delete("/admin-api/operators/:id", authorizeAdmin, async (req, res) => {
  try {
    const deleted = await deleteOperatorAdmin(req.params.id);
    runtimeStats.admin.operatorDelete += 1;

    return res.json({
      ok: true,
      deleted
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo eliminar el operador"
    });
  }
});

app.get("/admin-api/dashboard", authorizeAdmin, async (req, res) => {
  try {
    runtimeStats.admin.dashboardLoads += 1;

    const range = buildDateRange(
      req.query?.from || "",
      req.query?.to || ""
    );

    const operadoresFiltrados = parseOperatorFilter(req.query?.operadores || "");

    const [consumoRows, warningRows] = await Promise.all([
      loadConsumptionRange(range, operadoresFiltrados),
      loadWarningsRange(range, operadoresFiltrados)
    ]);

    const dashboard = buildDashboardAnalytics({
      consumoRows,
      warningRows,
      range,
      operadoresFiltrados
    });

    return res.json({
      ok: true,
      ...dashboard
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo cargar el dashboard"
    });
  }
});

/* =========================
 * OPERATOR API
 * ======================= */

app.post("/login", authorizeOperator, async (req, res) => {
  return res.json({
    ok: true,
    operador: req.operadorAutorizado
  });
});

app.post("/warning-sync", authorizeOperator, async (req, res) => {
  const startedAt = Date.now();
  runtimeStats.warnings.total += 1;

  try {
    const { extension_id = "", fecha = "", counts = {} } = req.body || {};

    const result = await saveWarningSummary({
      operador: req.operadorAutorizado,
      extension_id,
      fecha,
      counts
    });

    runtimeStats.warnings.ok += 1;
    runtimeStats.warnings.rowsUpserted += Number(result.rowsUpserted || 0);
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

app.post("/sugerencias", authorizeOperator, async (req, res) => {
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
      chat_signals = {},
      page_type = ""
    } = req.body || {};

    if (!String(texto || "").trim()) {
      return res.json({
        ok: false,
        sugerencias: [],
        error: "Texto vacio"
      });
    }

    const resultado = await generateSuggestions({
      operador,
      texto,
      contexto,
      cliente,
      perfil,
      chat_signals,
      page_type
    });

    const tipo = resultado.shared
      ? "IA_SHARED"
      : resultado.usedFallbackOnly
        ? "IA_FALLBACK"
        : resultado.secondPassUsed
          ? "IA_2PASS"
          : "IA";

    if (resultado.usedFallbackOnly) {
      runtimeStats.suggestions.fallbackOnly += 1;
    }

    registerConsumptionAsync({
      operador,
      extension_id,
      data: resultado.shared || resultado.usedFallbackOnly
        ? null
        : resultado.usageData,
      tipo,
      mensaje_operador: texto,
      request_ok: true
    });

    runtimeStats.suggestions.ok += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      sugerencias: Array.isArray(resultado?.sugerencias)
        ? resultado.sugerencias.slice(0, 3)
        : ensureExactlyThreeSuggestions([], buildCase({
            operador,
            texto,
            contexto,
            cliente,
            perfil,
            chat_signals,
            page_type
          }))
    });
  } catch (err) {
    registerConsumptionAsync({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "IA",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    runtimeStats.suggestions.error += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    try {
      const caso = buildCase({
        operador,
        texto: req.body?.texto || "",
        contexto: req.body?.contexto || "",
        cliente: req.body?.cliente || "",
        perfil: req.body?.perfil || "",
        chat_signals: req.body?.chat_signals || {},
        page_type: req.body?.page_type || "chat"
      });

      return res.json({
        ok: true,
        sugerencias: ensureExactlyThreeSuggestions([], caso)
      });
    } catch (_fallbackErr) {
      return res.json({
        ok: false,
        sugerencias: [],
        error: err.message || "Error interno"
      });
    }
  }
});

app.post("/traducir", authorizeOperator, async (req, res) => {
  const startedAt = Date.now();
  const operador = req.operadorAutorizado;
  runtimeStats.translations.total += 1;

  try {
    const { texto = "", extension_id = "" } = req.body || {};
    const text = String(texto || "");

    if (!text.trim()) {
      return res.json({ ok: false, error: "Texto vacio" });
    }

    const cacheKey = getTranslationCacheKey(text);
    const cached = readTranslationCache(cacheKey);

    if (cached) {
      runtimeStats.translations.cacheHits += 1;
      runtimeStats.translations.ok += 1;
      runtimeStats.translations.lastMs = Date.now() - startedAt;

      registerConsumptionAsync({
        operador,
        extension_id,
        data: null,
        tipo: "TRAD_CACHE",
        mensaje_operador: text,
        request_ok: true
      });

      return res.json({ ok: true, traducido: cached });
    }

    const result = await translateText(text);
    writeTranslationCache(cacheKey, result.traducido);

    registerConsumptionAsync({
      operador,
      extension_id,
      data: result.shared ? null : result.usageData,
      tipo: result.shared ? "TRAD_SHARED" : "TRAD",
      mensaje_operador: text,
      request_ok: true
    });

    runtimeStats.translations.ok += 1;
    runtimeStats.translations.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      traducido: result.traducido
    });
  } catch (err) {
    registerConsumptionAsync({
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

/* =========================================================
 * FALLBACK / ERRORS
 * ======================================================= */

app.use((err, _req, res, _next) => {
  console.error("Error no controlado:", err);
  if (res.headersSent) return;
  return res.status(500).json({
    ok: false,
    error: "Error interno"
  });
});

app.listen(PORT, () => {
  console.log(`Server unico completo profile-aware v3 activo en puerto ${PORT}`);
  console.log(`Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`);
  console.log(`SUGGESTION_MAX_TOKENS => ${SUGGESTION_MAX_TOKENS}`);
  console.log(`Rangos IA => 1:${TARGET_SUGGESTION_SPECS[0].min}-${TARGET_SUGGESTION_SPECS[0].max}, 2:${TARGET_SUGGESTION_SPECS[1].min}-${TARGET_SUGGESTION_SPECS[1].max}, 3:${TARGET_SUGGESTION_SPECS[2].min}-${TARGET_SUGGESTION_SPECS[2].max}`);
});
