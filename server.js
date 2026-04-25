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
  18000,
  4000,
  45000
);

const SUGGESTION_MAX_TOKENS = readIntEnv(
  "SUGGESTION_MAX_TOKENS",
  580,
  300,
  1400
);

const MAIL_MAX_TOKENS = readIntEnv(
  "MAIL_MAX_TOKENS",
  900,
  400,
  1800
);

/*
 * DEBUG_OPENAI:
 * 1 = muestra logs reales de OpenAI/fallback en Railway.
 * 0 = apaga logs de diagnostico.
 */
const DEBUG_OPENAI = String(process.env.DEBUG_OPENAI || "1") !== "0";
const LOG_FALLBACKS = String(process.env.LOG_FALLBACKS || "1") !== "0";
const LOG_SUCCESS_SUMMARY = String(process.env.LOG_SUCCESS_SUMMARY || "0") === "1";

const MAX_CONTEXT_LINES = readIntEnv("MAX_CONTEXT_LINES", 18, 4, 36);
const MIN_RESPONSE_LENGTH = readIntEnv("MIN_RESPONSE_LENGTH", 80, 20, 220);

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
  900,
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

const CHAT_TARGET_SPECS = [
  { min: 150, max: 200, ideal: 175 },
  { min: 200, max: 300, ideal: 245 },
  { min: 250, max: 400, ideal: 320 }
];

const MAIL_TARGET_SPECS = [
  { min: 260, max: 420, ideal: 340 },
  { min: 380, max: 620, ideal: 500 },
  { min: 520, max: 850, ideal: 680 }
];

const SUGGESTION_MEMORY_TTL_MS = 20 * 60 * 1000;
const SUGGESTION_MEMORY_LIMIT = 900;

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
    enganche: 0,
    contexto: 0,
    mail: 0,
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
 * LOGGING
 * ======================================================= */

function safeLogPayload(payload = {}) {
  try {
    return JSON.stringify(payload);
  } catch (_err) {
    return String(payload);
  }
}

function logInfo(tag = "", payload = {}) {
  if (!DEBUG_OPENAI) return;
  console.log(`[${tag}] ${safeLogPayload(payload)}`);
}

function logWarn(tag = "", payload = {}) {
  if (!DEBUG_OPENAI) return;
  console.warn(`[${tag}] ${safeLogPayload(payload)}`);
}

function logError(tag = "", payload = {}) {
  if (!DEBUG_OPENAI) return;
  console.error(`[${tag}] ${safeLogPayload(payload)}`);
}

function compactOpenAIError(err = null) {
  return {
    message: err?.message || "Error desconocido",
    name: err?.name || "",
    stack: err?.stack ? String(err.stack).split("\n").slice(0, 3).join(" | ") : ""
  };
}

/* =========================================================
 * AUTH OPERADOR
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
 * AUTH ADMIN
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
 * QUEUES
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
          if (idx >= 0) this.queue.splice(idx, 1);

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
      if (LOG_SUCCESS_SUMMARY) {
        logInfo("OPENAI_REQUEST", {
          lane,
          model,
          temperature,
          maxTokens,
          timeoutMs,
          messages_count: Array.isArray(messages) ? messages.length : 0
        });
      }

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
        logError("OPENAI_HTTP_ERROR", {
          lane,
          model,
          status: response.status,
          error: data?.error?.message || data?.error || data
        });

        if (response.status === 429) {
          throw new Error("OpenAI esta ocupado. Intenta de nuevo en unos segundos");
        }

        throw new Error(data?.error?.message || "Error consultando OpenAI");
      }

      runtimeStats.openai.ok += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      if (LOG_SUCCESS_SUMMARY) {
        logInfo("OPENAI_OK", {
          lane,
          model,
          ms: runtimeStats.openai.lastMs,
          usage: data?.usage || null
        });
      }

      return data;
    } catch (err) {
      runtimeStats.openai.error += 1;
      runtimeStats.openai.lastMs = Date.now() - startedAt;

      logError("OPENAI_ERROR", {
        lane,
        model,
        ms: runtimeStats.openai.lastMs,
        error: compactOpenAIError(err)
      });

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

/* ===== FIN PARTE 1/4 ===== */
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
    total_operador_visible: Number(raw?.total_operador_visible || 0),
    modo_manual: String(raw?.modo_manual || "").trim(),
    usar_perfil: Boolean(raw?.usar_perfil),
    usar_chat: Boolean(raw?.usar_chat)
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

function formatContextLines(lines = [], limit = MAX_CONTEXT_LINES) {
  return lines
    .slice(-limit)
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
    "about",
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
  if (n === "about") return "";
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
  const hasPlatformWords = /\b(plataforma|platform|app|cuenta|account|usuario|user|site|sitio)\b/.test(text);

  if (hasPaymentWords && hasPlatformWords) {
    pushRisk(RISK_CATALOG.pregunta_pago_plataforma);
  }

  const hasSocialWords = /\b(instagram|insta|facebook|tiktok|snapchat|snap|twitter|redes sociales|social media)\b/.test(text);
  const hasFoundWords = /\b(encontre|vi|found|i found|te vi|saw|tu perfil|your profile|outside|afuera)\b/.test(text);

  if (hasSocialWords && hasFoundWords) {
    pushRisk(RISK_CATALOG.redes_externas);
  }

  const hasRhythmWords = /\b(no puedo seguir el ritmo|no puedo mantener el ritmo|cant keep up|cannot keep up|too fast|demasiado rapido|mucha intensidad|me abruma|me supera|no tengo tiempo|sin tiempo|busy|ocupad[oa]|hablamos luego|talk later|leave|leaving|abandon|abandonar|site|sitio)\b/.test(text);
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

function normalizeMode(inputMode = "", pageType = "chat") {
  const mode = normalizeText(inputMode);

  if (pageType === "mail") return "mail";
  if (mode.includes("enganche")) return "enganche";
  if (mode.includes("contexto") || mode.includes("correccion")) return "contexto_correccion";

  return "contexto_correccion";
}

function getTargetSpecs(caso = {}) {
  return caso.pageType === "mail" ? MAIL_TARGET_SPECS : CHAT_TARGET_SPECS;
}

function getMaxTokensForCase(caso = {}) {
  return caso.pageType === "mail" ? MAIL_MAX_TOKENS : SUGGESTION_MAX_TOKENS;
}

function getOutputType(caso = {}) {
  if (caso.pageType === "mail") return "IA_MAIL";
  if (caso.modoAyuda === "enganche") return "IA_ENGANCHE";
  return "IA_CONTEXTO";
}

function inferContactType(caso = {}) {
  if (caso.pageType === "mail") return "mail";
  if (caso.modoAyuda === "enganche") return "nuevo_o_sin_respuesta";
  return "conversacion";
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

  if (/\b(vi que|me llamo la atencion|me dio curiosidad|note que|entiendo que|imagino que|me gusta que|lei que|lei en tu perfil)\b/.test(n)) {
    return true;
  }

  return false;
}

function getSuggestionMemoryKey(caso = {}) {
  return [
    normalizeText(caso.operador || "anon").slice(0, 80),
    normalizeText(caso.pageType || "chat"),
    normalizeText(caso.modoAyuda || "contexto"),
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
  const minLength = caso.pageType === "mail" ? 160 : MIN_RESPONSE_LENGTH;

  if (!s) return true;
  if (countChars(s) < minLength) return true;
  if (caso.pageType !== "mail" && countQuestions(s) > 1) return true;
  if (INTERNAL_LABEL_REGEX.test(s)) return true;
  if (DISALLOWED_CONTACT_REGEX.test(n)) return true;
  if (DISALLOWED_MEET_REGEX.test(n)) return true;
  if (META_REGEX.test(n)) return true;

  if (caso.modoAyuda === "enganche" && talksAboutClientInThirdPerson(s, caso)) return true;
  if (caso.modoAyuda === "enganche" && FALSE_FAMILIARITY_REGEX.test(n)) return true;

  if (
    caso.modoAyuda === "contexto_correccion" &&
    caso.chatSignals?.hay_clienta_visible &&
    /^hola\b|^hey\b|^buenas\b/i.test(n) &&
    countChars(s) < 160
  ) {
    return true;
  }

  return false;
}

function scoreSuggestion(suggestion = "", caso = {}, index = 0) {
  if (isSuggestionForbidden(suggestion, caso)) return 0;

  const s = cleanSuggestion(suggestion);
  const n = normalizeText(s);
  const length = countChars(s);
  const specs = getTargetSpecs(caso);
  const spec = specs[Math.min(index, specs.length - 1)];

  let score = 0;

  score += scoreLength(length, spec) * 0.34;
  score += countQuestions(s) <= (caso.pageType === "mail" ? 3 : 1) ? 0.08 : -0.15;

  const overlapClient = keywordOverlap(s, caso.clientKeywords || []);
  const overlapDraft = keywordOverlap(s, caso.draftKeywords || []);
  const overlapDetail = keywordOverlap(s, caso.detailKeywords || []);
  const overlapOperator = keywordOverlap(s, caso.operatorKeywords || []);
  const overlapThemes = keywordOverlap(s, caso.activeThemes || []);
  const overlapProfile = keywordOverlap(s, caso.profileKeywords || []);

  if (caso.pageType === "mail") {
    score += overlapClient > 0 ? 0.12 : 0;
    score += overlapDraft > 0 ? 0.12 : 0;
    score += length >= spec.min ? 0.08 : -0.05;
  } else if (caso.modoAyuda === "enganche") {
    score += caso.profileAvailable && overlapProfile > 0 ? 0.24 : -0.12;
    score += addressesClientDirectly(s, caso) ? 0.08 : -0.04;
  } else {
    score += overlapClient > 0 ? 0.18 : 0;
    score += overlapDraft > 0 ? 0.10 : 0;
    score += overlapOperator > 0 ? 0.06 : 0;
  }

  if (overlapThemes > 0) score += 0.07;
  if (caso.detallePerfil?.value && overlapDetail > 0) score += 0.06;

  if (EMPTY_MIRROR_REGEX.test(n)) score -= 0.18;
  if (ONE_WORD_MIRROR_REGEX.test(n)) score -= 0.20;
  if (EMPTY_GENERIC_START_REGEX.test(n) && caso.modoAyuda !== "enganche" && caso.pageType !== "mail") score -= 0.10;

  if (
    ["contacto_externo", "redes_externas"].includes(caso.risk?.primary?.key) &&
    /\b(aqui|por aqui|por este chat|por el chat)\b/.test(n)
  ) {
    score += 0.12;
  }

  if (
    caso.risk?.primary?.key === "abandono_ritmo_contacto" &&
    /\b(con calma|sin presion|a tu ritmo|tranqui|sin correr)\b/.test(n)
  ) {
    score += 0.12;
  }

  if (
    caso.risk?.primary?.key === "desconfianza_realidad" &&
    /\b(real|claro|natural|honesto|honesta)\b/.test(n)
  ) {
    score += 0.08;
  }

  if (caso.affectionLoadHigh && countEndearments(s) >= 2) {
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

function selectFinalCandidates(pool = [], caso = {}) {
  const specs = getTargetSpecs(caso);

  const ranked = [...pool].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.length !== a.length) return b.length - a.length;
    return a.text.localeCompare(b.text);
  });

  const selected = [];

  for (let slot = 0; slot < specs.length; slot += 1) {
    const spec = specs[slot];

    let candidate = ranked.find((item) => {
      if (selected.some((x) => looksTooSimilar(x.text, item.text))) return false;
      return item.length >= spec.min && item.length <= spec.max;
    });

    if (!candidate) {
      candidate = ranked.find((item) => {
        if (selected.some((x) => looksTooSimilar(x.text, item.text))) return false;
        return item.length >= Math.round(spec.min * 0.72) && item.length <= Math.round(spec.max * 1.22);
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

function isWeakResult(candidates = [], selected = [], caso = {}) {
  if (selected.length < 3) return true;

  const avg = selected.reduce((sum, item) => sum + item.score, 0) / selected.length;

  if (avg < 0.56) return true;

  const specs = getTargetSpecs(caso);

  for (let i = 0; i < selected.length; i += 1) {
    const spec = specs[i];
    const item = selected[i];

    if (!item) return true;
    if (item.length < Math.round(spec.min * 0.72)) return true;
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
    caso.modoAyuda === "enganche" &&
    caso.profileAvailable &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.profileKeywords || []) === 0)
  ) {
    notes.push("- Falta usar datos reales del perfil. Cada opcion debe apoyarse en 1 o 2 datos del perfil.");
  }

  if (
    caso.modoAyuda === "contexto_correccion" &&
    caso.pageType !== "mail" &&
    caso.chatSignals?.hay_clienta_visible &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.clientKeywords || []) === 0)
  ) {
    notes.push("- Falta responder al contexto real y a lo ultimo de la clienta.");
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
    caso.modoAyuda === "enganche" &&
    candidates.length &&
    candidates.some((item) => FALSE_FAMILIARITY_REGEX.test(normalizeText(item.text)))
  ) {
    notes.push("- No finjas confianza previa. No digas 'nuestras conversaciones', 'me acorde de ti' ni 'lo que hablamos'.");
  }

  if (!notes.length) {
    notes.push("- Hazlas mas especificas, mas utiles y menos genericas.");
  }

  if (caso.pageType === "mail") {
    notes.push("- En mail, entrega versiones de carta corregidas, naturales y mas completas.");
  } else {
    notes.push("- Recuerda: opcion 1 de 150 a 200 caracteres, opcion 2 de 200 a 300, opcion 3 de 250 a 400.");
  }

  return notes.join("\n");
}

function buildSpecText(caso = {}) {
  return getTargetSpecs(caso)
    .map((spec, index) => `${index + 1}. ${spec.min}-${spec.max} caracteres`)
    .join("\n");
}

/* =========================================================
 * PROMPTS
 * ======================================================= */

function buildEngancheSystemPrompt(caso = {}) {
  const name = caso.perfil?.nombreClienta || "la clienta";

  return [
    "Eres el motor de ENGANCHE de una herramienta interna de chat.",
    "Debes devolver exactamente 3 opciones finales en espanol, listas para enviar.",
    "Tu unico trabajo es crear una entrada atractiva usando datos reales del perfil.",
    "",
    "REGLA CENTRAL",
    "- este modo NO usa historial del chat",
    "- no finjas que ya hubo conversacion",
    "- no digas: nuestras conversaciones, lo que hablamos, me acorde de ti, seguimos donde quedamos",
    `- escribe directamente a ${name}, no hables sobre ella en tercera persona`,
    "- prohibido usar etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME, ABOUT_TEXT, RAW_PROFILE o PROFILE_ANCHORS",
    "",
    "USO DEL PERFIL",
    "- si hay ABOUT_TEXT, usalo como prioridad alta",
    "- usa maximo 1 o 2 datos reales del perfil por opcion",
    "- puedes usar nombre, pais, intereses, looking for, about me o about text",
    "- usa estado civil solo si suma de forma natural y no invasiva",
    "- no inventes ciudad, pais, hijos, estado civil ni intenciones",
    "- si el perfil dice Married, no lo conviertas en Divorced o Widowed",
    "- si el perfil dice Divorced, no lo conviertas en Widowed",
    "",
    "TONO",
    "- natural",
    "- atractivo",
    "- humano",
    "- no necesitado",
    "- no intenso",
    "- no generico",
    "",
    "REGLAS",
    "- maximo 1 pregunta por opcion",
    "- sin emojis",
    "- sin comillas",
    "- no propongas encuentros, llamadas ni contacto externo",
    "- no invites a salir de la app",
    "- no uses frases vacias como hola como estas",
    "- no copies el borrador si esta flojo",
    "",
    "VARIACION",
    "1. Directa: 150 a 200 caracteres.",
    "2. Atractiva: 200 a 300 caracteres.",
    "3. Desarrollada: 250 a 400 caracteres.",
    "",
    "LARGO EXACTO ESPERADO",
    buildSpecText(caso),
    "",
    "Devuelve solo:",
    "1. ...",
    "2. ...",
    "3. ..."
  ].join("\n").trim();
}

function buildContextSystemPrompt(caso = {}) {
  return [
    "Eres el motor de CONTEXTO Y CORRECCION de una herramienta interna de chat.",
    "Debes devolver exactamente 3 opciones finales en espanol, listas para enviar.",
    "Tu unico trabajo es corregir y mejorar el borrador del operador usando la conversacion real.",
    "",
    "REGLA CENTRAL",
    "- este modo NO usa perfil",
    "- usa solo el contexto del chat y el borrador del operador",
    "- si hay mensajes reales de la clienta, responde al momento actual",
    "- si ya hay conversacion activa, NO saludes como apertura",
    "- no escribas como cliente nuevo si hay historial real",
    "- conserva la intencion del operador, pero corrige ansiedad, presion, reclamo o tono debil",
    "- prohibido usar etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME, RAW_PROFILE o PROFILE_ANCHORS",
    "",
    "SITUACIONES DE RIESGO",
    "- si el operador presiona, reclama o suena ansioso, baja la presion",
    "- si la clienta habla de abandonar, sitio, datos personales, cansancio o ritmo, valida y calma",
    "- si hay contacto externo, no lo aceptes y mantente dentro del chat",
    "- si hay desconfianza, responde claro sin ponerte defensiva",
    "",
    "TONO",
    "- natural",
    "- emocionalmente inteligente",
    "- sin culpa",
    "- sin suplica",
    "- sin manipulacion",
    "- conversacional",
    "",
    "REGLAS",
    "- maximo 1 pregunta por opcion",
    "- sin emojis",
    "- sin comillas",
    "- no inventes hechos",
    "- no inventes politicas ni pagos",
    "- no propongas encuentros, llamadas ni contacto externo",
    "- si hay ultimo mensaje de la clienta, responde primero a eso",
    "",
    "VARIACION",
    "1. Directa: 150 a 200 caracteres.",
    "2. Atractiva: 200 a 300 caracteres.",
    "3. Desarrollada: 250 a 400 caracteres.",
    "",
    "LARGO EXACTO ESPERADO",
    buildSpecText(caso),
    "",
    "Devuelve solo:",
    "1. ...",
    "2. ...",
    "3. ..."
  ].join("\n").trim();
}

function buildMailSystemPrompt(caso = {}) {
  return [
    "Eres el motor de CARTAS de una herramienta interna.",
    "Debes devolver exactamente 3 versiones finales en espanol, listas para enviar como carta.",
    "Tu trabajo es mejorar el borrador del operador usando el contexto del mail o carta.",
    "",
    "REGLA CENTRAL",
    "- este modo es para cartas/mails, no para chat corto",
    "- corrige errores",
    "- mejora el tono",
    "- extiende solo si aporta",
    "- responde al hilo anterior si existe",
    "- conserva la intencion del operador",
    "- no uses perfil si no fue enviado",
    "- no inventes datos",
    "- prohibido usar etiquetas internas como DATOS_CLIENTA, LOOKING_FOR, ABOUT_ME, RAW_PROFILE o PROFILE_ANCHORS",
    "",
    "TONO",
    "- natural",
    "- cercano",
    "- claro",
    "- con buena redaccion",
    "- sin sonar robotico",
    "- sin exceso de intensidad",
    "",
    "REGLAS",
    "- sin emojis",
    "- sin comillas",
    "- no pidas contacto externo",
    "- no propongas encuentros, llamadas ni salir de la app",
    "- no inventes promesas",
    "- no conviertas la carta en una respuesta corta de chat",
    "",
    "VARIACION",
    "1. Carta breve corregida.",
    "2. Carta mas completa y natural.",
    "3. Carta desarrollada, con mejor hilo y mejor cierre.",
    "",
    "LARGO ESPERADO",
    buildSpecText(caso),
    "",
    "Devuelve solo:",
    "1. ...",
    "2. ...",
    "3. ..."
  ].join("\n").trim();
}

function buildSystemPrompt(caso = {}) {
  if (caso.pageType === "mail") return buildMailSystemPrompt(caso);
  if (caso.modoAyuda === "enganche") return buildEngancheSystemPrompt(caso);
  return buildContextSystemPrompt(caso);
}

function buildUserPrompt(caso = {}, recent = [], previousOptions = [], feedback = "") {
  const common = [
    [
      "RESUMEN DEL CASO",
      `- modo ayuda: ${caso.modoAyuda}`,
      `- page_type: ${caso.pageType}`,
      `- tipo contacto: ${caso.tipoContacto}`,
      `- objetivo: ${caso.objective}`,
      `- tono: ${caso.tone}`,
      `- riesgo primario: ${caso.risk?.primary?.label || "Sin riesgo especial"}`,
      `- guia riesgo: ${caso.risk?.primary?.guidance || "Mantener conversacion natural"}`
    ].join("\n"),
    [
      "BORRADOR DEL OPERADOR",
      '"""',
      caso.textoPlano || "Sin borrador claro",
      '"""'
    ].join("\n")
  ];

  if (caso.pageType === "mail") {
    common.push([
      "CONTEXTO DE MAIL / CARTA",
      '"""',
      caso.contextoPlano || "Sin contexto util",
      '"""'
    ].join("\n"));
  } else if (caso.modoAyuda === "enganche") {
    common.push([
      "PERFIL REAL DISPONIBLE",
      `- nombre: ${caso.perfil?.nombreClienta || ""}`,
      `- pais: ${caso.perfil?.paisClienta || ""}`,
      `- fecha nacimiento: ${caso.perfil?.fechaNacimiento || ""}`,
      `- estado civil: ${caso.perfil?.estadoCivil || ""}`,
      `- intereses: ${(caso.perfil?.interesesClienta || []).join(" | ")}`,
      `- busca: ${(caso.perfil?.lookingFor || []).join(" | ")}`,
      `- personalidad visible: ${(caso.perfil?.aboutMe || []).join(" | ")}`,
      `- texto personal: ${caso.perfil?.aboutText || ""}`
    ].join("\n"));
  } else {
    common.push([
      "ULTIMO MENSAJE REAL DE LA CLIENTA",
      '"""',
      caso.clientePlano || "Sin mensaje claro de la clienta",
      '"""'
    ].join("\n"));

    common.push([
      "CONTEXTO RECIENTE DEL CHAT",
      '"""',
      caso.contextoPlano || "Sin contexto util",
      '"""'
    ].join("\n"));
  }

  common.push([
    "KEYWORDS",
    `- clienta: ${(caso.clientKeywords || []).join(" | ") || "ninguna"}`,
    `- operador: ${(caso.operatorKeywords || []).join(" | ") || "ninguna"}`,
    `- perfil: ${caso.modoAyuda === "enganche" ? ((caso.profileKeywords || []).join(" | ") || "ninguna") : "no usar perfil"}`,
    `- temas activos: ${(caso.activeThemes || []).join(" | ") || "ninguno"}`
  ].join("\n"));

  common.push([
    "RESPUESTAS RECIENTES A EVITAR",
    recent.length
      ? recent.map((x, i) => `${i + 1}. ${x}`).join("\n")
      : "ninguna"
  ].join("\n"));

  if (previousOptions.length) {
    common.push([
      "OPCIONES ANTERIORES FLOJAS",
      previousOptions.map((x, i) => `${i + 1}. ${x}`).join("\n")
    ].join("\n"));
  }

  if (feedback) {
    common.push([
      "CORRECCIONES QUE DEBES APLICAR",
      feedback
    ].join("\n"));
  }

  if (caso.pageType === "mail") {
    common.push([
      "INSTRUCCIONES FINALES",
      "- mejora el borrador como carta",
      "- corrige errores",
      "- extiende con naturalidad si hace falta",
      "- no inventes datos",
      "- no uses etiquetas internas",
      "- entrega 3 versiones de carta"
    ].join("\n"));
  } else if (caso.modoAyuda === "enganche") {
    common.push([
      "INSTRUCCIONES FINALES",
      "- usa perfil, no chat",
      "- no finjas conversacion previa",
      "- si hay ABOUT_TEXT, priorizalo",
      "- habla directamente con la clienta",
      "- no uses etiquetas internas",
      "- entrega 3 opciones de enganche"
    ].join("\n"));
  } else {
    common.push([
      "INSTRUCCIONES FINALES",
      "- usa conversacion, no perfil",
      "- corrige el texto del operador",
      "- responde al momento actual",
      "- no saludes como apertura si hay conversacion activa",
      "- baja presion si hay ansiedad o reclamo",
      "- entrega 3 opciones corregidas"
    ].join("\n"));
  }

  return common.join("\n\n").trim();
}

function pickTemperature(caso = {}, isRepair = false) {
  let t = 0.72;

  if (caso.modoAyuda === "enganche") t = 0.82;
  if (caso.modoAyuda === "contexto_correccion") t = 0.68;
  if (caso.pageType === "mail") t = 0.72;

  switch (caso.risk?.primary?.key) {
    case "pregunta_pago_plataforma":
      t = 0.58;
      break;
    case "contacto_externo":
    case "redes_externas":
      t = 0.64;
      break;
    case "abandono_ritmo_contacto":
      t = 0.62;
      break;
    case "desconfianza_realidad":
      t = 0.62;
      break;
    default:
      break;
  }

  if (isRepair) {
    return Math.max(0.54, Math.min(0.86, t - 0.08));
  }

  return Math.max(0.54, Math.min(0.86, t));
}

/* ===== CONTINUA EN PARTE 3/4 ===== */
/* =========================================================
 * FALLBACKS
 * ======================================================= */

function buildProfileBasedFallbacks(caso = {}) {
  const name = namePrefix(caso);
  const profile = caso.perfil || {};
  const aboutText = profile.aboutText || "";
  const about = profile.aboutMe || [];
  const interests = profile.interesesClienta || [];
  const looking = profile.lookingFor || [];
  const country = profile.paisClienta || "";

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

function fallbackContextSuggestions(caso = {}) {
  const lastClient = caso.clientePlano || "";
  const draft = caso.textoPlano || "";

  if (caso.risk?.primary?.key === "abandono_ritmo_contacto") {
    return [
      "No quiero que sientas que te estoy presionando. Solo me preocupó un poco lo que dijiste, y prefiero que podamos hablar con calma, sin que esto se vuelva pesado para ti.",
      "Entiendo que quizá ahora tienes muchas cosas encima. No quiero empujarte ni hacerte sentir incómoda; solo me gustaría que sigamos hablando de una forma tranquila y sincera.",
      "Si algo de esto te hizo sentir presionada, prefiero bajarle el ritmo. Me importa más que la conversación se sienta cómoda para ti que insistir de una forma que pueda alejarte."
    ];
  }

  if (lastClient) {
    return [
      "Entiendo lo que dices y no quiero responderte desde la prisa. Prefiero hacerlo con calma, porque lo que me cuentas merece una respuesta más clara y más humana.",
      "Me quedo con lo que acabas de decir, porque no suena como algo pequeño. Quiero entenderlo bien y responderte sin presionarte ni cambiar el sentido de la conversación.",
      "Lo que dices me hace pensar que esta conversación necesita más calma que intensidad. Prefiero escucharte bien y seguir desde ahí, sin hacerte sentir que tienes que responder de una forma específica."
    ];
  }

  if (draft) {
    return [
      "Quise decirlo de una forma más clara y tranquila, sin que suene intenso ni repetitivo. Me interesa que la conversación siga natural y que no se sienta forzada.",
      "Prefiero escribirlo mejor para que no parezca presión ni reclamo. La idea es que se entienda lo que quiero decir, pero con un tono más cómodo y cercano.",
      "Quiero que esto suene más natural y menos impulsivo. A veces una frase más tranquila abre mejor la conversación que insistir demasiado o escribir desde la ansiedad."
    ];
  }

  return [];
}

function fallbackMailSuggestions(caso = {}) {
  const draft = caso.textoPlano || "";

  if (draft && draft.length > 40) {
    return [
      `Quise responderte con calma porque me parece mejor escribir algo que se sienta natural y no solo una frase rápida. ${draft}`,
      `Me gustó tomarme un momento para escribirte mejor, porque una carta permite decir las cosas con más claridad. ${draft}`,
      `Quiero que esta carta se sienta honesta y fácil de leer, sin sonar demasiado perfecta ni vacía. ${draft}`
    ];
  }

  return [
    "Gracias por escribirme. Me gusta poder responder con calma, porque una carta permite decir las cosas de una manera más clara y cercana que un mensaje rápido.",
    "Me dio gusto leer tu mensaje. Prefiero responderte con una carta que tenga un poco más de intención, porque así la conversación se siente más real y menos automática.",
    "Quise tomarme un momento para responderte bien. A veces una carta sencilla, honesta y bien escrita puede decir mucho más que una respuesta rápida sin dirección."
  ];
}

function fallbackRiskSuggestions(caso = {}) {
  if (caso.modoAyuda === "enganche") {
    const profile = buildProfileBasedFallbacks(caso);
    if (profile.length) return profile;
  }

  switch (caso.risk?.primary?.key) {
    case "contacto_externo":
      return [
        `${namePrefix(caso)}prefiero que sigamos por aqui y sin correr. Me interesa mas que la conversacion se sienta real antes que moverla fuera del chat.`,
        `${namePrefix(caso)}podemos llevarlo tranquilo por este chat. Para mi tiene mas sentido ver si la conversacion fluye bien aqui antes que saltar de una app a otra.`,
        `${namePrefix(caso)}antes de mover nada fuera de aqui prefiero ver si de verdad la charla tiene sentido. Me gusta mas descubrir si hay una conexion real que apurar algo que todavia estamos empezando.`
      ];

    case "pregunta_pago_plataforma":
      return [
        `${namePrefix(caso)}sobre como lo maneja la plataforma prefiero no inventarte nada. Lo que si me importa es que por aqui la charla se sienta real.`,
        `${namePrefix(caso)}no quiero darte una respuesta dudosa sobre pagos o cuentas. Prefiero ser claro y seguir con lo que si podemos construir aqui: una conversacion real.`,
        `${namePrefix(caso)}con temas de plataforma prefiero no suponer cosas que no se. Mejor sigamos desde algo mas humano y desde una conversacion que se sienta clara.`
      ];

    case "redes_externas":
      return [
        `${namePrefix(caso)}aunque hayas visto algo fuera, prefiero que lo llevemos por aqui y sin mezclar cosas. Me interesa mas conocerte desde esta conversacion.`,
        `${namePrefix(caso)}yo mantendria la charla por este chat para que sea mas simple y natural. Si algo te dio curiosidad, prefiero que lo hablemos aqui con calma.`,
        `${namePrefix(caso)}antes de cruzar nada con otras redes prefiero que aqui la conversacion se sienta clara y real. Si hay curiosidad, podemos darle espacio sin sacar la charla de aqui.`
      ];

    case "desconfianza_realidad":
      return [
        `${namePrefix(caso)}te respondo simple y claro: prefiero que esto suene natural antes que perfecto. Si algo te genera duda, dimelo directo y lo hablamos.`,
        `${namePrefix(caso)}no me interesa sonar armado ni vender una imagen rara. Prefiero una conversacion clara y normal, de esas que se sostienen solas.`,
        `${namePrefix(caso)}si algo te hace ruido, mejor decirlo de frente y seguir desde ahi. Para mi tiene mas valor una charla clara que una respuesta demasiado ensayada.`
      ];

    default:
      return [];
  }
}

function fallbackSuggestions(caso = {}) {
  const risk = fallbackRiskSuggestions(caso);
  if (risk.length) return risk;

  if (caso.pageType === "mail") return fallbackMailSuggestions(caso);

  if (caso.modoAyuda === "enganche") {
    const profile = buildProfileBasedFallbacks(caso);
    if (profile.length) return profile;
  }

  return fallbackContextSuggestions(caso);
}

function emergencySuggestions(caso = {}) {
  if (caso.pageType === "mail") {
    return [
      "Gracias por escribirme. Quise responderte con calma, porque una carta merece sentirse clara, natural y con un poco más de intención que una respuesta rápida.",
      "Me gustó leer tu mensaje y preferí responder de una forma más cuidada. A veces una carta sencilla puede abrir mejor una conversación que muchas frases sueltas.",
      "Quiero que esta carta se sienta cercana y honesta, sin sonar exagerada. Me interesa que podamos seguir hablando de una manera tranquila, clara y agradable."
    ];
  }

  if (caso.modoAyuda === "enganche") {
    return [
      `${namePrefix(caso)}quise escribirte algo mas real que un saludo comun. Me dio curiosidad tu perfil y me gustaria saber que tipo de conversacion te hace sentir comoda por aqui.`,
      `${namePrefix(caso)}prefiero empezar con algo sencillo y honesto. A veces una buena charla no necesita presion, solo una pregunta que de verdad abra un poco la puerta.`,
      `${namePrefix(caso)}me dio curiosidad saber un poco mas de ti sin sonar como un mensaje copiado. Me interesa mas una conversacion tranquila y natural que una entrada demasiado perfecta.`
    ];
  }

  return [
    "No quiero que esto suene como presión ni como reclamo. Prefiero escribirlo de una forma más tranquila, para que la conversación pueda seguir sin sentirse pesada.",
    "Quise decirlo mejor porque la intención no era incomodar. Me interesa que podamos hablar con calma y que esto se mantenga natural, sin forzar nada.",
    "Prefiero bajar un poco el ritmo y escribirlo de manera más clara. A veces una respuesta tranquila ayuda más que insistir demasiado o sonar ansioso."
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
    if (FALSE_FAMILIARITY_REGEX.test(normalizeText(clean)) && caso.modoAyuda === "enganche") return;
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
    const fallback = emergencySuggestions(caso)[final.length] || emergencySuggestions(caso)[0];
    final.push(fallback);
  }

  return final.slice(0, 3);
}

/* =========================================================
 * CASE BUILDER
 * ======================================================= */

function buildCase(input = {}) {
  const operador = String(input.operador || "").trim();

  const pageType = String(input.page_type || input.pageType || "chat").trim().toLowerCase() === "mail"
    ? "mail"
    : "chat";

  const modoAyuda = normalizeMode(input.modo_ayuda || input.modoAyuda || "", pageType);
  const chatSignals = normalizeChatSignals(input.chat_signals || input.chatSignals || {});
  const rawContextLines = parseContextLines(input.contexto || "").slice(-MAX_CONTEXT_LINES);
  const contextoPlano = formatContextLines(rawContextLines, pageType === "mail" ? 28 : MAX_CONTEXT_LINES);

  let clientePlano = cleanSuggestion(String(input.cliente || "").slice(0, 700));

  if (!clientePlano) {
    const lastClient = [...rawContextLines].reverse().find((x) => x.role === "clienta");
    clientePlano = lastClient ? cleanSuggestion(lastClient.text) : "";
  }

  const textoPlano = cleanSuggestion(String(input.texto || "").slice(0, pageType === "mail" ? 3000 : 900));
  const perfil = modoAyuda === "enganche" ? parseProfile(input.perfil || "") : parseProfile("");

  const risk = detectRisks({
    textoPlano,
    clientePlano,
    contextoPlano
  });

  const operatorRecent = rawContextLines
    .filter((x) => x.role === "operador")
    .slice(-7)
    .map((x) => x.text);

  const clientRecent = rawContextLines
    .filter((x) => x.role === "clienta")
    .slice(-7)
    .map((x) => x.text);

  const detallePerfil = modoAyuda === "enganche"
    ? pickProfileDetail(
      perfil,
      [
        textoPlano,
        perfil.profileAnchors,
        perfil.rawProfile,
        perfil.aboutText
      ].filter(Boolean).join("\n")
    )
    : { type: "none", value: "", priority: 0 };

  const operatorKeywords = extractKeywordSignals(operatorRecent.join(" "));
  const clientKeywords = extractKeywordSignals(clientePlano || clientRecent.join(" "));
  const draftKeywords = extractKeywordSignals(textoPlano);
  const detailKeywords = detallePerfil?.value ? extractKeywordSignals(detallePerfil.value) : [];
  const profileKeywords = perfil.profileKeywords || [];

  const activeThemes = dedupeStrings([
    ...clientKeywords.slice(0, 5),
    ...operatorKeywords.slice(0, 5),
    ...draftKeywords.slice(0, 5),
    ...profileKeywords.slice(0, modoAyuda === "enganche" ? 8 : 0)
  ]).slice(0, 16);

  const profileAvailable = modoAyuda === "enganche" && hasUsableProfile(perfil);

  let objective = "";
  let tone = "";

  if (pageType === "mail") {
    objective = "Mejorar una carta usando el contexto del mail, corrigiendo errores y extendiendo solo si aporta";
    tone = "natural, claro, cercano y bien redactado";
  } else if (modoAyuda === "enganche") {
    objective = "Crear una entrada atractiva usando datos reales del perfil sin fingir conversacion previa";
    tone = "curioso, natural, atractivo y sin presion";
  } else {
    objective = "Corregir el texto del operador usando la conversacion real y responder al momento actual";
    tone = "natural, calmado, contextual y emocionalmente inteligente";
  }

  const caso = {
    operador,
    pageType,
    modoAyuda,
    textoPlano,
    clientePlano,
    contextoPlano,
    contextLines: rawContextLines,
    perfil,
    chatSignals,
    tipoContacto: inferContactType({ pageType, modoAyuda }),
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
    affectionLoadHigh: countEndearments(operatorRecent.join(" ")) >= 4,
    profileAvailable,
    lastClientIsQuestion: /\?/.test(clientePlano || ""),
    objective,
    tone,
    targetLanguage: normalizeSpaces(input.target_language || input.targetLanguage || "English"),
    targetLanguageCode: normalizeSpaces(input.target_language_code || input.targetLanguageCode || "en").toLowerCase()
  };

  caso.memoryKey = getSuggestionMemoryKey(caso);

  return caso;
}

function buildInFlightSuggestionKey(input = {}) {
  return [
    normalizeText(input.operador || "anon").slice(0, 80),
    normalizeText(input.page_type || "chat"),
    normalizeText(input.modo_ayuda || "contexto"),
    normalizeText(input.texto || "").slice(0, 260),
    normalizeText(input.cliente || "").slice(0, 220),
    normalizeText(input.contexto || "").slice(-420),
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
    maxTokens: getMaxTokensForCase(caso),
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
  const recent = readRecentSuggestions(caso.memoryKey);
  const usages = [];
  const pool = [];
  let secondPassUsed = false;
  let openAiError = null;
  let firstPassOptions = [];
  let repairPassOptions = [];

  try {
    const firstPass = await callSuggestionModel(caso, recent);

    firstPassOptions = Array.isArray(firstPass.options) ? firstPass.options : [];

    if (firstPass.usageData) {
      usages.push(firstPass.usageData);
    }

    const firstCandidates = mapOptionsToCandidates(firstPassOptions, "openai_1", caso);
    pool.push(...firstCandidates);

    const selectedFirst = selectFinalCandidates(firstCandidates, caso);

    if (isWeakResult(firstCandidates, selectedFirst, caso)) {
      secondPassUsed = true;
      runtimeStats.suggestions.secondPasses += 1;

      const feedback = buildWeaknessFeedback(firstCandidates, caso);

      const repairPass = await callSuggestionModel(
        caso,
        recent,
        firstPassOptions,
        feedback,
        true
      );

      repairPassOptions = Array.isArray(repairPass.options) ? repairPass.options : [];

      if (repairPass.usageData) {
        usages.push(repairPass.usageData);
      }

      pool.push(...mapOptionsToCandidates(repairPassOptions, "openai_2", caso));
    }
  } catch (err) {
    openAiError = err;

    logError("SUGGESTIONS_OPENAI_FAILED_USING_FALLBACK", {
      operador: caso.operador,
      pageType: caso.pageType,
      modoAyuda: caso.modoAyuda,
      risk: caso.risk?.primary?.key || "none",
      texto_len: caso.textoPlano?.length || 0,
      contexto_len: caso.contextoPlano?.length || 0,
      perfil_disponible: Boolean(caso.profileAvailable),
      error: compactOpenAIError(err)
    });
  }

  pool.push(...mapOptionsToCandidates(fallbackSuggestions(caso), "fallback", caso));
  pool.push(...mapOptionsToCandidates(emergencySuggestions(caso), "emergency", caso));

  const selected = selectFinalCandidates(pool, caso);
  const final = ensureExactlyThreeSuggestions(selected, caso);

  if (final.length < 3 || selected.length < 3) {
    runtimeStats.suggestions.forcedFill += 1;
  }

  const usedFallbackOnly = selected.length
    ? selected.every((x) => x.source === "fallback" || x.source === "emergency")
    : true;

  if (usedFallbackOnly && LOG_FALLBACKS) {
    logWarn("SUGGESTIONS_FALLBACK_ONLY", {
      operador: caso.operador,
      pageType: caso.pageType,
      modoAyuda: caso.modoAyuda,
      risk: caso.risk?.primary?.key || "none",
      openai_error: openAiError ? compactOpenAIError(openAiError) : null,
      first_options_count: firstPassOptions.length,
      repair_options_count: repairPassOptions.length,
      final_count: final.length
    });
  }

  if (LOG_SUCCESS_SUMMARY && !usedFallbackOnly) {
    logInfo("SUGGESTIONS_OPENAI_USED", {
      operador: caso.operador,
      pageType: caso.pageType,
      modoAyuda: caso.modoAyuda,
      secondPassUsed,
      first_options_count: firstPassOptions.length,
      repair_options_count: repairPassOptions.length,
      usage: combineUsageData(usages)?.usage || null
    });
  }

  writeRecentSuggestions(caso.memoryKey, final);

  return {
    sugerencias: final,
    usageData: combineUsageData(usages),
    secondPassUsed,
    usedFallbackOnly,
    openAiError: openAiError ? compactOpenAIError(openAiError) : null,
    caso
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

function normalizeLanguagePayload(payload = {}) {
  const targetLanguage = normalizeSpaces(
    payload.target_language ||
    payload.targetLanguage ||
    payload.idioma ||
    payload.language ||
    "English"
  );

  const targetLanguageCode = normalizeSpaces(
    payload.target_language_code ||
    payload.targetLanguageCode ||
    payload.idioma_codigo ||
    payload.language_code ||
    "en"
  ).toLowerCase();

  return {
    target_language: targetLanguage || "English",
    target_language_code: targetLanguageCode || "en"
  };
}

function getTranslationCacheKey(text = "", languageCode = "en") {
  return `${normalizeText(languageCode || "en")}::${normalizeText(text).slice(0, 1800)}`;
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

function buildTranslationSystemPrompt(language = "English") {
  return [
    `Traduce el texto al idioma ${language}.`,
    "Debe sonar natural, humano y apropiado para chat o carta.",
    "Reglas:",
    "- no uses comillas",
    "- no expliques nada",
    "- no agregues notas",
    "- conserva intencion y tono",
    "- si el texto esta en el mismo idioma destino, mejoralo suavemente sin cambiar el sentido",
    "- devuelve solo una version final"
  ].join("\n");
}

async function translateTextCore(text = "", language = "English", languageCode = "en") {
  const maxTokens = text.length > 1200 ? 900 : text.length > 600 ? 520 : 240;

  const data = await callOpenAI({
    lane: "traduccion",
    model: OPENAI_MODEL_TRANSLATE,
    messages: [
      {
        role: "system",
        content: buildTranslationSystemPrompt(language)
      },
      { role: "user", content: String(text ?? "") }
    ],
    temperature: 0.22,
    maxTokens,
    timeoutMs: OPENAI_TIMEOUT_TRANSLATE_MS
  });

  const translated = cleanHuman(data?.choices?.[0]?.message?.content || "");

  if (!translated) {
    throw new Error(`No se pudo traducir a ${language}`);
  }

  return {
    traducido: translated,
    usageData: data,
    target_language: language,
    target_language_code: languageCode
  };
}

async function translateText(text = "", language = "English", languageCode = "en") {
  const cacheKey = getTranslationCacheKey(text, languageCode);
  const cached = readTranslationCache(cacheKey);

  if (cached) {
    return {
      traducido: cached,
      usageData: null,
      shared: false,
      cached: true,
      target_language: language,
      target_language_code: languageCode
    };
  }

  const sharedJob = getSharedInFlight(
    inflightTranslationJobs,
    cacheKey,
    () => translateTextCore(text, language, languageCode)
  );

  if (sharedJob.shared) {
    runtimeStats.translations.inflightHits += 1;
  }

  const result = await sharedJob.promise;
  writeTranslationCache(cacheKey, result.traducido);

  return {
    ...result,
    shared: sharedJob.shared,
    cached: false
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
 * MESSAGES SENT
 * ======================================================= */

function cleanMessagesSentCounts(raw = {}) {
  const total = Math.max(
    0,
    Math.min(9999999, Number.parseInt(raw.messages_sent_total, 10) || 0)
  );

  const plus100 = Math.max(
    0,
    Math.min(9999999, Number.parseInt(raw.messages_sent_100_plus, 10) || 0)
  );

  const under100 = Math.max(
    0,
    Math.min(9999999, Number.parseInt(raw.messages_sent_under_100, 10) || 0)
  );

  return {
    messages_sent_total: total,
    messages_sent_100_plus: plus100,
    messages_sent_under_100: under100
  };
}

async function saveMessagesSentSummary({
  operador = "",
  extension_id = "",
  fecha = "",
  counts = {}
}) {
  const operadorFinal = formatOperatorName(operador || "");
  const fechaFinal = isValidISODate(fecha) ? fecha : formatDateISO(new Date());
  const clean = cleanMessagesSentCounts(counts);

  const pendingTotal =
    clean.messages_sent_total +
    clean.messages_sent_100_plus +
    clean.messages_sent_under_100;

  if (!operadorFinal) {
    throw new Error("Operador invalido para messages sent");
  }

  if (pendingTotal <= 0) {
    return {
      rowsUpserted: 0,
      mode: "empty"
    };
  }

  const { error: rpcError } = await supabase.rpc("increment_message_resumen_diario", {
    p_operador: operadorFinal,
    p_extension_id: normalizeSpaces(extension_id) || "",
    p_fecha: fechaFinal,
    p_messages_sent_total: clean.messages_sent_total,
    p_messages_sent_100_plus: clean.messages_sent_100_plus,
    p_messages_sent_under_100: clean.messages_sent_under_100
  });

  if (!rpcError) {
    return {
      rowsUpserted: 1,
      mode: "rpc"
    };
  }

  const { data: existing, error: readError } = await supabase
    .from("message_resumen_diario")
    .select("messages_sent_total,messages_sent_100_plus,messages_sent_under_100")
    .eq("operador", operadorFinal)
    .eq("fecha", fechaFinal)
    .maybeSingle();

  if (readError) {
    throw new Error(readError.message || "No se pudo leer message_resumen_diario");
  }

  const payload = {
    operador: operadorFinal,
    extension_id: normalizeSpaces(extension_id) || "",
    fecha: fechaFinal,
    messages_sent_total:
      Number(existing?.messages_sent_total || 0) + clean.messages_sent_total,
    messages_sent_100_plus:
      Number(existing?.messages_sent_100_plus || 0) + clean.messages_sent_100_plus,
    messages_sent_under_100:
      Number(existing?.messages_sent_under_100 || 0) + clean.messages_sent_under_100,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("message_resumen_diario")
    .upsert([payload], {
      onConflict: "operador,fecha"
    });

  if (error) {
    throw new Error(error.message || "No se pudo guardar messages sent");
  }

  return {
    rowsUpserted: 1,
    mode: "upsert"
  };
}

async function loadMessagesSentRange(range, operadoresFiltrados = []) {
  return selectAllPages((from, to) => {
    let query = supabase
      .from("message_resumen_diario")
      .select("operador,extension_id,fecha,messages_sent_total,messages_sent_100_plus,messages_sent_under_100,created_at,updated_at")
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

function ensureMessagesSentFields(target = {}) {
  if (target.messages_sent_total === undefined) {
    target.messages_sent_total = 0;
  }

  if (target.messages_sent_100_plus === undefined) {
    target.messages_sent_100_plus = 0;
  }

  if (target.messages_sent_under_100 === undefined) {
    target.messages_sent_under_100 = 0;
  }

  return target;
}

function createOperatorMessageStat(operador = "") {
  return {
    operador,
    requests_total: 0,
    ok_requests: 0,
    error_requests: 0,
    ia_requests: 0,
    ia_enganche_requests: 0,
    ia_contexto_requests: 0,
    ia_mail_requests: 0,
    trad_requests: 0,
    cache_hits: 0,
    shared_hits: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0,
    messages_sent_total: 0,
    messages_sent_100_plus: 0,
    messages_sent_under_100: 0,
    last_activity: ""
  };
}

function createSerieMessageStat(fecha = "") {
  return {
    fecha,
    requests_total: 0,
    ia_requests: 0,
    trad_requests: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0,
    messages_sent_total: 0,
    messages_sent_100_plus: 0,
    messages_sent_under_100: 0
  };
}

function applyMessagesSentToDashboard(dashboard = {}, messageRows = []) {
  if (!dashboard.summary) dashboard.summary = {};

  ensureMessagesSentFields(dashboard.summary);

  const operatorMap = new Map();

  for (const op of dashboard.operator_stats || []) {
    ensureMessagesSentFields(op);
    operatorMap.set(formatOperatorName(op.operador || "Anon") || "Anon", op);
  }

  const seriesMap = new Map();

  for (const serie of dashboard.series || []) {
    ensureMessagesSentFields(serie);
    seriesMap.set(String(serie.fecha || ""), serie);
  }

  for (const row of messageRows || []) {
    const operador = formatOperatorName(row.operador || "Anon") || "Anon";
    const fecha = String(row.fecha || "");
    const total = Number(row.messages_sent_total || 0);
    const plus100 = Number(row.messages_sent_100_plus || 0);
    const under100 = Number(row.messages_sent_under_100 || 0);
    const lastActivity = String(row.updated_at || row.created_at || "");

    dashboard.summary.messages_sent_total += total;
    dashboard.summary.messages_sent_100_plus += plus100;
    dashboard.summary.messages_sent_under_100 += under100;

    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, createOperatorMessageStat(operador));
    }

    const op = operatorMap.get(operador);

    ensureMessagesSentFields(op);

    op.messages_sent_total += total;
    op.messages_sent_100_plus += plus100;
    op.messages_sent_under_100 += under100;

    if (lastActivity && (!op.last_activity || lastActivity > op.last_activity)) {
      op.last_activity = lastActivity;
    }

    if (fecha) {
      if (!seriesMap.has(fecha)) {
        seriesMap.set(fecha, createSerieMessageStat(fecha));
      }

      const serie = seriesMap.get(fecha);

      ensureMessagesSentFields(serie);

      serie.messages_sent_total += total;
      serie.messages_sent_100_plus += plus100;
      serie.messages_sent_under_100 += under100;
    }
  }

  dashboard.operator_stats = Array.from(operatorMap.values())
    .map((op) => ({
      ...op,
      estimated_cost_total: roundMoney(op.estimated_cost_total || 0)
    }))
    .sort((a, b) => {
      if (
        Number(b.estimated_cost_total || 0) !==
        Number(a.estimated_cost_total || 0)
      ) {
        return Number(b.estimated_cost_total || 0) - Number(a.estimated_cost_total || 0);
      }

      if (
        Number(b.messages_sent_total || 0) !==
        Number(a.messages_sent_total || 0)
      ) {
        return Number(b.messages_sent_total || 0) - Number(a.messages_sent_total || 0);
      }

      return String(a.operador || "").localeCompare(String(b.operador || ""));
    });

  dashboard.series = Array.from(seriesMap.values())
    .map((serie) => ({
      ...serie,
      estimated_cost_total: roundMoney(serie.estimated_cost_total || 0)
    }))
    .sort((a, b) => String(a.fecha || "").localeCompare(String(b.fecha || "")));

  return dashboard;
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
 * DASHBOARD
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
    ia_enganche_requests: 0,
    ia_contexto_requests: 0,
    ia_mail_requests: 0,
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
    ia_enganche_requests: 0,
    ia_contexto_requests: 0,
    ia_mail_requests: 0,
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

function applyTipoCounters(target, tipo = "") {
  const t = String(tipo || "").toUpperCase();

  if (t.startsWith("IA")) target.ia_requests += 1;
  if (t.startsWith("IA_ENGANCHE")) target.ia_enganche_requests += 1;
  if (t.startsWith("IA_CONTEXTO")) target.ia_contexto_requests += 1;
  if (t.startsWith("IA_MAIL")) target.ia_mail_requests += 1;
  if (t.startsWith("TRAD")) target.trad_requests += 1;
  if (t.endsWith("_CACHE")) target.cache_hits += 1;
  if (t.endsWith("_SHARED")) target.shared_hits += 1;
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
    applyTipoCounters(summary, tipo);

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
    applyTipoCounters(op, tipo);

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
    service: "server unico split-ai profile-context-mail-translate-debug",
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
      chat_max_tokens: SUGGESTION_MAX_TOKENS,
      mail_max_tokens: MAIL_MAX_TOKENS,
      chat_target_lengths: CHAT_TARGET_SPECS,
      mail_target_lengths: MAIL_TARGET_SPECS,
      split_buttons: true,
      dynamic_translation_language: true,
      force_three_options: true,
      debug_openai: DEBUG_OPENAI,
      log_fallbacks: LOG_FALLBACKS,
      log_success_summary: LOG_SUCCESS_SUMMARY
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

   const [consumoRows, warningRows, messageRows] = await Promise.all([
  loadConsumptionRange(range, operadoresFiltrados),
  loadWarningsRange(range, operadoresFiltrados),
  loadMessagesSentRange(range, operadoresFiltrados)
]);

const dashboard = buildDashboardAnalytics({
  consumoRows,
  warningRows,
  range,
  operadoresFiltrados
});

applyMessagesSentToDashboard(dashboard, messageRows);

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
app.post("/messages-sync", authorizeOperator, async (req, res) => {
  try {
    const { extension_id = "", fecha = "", counts = {} } = req.body || {};

    const result = await saveMessagesSentSummary({
      operador: req.operadorAutorizado,
      extension_id,
      fecha,
      counts
    });

    return res.json({
      ok: true,
      rows_upserted: result.rowsUpserted || 0,
      mode: result.mode || "unknown"
    });
  } catch (err) {
    return res.json({
      ok: false,
      error: err.message || "No se pudo sincronizar messages sent"
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
      page_type = "chat",
      modo_ayuda = "contexto_correccion",
      target_language = "English",
      target_language_code = "en"
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
      page_type,
      modo_ayuda,
      target_language,
      target_language_code
    });

    const tipoBase = getOutputType(resultado.caso || buildCase({
      operador,
      texto,
      contexto,
      cliente,
      perfil,
      chat_signals,
      page_type,
      modo_ayuda,
      target_language,
      target_language_code
    }));

    if (tipoBase === "IA_ENGANCHE") runtimeStats.suggestions.enganche += 1;
    if (tipoBase === "IA_CONTEXTO") runtimeStats.suggestions.contexto += 1;
    if (tipoBase === "IA_MAIL") runtimeStats.suggestions.mail += 1;

    const tipo = resultado.shared
      ? `${tipoBase}_SHARED`
      : resultado.usedFallbackOnly
        ? `${tipoBase}_FALLBACK`
        : resultado.secondPassUsed
          ? `${tipoBase}_2PASS`
          : tipoBase;

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
            page_type,
            modo_ayuda,
            target_language,
            target_language_code
          })),
      meta: {
        tipo,
        modo_ayuda,
        page_type,
        used_fallback_only: Boolean(resultado.usedFallbackOnly),
        second_pass_used: Boolean(resultado.secondPassUsed),
        openai_error: resultado.openAiError || null
      }
    });
  } catch (err) {
    registerConsumptionAsync({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "IA_ERROR",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    runtimeStats.suggestions.error += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    logError("SUGGESTIONS_ROUTE_ERROR", {
      operador,
      error: compactOpenAIError(err)
    });

    try {
      const caso = buildCase({
        operador,
        texto: req.body?.texto || "",
        contexto: req.body?.contexto || "",
        cliente: req.body?.cliente || "",
        perfil: req.body?.perfil || "",
        chat_signals: req.body?.chat_signals || {},
        page_type: req.body?.page_type || "chat",
        modo_ayuda: req.body?.modo_ayuda || "contexto_correccion",
        target_language: req.body?.target_language || "English",
        target_language_code: req.body?.target_language_code || "en"
      });

      return res.json({
        ok: true,
        sugerencias: ensureExactlyThreeSuggestions([], caso),
        meta: {
          tipo: "IA_ERROR_FALLBACK",
          used_fallback_only: true,
          openai_error: compactOpenAIError(err)
        }
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

    const language = normalizeLanguagePayload(req.body || {});
    const result = await translateText(
      text,
      language.target_language,
      language.target_language_code
    );

    const tipoBase = `TRAD_${String(language.target_language_code || "en").toUpperCase()}`;
    const tipo = result.cached
      ? `${tipoBase}_CACHE`
      : result.shared
        ? `${tipoBase}_SHARED`
        : tipoBase;

    if (result.cached) runtimeStats.translations.cacheHits += 1;

    registerConsumptionAsync({
      operador,
      extension_id,
      data: result.shared || result.cached ? null : result.usageData,
      tipo,
      mensaje_operador: text,
      request_ok: true
    });

    runtimeStats.translations.ok += 1;
    runtimeStats.translations.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      traducido: result.traducido,
      target_language: language.target_language,
      target_language_code: language.target_language_code
    });
  } catch (err) {
    registerConsumptionAsync({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "TRAD_ERROR",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    runtimeStats.translations.error += 1;
    runtimeStats.translations.lastMs = Date.now() - startedAt;

    logError("TRANSLATION_ROUTE_ERROR", {
      operador,
      error: compactOpenAIError(err)
    });

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
  console.log(`Server split IA debug activo en puerto ${PORT}`);
  console.log(`Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`);
  console.log(`CHAT SUGGESTION_MAX_TOKENS => ${SUGGESTION_MAX_TOKENS}`);
  console.log(`MAIL_MAX_TOKENS => ${MAIL_MAX_TOKENS}`);
  console.log(`DEBUG_OPENAI => ${DEBUG_OPENAI}`);
  console.log(`LOG_FALLBACKS => ${LOG_FALLBACKS}`);
  console.log(`LOG_SUCCESS_SUMMARY => ${LOG_SUCCESS_SUMMARY}`);
  console.log(`Rangos chat => 1:${CHAT_TARGET_SPECS[0].min}-${CHAT_TARGET_SPECS[0].max}, 2:${CHAT_TARGET_SPECS[1].min}-${CHAT_TARGET_SPECS[1].max}, 3:${CHAT_TARGET_SPECS[2].min}-${CHAT_TARGET_SPECS[2].max}`);
  console.log(`Rangos mail => 1:${MAIL_TARGET_SPECS[0].min}-${MAIL_TARGET_SPECS[0].max}, 2:${MAIL_TARGET_SPECS[1].min}-${MAIL_TARGET_SPECS[1].max}, 3:${MAIL_TARGET_SPECS[2].min}-${MAIL_TARGET_SPECS[2].max}`);
});
