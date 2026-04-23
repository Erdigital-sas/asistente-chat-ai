const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID, timingSafeEqual, createHmac } = require("crypto");

/* =========================================================
 * ENV / CONFIG
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
  17000,
  8000,
  45000
);

const OPENAI_TIMEOUT_TRANSLATE_MS = readIntEnv(
  "OPENAI_TIMEOUT_TRANSLATE_MS",
  10000,
  4000,
  25000
);

const SUGGESTION_MAX_TOKENS = readIntEnv(
  "SUGGESTION_MAX_TOKENS",
  580,
  180,
  1200
);

const MAX_CONTEXT_LINES = readIntEnv("MAX_CONTEXT_LINES", 8, 4, 15);
const MIN_RESPONSE_LENGTH = readIntEnv("MIN_RESPONSE_LENGTH", 55, 20, 180);

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
  60,
  1,
  300
);

const TRANSLATION_OPENAI_QUEUE_LIMIT = readIntEnv(
  "TRANSLATION_OPENAI_QUEUE_LIMIT",
  30,
  1,
  200
);

const SUGGESTION_OPENAI_QUEUE_WAIT_MS = readIntEnv(
  "SUGGESTION_OPENAI_QUEUE_WAIT_MS",
  12000,
  1000,
  30000
);

const TRANSLATION_OPENAI_QUEUE_WAIT_MS = readIntEnv(
  "TRANSLATION_OPENAI_QUEUE_WAIT_MS",
  6000,
  1000,
  20000
);

const PER_OPERATOR_SUGGESTION_QUEUE_LIMIT = readIntEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_LIMIT",
  3,
  1,
  10
);

const PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS = readIntEnv(
  "PER_OPERATOR_SUGGESTION_QUEUE_WAIT_MS",
  12000,
  1000,
  30000
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
  { min: 90, max: 170, ideal: 125 },
  { min: 100, max: 190, ideal: 140 },
  { min: 120, max: 230, ideal: 170 }
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
 * GENERIC UTILS
 * ======================================================= */

function createRequestId() {
  try {
    return randomUUID();
  } catch (_err) {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
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

function compact(text = "", maxChars = 1200) {
  const clean = String(text ?? "").trim();
  if (!clean) return "";
  return clean.length <= maxChars ? clean : clean.slice(-maxChars);
}

function dedupeStrings(items = []) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const clean = normalizeSpaces(String(item || ""));
    const key = normalizeText(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function cleanLine(text = "") {
  return cleanHuman(
    String(text ?? "")
      .replace(/^\s*\d+[\).\-\s:]*/, "")
      .replace(/^\s*[•\-–—]+\s*/, "")
  );
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(n = 0) {
  return Number(safeNumber(n, 0).toFixed(6));
}

function formatDateISO(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function firstDayOfMonthUTC(date = new Date()) {
  return formatDateISO(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
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
    const tmp = from;
    from = to;
    to = tmp;
  }

  return {
    from,
    to,
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${addDaysISO(to, 1)}T00:00:00.000Z`
  };
}

async function selectAllPages(builderFactory, pageSize = 1000) {
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await builderFactory(from, from + pageSize - 1);

    if (error) {
      throw error;
    }

    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);

    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return rows;
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
 * OPERATOR AUTH
 * ======================================================= */

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

function formatOperatorName(name = "") {
  return normalizeSpaces(name)
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
 * OPENAI LIMITERS / QUEUES
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
 * SUGGESTIONS ENGINE
 * ======================================================= */

const STOPWORDS = new Set([
  "a", "al", "algo", "alguien", "alla", "allá", "and", "ante", "antes", "asi",
  "así", "aqui", "aquí", "be", "but", "by", "como", "con", "cual", "cuales",
  "cuáles", "de", "del", "do", "donde", "dónde", "el", "ella", "ellas", "ellos",
  "en", "eres", "es", "esa", "esas", "ese", "eso", "esos", "esta", "está",
  "estas", "este", "esto", "estos", "for", "from", "gracias", "ha", "hay",
  "he", "hola", "how", "i", "is", "it", "la", "las", "lo", "los", "me", "mi",
  "mis", "mucho", "muy", "my", "no", "nos", "o", "of", "on", "or", "para",
  "pero", "por", "porque", "que", "qué", "quien", "quién", "se", "si", "sí",
  "sin", "so", "su", "sus", "te", "that", "the", "this", "to", "tu", "tus",
  "un", "una", "uno", "unos", "unas", "was", "we", "what", "where", "which",
  "who", "why", "y", "ya", "yo", "you", "your"
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

const META_REGEX = /\b(responderte mejor|escribirte mejor|tu vibra|tu energia|tu energía|como te decia|como te decía|frase vacia|frase vacía|mejor dicho|te respondí mejor)\b/i;
const DISALLOWED_CONTACT_REGEX = /\b(whatsapp|telegram|instagram|insta|snapchat|snap|discord|email|correo|telefono|teléfono|numero|número|phone)\b/i;
const DISALLOWED_MEET_REGEX = /\b(vernos|en persona|salir|cafe|café|cena|drink|dinner|direccion|dirección|hotel|llamame|llámame|llamarte|call me)\b/i;
const EMPTY_MIRROR_REGEX = /^(entiendo|tiene sentido|lo que dices|gracias por decirme|te entiendo|suena bien|claro)\b/i;
const EMPTY_GENERIC_START_REGEX = /^(hola|hey|buenas|como estas|cómo estás|que tal|qué tal)\b/i;
const ONE_WORD_MIRROR_REGEX = /\b(eso que dijiste sobre|lo que dijiste sobre|ah[ií] en lo de)\b/i;

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
    guidance: "No inventes políticas ni cobros. Responde con prudencia y sin vender humo."
  },
  redes_externas: {
    key: "redes_externas",
    label: "Redes externas detectadas",
    severity: 90,
    guidance: "No confirmes identidades externas ni saques la conversación fuera."
  },
  abandono_ritmo_contacto: {
    key: "abandono_ritmo_contacto",
    label: "Abandono por ritmo o contacto",
    severity: 95,
    guidance: "Baja presión, valida el ritmo y evita que la conversación se pierda."
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

function sanitizeLocation(raw = "") {
  const text = cleanHuman(raw);
  if (!text) return "";
  if (text.length < 3 || text.length > 32) return "";
  if (/\d/.test(text)) return "";
  if (/^(about|bio|interested in|looking for|my content|present requests)$/i.test(normalizeText(text))) {
    return "";
  }
  return text;
}

function parseProfile(perfil = "") {
  const raw = String(perfil || "");

  const getLine = (label) => {
    const match = raw.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    return match ? match[1].trim() : "";
  };

  const splitPipe = (text) =>
    dedupeStrings(
      String(text || "")
        .split("|")
        .map((x) => normalizeSpaces(x))
        .filter(Boolean)
    );

  return {
    interesesEnComun: splitPipe(getLine("INTERESES_EN_COMUN")),
    interesesClienta: splitPipe(getLine("INTERESES_CLIENTA")),
    ubicacionClienta: sanitizeLocation(getLine("UBICACION_CLIENTA")),
    datosClienta: splitPipe(getLine("DATOS_CLIENTA"))
  };
}

function pickProfileDetail(perfil = {}, text = "") {
  const joined = normalizeText(text);

  const pool = [
    ...(perfil.interesesEnComun || []).map((value) => ({ type: "interes_comun", value })),
    ...(perfil.interesesClienta || []).map((value) => ({ type: "interes_clienta", value })),
    ...(perfil.datosClienta || []).map((value) => ({ type: "dato_clienta", value }))
  ];

  for (const item of pool) {
    const key = normalizeText(item.value);
    if (key && joined.includes(key)) return item;
  }

  if (
    /\b(de donde eres|donde eres|donde vives|where are you from|where do you live)\b/.test(joined) &&
    perfil.ubicacionClienta
  ) {
    return { type: "ubicacion", value: perfil.ubicacionClienta };
  }

  if (pool.length) return pool[0];
  if (perfil.ubicacionClienta) return { type: "ubicacion", value: perfil.ubicacionClienta };

  return { type: "none", value: "" };
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
  const lastDialogRole = getLastDialogRole(contextLines);

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
    /\b(sigues ahi|sigues ahí|no respondes|desapareciste|me dejaste en visto|retomar|retomo)\b/.test(
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

  const hasContactWords = /\b(whatsapp|telegram|instagram|insta|snapchat|snap|discord|facebook|tiktok|twitter|numero|número|telefono|teléfono|phone|mail|email|correo)\b/.test(text);
  const hasOffAppWords = /\b(fuera de la app|por otra app|otra app|outside the app|text me|call me|add me|escribeme|escríbeme|pasame|pásame|pasa tu|dame tu|te dejo mi|my number|mi numero|mi número|mi telefono|mi teléfono)\b/.test(text);
  if (hasContactWords || hasOffAppWords) {
    pushRisk(RISK_CATALOG.contacto_externo);
  }

  const hasPaymentWords = /\b(gratis|gratuito|free|premium|suscripcion|suscripción|subscription|tokens|coins|credits|billing|pago|pagar|pay|cuesta|cobra|cobran)\b/.test(text);
  const hasPlatformWords = /\b(plataforma|platform|app|cuenta|account|usuario|user)\b/.test(text);
  if (hasPaymentWords && hasPlatformWords) {
    pushRisk(RISK_CATALOG.pregunta_pago_plataforma);
  }

  const hasSocialWords = /\b(instagram|insta|facebook|tiktok|snapchat|snap|twitter|redes sociales|social media)\b/.test(text);
  const hasFoundWords = /\b(encontre|encontré|vi|found|i found|te vi|saw|tu perfil|your profile|outside|afuera)\b/.test(text);
  if (hasSocialWords && hasFoundWords) {
    pushRisk(RISK_CATALOG.redes_externas);
  }

  const hasRhythmWords = /\b(no puedo seguir el ritmo|no puedo mantener el ritmo|cant keep up|cannot keep up|too fast|demasiado rapido|demasiado rápido|mucha intensidad|me abruma|me supera|no tengo tiempo|sin tiempo|busy|ocupad[oa]|hablamos luego|talk later)\b/.test(text);
  const hasLeaveContactWords = /\b(te dejo mi|mi numero|mi número|mi telefono|mi teléfono|whatsapp|telegram|email|correo)\b/.test(text);
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
      guidance: "Mantener una conversación natural y útil dentro del chat."
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
  if (caso.mode === "REAPERTURA_SUAVE") return "REENGANCHAR";

  return "MANTENER_CONVERSACION";
}

function detectObjective(caso = {}) {
  switch (caso.intent) {
    case "ACLARAR_Y_REDIRECCIONAR":
      return "Aclarar sin inventar políticas ni pagos y mantener viva la conversación dentro del chat";
    case "CONTENER_Y_MANTENER_AQUI":
      return "Redirigir con naturalidad para seguir aquí sin sonar cortante";
    case "RETENER_SIN_PRESION":
      return "Bajar intensidad, validar el ritmo y evitar que la conversación se caiga";
    case "DAR_CONFIANZA":
      return "Reducir desconfianza con una respuesta clara, humana y nada defensiva";
    case "ENGANCHAR":
      return "Abrir con curiosidad concreta y fácil de responder";
    case "REENGANCHAR":
      return "Reabrir sin reclamo y con una razón real para seguir";
    default:
      return "Responder lo último de ella y avanzar con un gancho claro";
  }
}

function detectTone(caso = {}) {
  switch (caso.risk?.primary?.key) {
    case "pregunta_pago_plataforma":
      return "claro, prudente y natural";
    case "contacto_externo":
    case "redes_externas":
      return "cálido, firme y relajado";
    case "abandono_ritmo_contacto":
      return "tranquilo, empático y sin presión";
    case "desconfianza_realidad":
      return "claro, sereno y humano";
    default:
      break;
  }

  if (caso.mode === "APERTURA_FRIA") return "ligero, curioso y humano";
  if (caso.mode === "REAPERTURA_SUAVE") return "suave, relajado y sin reclamo";
  return "natural, cálido y útil";
}

function extractKeywords(text = "") {
  const counts = new Map();

  for (const word of normalizeText(text).split(/\s+/)) {
    if (!word) continue;
    if (word.length < 4) continue;
    if (STOPWORDS.has(word)) continue;
    if (BANNED_TOPIC_WORDS.has(word)) continue;
    if (!/^[a-z0-9]+$/i.test(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
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

function getSuggestionMemoryKey(caso = {}) {
  return [
    normalizeText(caso.operador || "anon").slice(0, 80),
    normalizeText(caso.mode || "x"),
    normalizeText(caso.textoPlano || "").slice(0, 220),
    normalizeText(caso.clientePlano || "").slice(0, 180),
    normalizeText(caso.contextoPlano || "").slice(-260)
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
  if (length < MIN_RESPONSE_LENGTH) return 0;

  const min = Number(spec.min || MIN_RESPONSE_LENGTH);
  const max = Number(spec.max || min + 100);
  const ideal = Number(spec.ideal || Math.round((min + max) / 2));

  if (length >= min && length <= max) {
    const span = Math.max(1, Math.max(ideal - min, max - ideal));
    const dist = Math.abs(length - ideal);
    return Math.max(0, Math.min(1, 1 - ((dist / span) * 0.35)));
  }

  if (length < min) {
    const gap = min - length;
    return Math.max(0, Math.min(1, 0.65 - (gap / Math.max(1, min))));
  }

  const gap = length - max;
  return Math.max(0, Math.min(1, 0.75 - (gap / Math.max(1, max))));
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
  if (DISALLOWED_CONTACT_REGEX.test(n)) return true;
  if (DISALLOWED_MEET_REGEX.test(n)) return true;
  if (META_REGEX.test(n)) return true;

  if (caso.mode !== "APERTURA_FRIA" && EMPTY_GENERIC_START_REGEX.test(n) && countChars(s) < 85) {
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

  score += scoreLength(length, spec) * 0.32;
  score += countQuestions(s) <= 1 ? 0.08 : -0.15;

  const overlapClient = keywordOverlap(s, caso.clientKeywords || []);
  const overlapDraft = keywordOverlap(s, caso.draftKeywords || []);
  const overlapDetail = keywordOverlap(s, caso.detailKeywords || []);
  const overlapOperator = keywordOverlap(s, caso.operatorKeywords || []);
  const overlapThemes = keywordOverlap(s, caso.activeThemes || []);

  if (caso.mode === "RESPUESTA_CHAT") {
    score += overlapClient > 0 ? 0.20 : -0.12;
    score += overlapOperator > 0 ? 0.08 : 0;
  } else {
    score += (overlapDraft > 0 || overlapDetail > 0 || overlapOperator > 0) ? 0.14 : 0;
  }

  if (overlapThemes > 0) {
    score += 0.10;
  }

  if (caso.detallePerfil?.value && overlapDetail > 0) {
    score += 0.08;
  }

  if (EMPTY_MIRROR_REGEX.test(n)) {
    score -= 0.18;
  }

  if (ONE_WORD_MIRROR_REGEX.test(n)) {
    score -= 0.20;
  }

  if (EMPTY_GENERIC_START_REGEX.test(n) && caso.mode !== "APERTURA_FRIA") {
    score -= 0.10;
  }

  if (
    ["contacto_externo", "redes_externas"].includes(caso.risk?.primary?.key) &&
    /\b(aqui|aquí|por aqui|por aquí|por este chat|por el chat)\b/.test(n)
  ) {
    score += 0.12;
  }

  if (
    caso.risk?.primary?.key === "abandono_ritmo_contacto" &&
    /\b(con calma|sin presion|sin presión|a tu ritmo|tranqui)\b/.test(n)
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

  if (
    caso.mode === "RESPUESTA_CHAT" &&
    (caso.lastClientIsQuestion || false) &&
    overlapClient === 0
  ) {
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

  for (const item of ranked) {
    if (selected.some((x) => looksTooSimilar(x.text, item.text))) continue;
    selected.push(item);
    if (selected.length >= 3) break;
  }

  return selected.sort((a, b) => a.length - b.length || b.score - a.score);
}

function isWeakResult(candidates = [], selected = []) {
  if (selected.length < 3) return true;
  const avg = selected.reduce((sum, item) => sum + item.score, 0) / selected.length;
  if (avg < 0.60) return true;
  return selected.some((item) => item.score < 0.48) || !candidates.length;
}

function buildWeaknessFeedback(candidates = [], caso = {}) {
  const notes = [];

  if (!candidates.length) notes.push("- No salieron opciones utilizables.");

  const avgLength = candidates.length
    ? candidates.reduce((sum, item) => sum + item.length, 0) / candidates.length
    : 0;

  if (avgLength && avgLength < TARGET_SUGGESTION_SPECS[0].min) {
    notes.push("- Están demasiado cortas.");
  }

  if (
    caso.mode === "RESPUESTA_CHAT" &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.clientKeywords || []) === 0)
  ) {
    notes.push("- Falta alusión real a lo último de la clienta.");
  }

  if (
    candidates.length &&
    candidates.some((item) => ONE_WORD_MIRROR_REGEX.test(normalizeText(item.text)))
  ) {
    notes.push("- Evita fórmulas tipo 'eso que dijiste sobre X' o 'ahí en lo de X'.");
  }

  if (
    caso.operatorKeywords?.length &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.operatorKeywords || []) === 0) &&
    caso.mode !== "RESPUESTA_CHAT"
  ) {
    notes.push("- Conserva mejor el hilo que el operador ya venía construyendo.");
  }

  if (
    caso.detallePerfil?.value &&
    caso.mode !== "RESPUESTA_CHAT" &&
    candidates.length &&
    candidates.every((item) => keywordOverlap(item.text, caso.detailKeywords || []) === 0)
  ) {
    notes.push("- Puedes usar un detalle del perfil si realmente suma.");
  }

  if (
    caso.risk?.primary?.key === "contacto_externo" &&
    candidates.length &&
    candidates.every((item) => !/\b(aqui|aquí|por aqui|por aquí|por este chat|por el chat)\b/i.test(normalizeText(item.text)))
  ) {
    notes.push("- Redirige con más naturalidad a seguir aquí.");
  }

  if (
    caso.risk?.primary?.key === "abandono_ritmo_contacto" &&
    candidates.length &&
    candidates.every((item) => !/\b(con calma|sin presion|sin presión|a tu ritmo|tranqui)\b/i.test(normalizeText(item.text)))
  ) {
    notes.push("- Falta bajar presión y validar el ritmo.");
  }

  if (!notes.length) {
    notes.push("- Hazlas más específicas, más útiles y menos genéricas.");
  }

  return notes.join("\n");
}

function buildSpecText() {
  return TARGET_SUGGESTION_SPECS
    .map((spec, index) => `${index + 1}. ${spec.min}-${spec.max} caracteres`)
    .join("\n");
}

function buildSystemPrompt(caso = {}) {
  return [
    "Eres el motor de sugerencias de una herramienta interna de chat.",
    "Debes devolver exactamente 3 opciones finales en español, listas para enviar.",
    "Tu trabajo es ayudar al operador a responder mejor usando el hilo real de la conversación.",
    "",
    `Objetivo principal: ${caso.objective}`,
    `Tono: ${caso.tone}`,
    `Modo: ${caso.mode}`,
    `Riesgo primario: ${caso.risk?.primary?.label || "Sin riesgo especial"}`,
    "",
    "PRIORIDADES",
    "- responder primero a lo último de la clienta cuando exista mensaje real",
    "- conservar el hilo que el operador ya viene construyendo",
    "- sonar humano, concreto y útil",
    "- usar hechos reales del chat antes que frases genéricas",
    "",
    "REGLAS OBLIGATORIAS",
    "- si no existe mensaje nuevo de la clienta, no escribas como si ya hubiera contestado",
    "- cada opción debe ser distinta de verdad",
    "- usa 1 o 2 frases por opción",
    "- máximo 1 pregunta por opción",
    "- sin emojis",
    "- sin comillas",
    "- sin nombres inventados",
    "- sin ciudades inventadas",
    "- no inventes políticas, pagos, tarifas, soporte ni condiciones de la plataforma",
    "- no pidas ni aceptes contacto externo",
    "- no invites a salir de la app",
    "- no propongas encuentros, direcciones ni llamadas",
    "- evita presión, culpa o manipulación",
    "- evita frases espejo o vacías",
    "- evita fórmulas como 'eso que dijiste sobre X' si X es solo una palabra suelta",
    "- usa como máximo un detalle de perfil si ayuda de verdad",
    "- si el borrador está flojo, reházalo por completo",
    "",
    "VARIACIÓN DESEADA",
    "1. directa y fácil de enviar",
    "2. cálida y alusiva",
    "3. más trabajada y con mejor gancho, sin sonar pesada",
    "",
    "LARGO ORIENTATIVO",
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
      `- intención detectada: ${caso.intent}`,
      `- objetivo: ${caso.objective}`,
      `- tono: ${caso.tone}`,
      `- riesgo primario: ${caso.risk?.primary?.label || "Sin riesgo especial"}`,
      `- guía de riesgo: ${caso.risk?.primary?.guidance || "Mantener conversación natural y útil"}`
    ].join("\n"),
    [
      "BORRADOR DEL OPERADOR",
      '"""',
      caso.textoPlano || "Sin borrador claro",
      '"""'
    ].join("\n"),
    [
      "ÚLTIMO MENSAJE REAL DE LA CLIENTA",
      '"""',
      caso.clientePlano || "Sin mensaje claro de la clienta",
      '"""'
    ].join("\n"),
    [
      "CONTEXTO RECIENTE",
      '"""',
      caso.contextoPlano || "Sin contexto útil",
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
      "KEYWORDS",
      `- clienta: ${(caso.clientKeywords || []).join(" | ") || "ninguna"}`,
      `- operador: ${(caso.operatorKeywords || []).join(" | ") || "ninguna"}`,
      `- temas activos: ${(caso.activeThemes || []).join(" | ") || "ninguno"}`
    ].join("\n"),
    [
      "PERFIL RESUMIDO",
      `- intereses en común: ${(caso.perfil?.interesesEnComun || []).join(" | ") || "ninguno"}`,
      `- intereses de la clienta: ${(caso.perfil?.interesesClienta || []).join(" | ") || "ninguno"}`,
      `- datos de la clienta: ${(caso.perfil?.datosClienta || []).join(" | ") || "ninguno"}`,
      `- ubicación útil: ${caso.perfil?.ubicacionClienta || "ninguna"}`,
      `- detalle prioritario: ${caso.detallePerfil?.value || "ninguno"}`
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
    "IMPORTANTE",
    "- haz opciones con alusión real, no plantillas",
    "- no copies el borrador si está pobre",
    "- deja una salida fácil para que la otra persona responda",
    "- mantén todo dentro de la plataforma",
    "- no construyas las 3 opciones alrededor de una sola keyword débil"
  ].join("\n"));

  return blocks.join("\n\n").trim();
}

function pickTemperature(caso = {}, isRepair = false) {
  let t = 0.78;

  if (caso.mode === "APERTURA_FRIA") t = 0.86;
  if (caso.mode === "REAPERTURA_SUAVE") t = 0.82;
  if (caso.mode === "RESPUESTA_CHAT") t = 0.72;

  switch (caso.risk?.primary?.key) {
    case "pregunta_pago_plataforma":
      t = 0.62;
      break;
    case "contacto_externo":
    case "redes_externas":
      t = 0.70;
      break;
    case "abandono_ritmo_contacto":
      t = 0.68;
      break;
    case "desconfianza_realidad":
      t = 0.66;
      break;
    default:
      break;
  }

  if (isRepair) {
    return Math.max(0.58, Math.min(0.9, t - 0.08));
  }

  return Math.max(0.58, Math.min(0.9, t));
}

function fallbackRiskSuggestions(caso = {}) {
  switch (caso.risk?.primary?.key) {
    case "contacto_externo":
      return [
        "Prefiero que la charla siga por aquí y sin correr. Ya que estamos, dime qué fue lo que de verdad te dio curiosidad para escribirme.",
        "Podemos llevarlo tranquilo por este chat. Me interesa más que la conversación fluya bien aquí que saltar de una app a otra.",
        "Antes de mover nada fuera de aquí prefiero ver si de verdad la charla tiene sentido. Cuéntame qué tipo de conversación sí te engancha cuando alguien te interesa."
      ];

    case "pregunta_pago_plataforma":
      return [
        "Sobre cómo lo maneja la plataforma prefiero no inventarte nada. Lo que sí me importa es que por aquí la charla se sienta real. ¿Qué fue lo que te hizo preguntar eso?",
        "No quiero darte una respuesta dudosa sobre pagos o cuentas, así que prefiero ir a lo claro. Si quieres, seguimos por aquí y me dices qué te estaba generando esa duda.",
        "Con temas de plataforma prefiero no vender humo ni suponer cosas que no sé. Mejor dime qué fue exactamente lo que te hizo dudar y te respondo desde algo más real."
      ];

    case "redes_externas":
      return [
        "Aunque hayas visto algo fuera, prefiero que lo llevemos por aquí y sin mezclar cosas. Ya que estás, dime qué fue lo que realmente te llamó la atención.",
        "Yo mantendría la charla por este chat para que sea más simple y natural. Cuéntame si lo que te dio curiosidad fue algo del perfil o la manera de hablar.",
        "Antes de cruzar nada con otras redes prefiero que aquí la conversación se sienta clara y real. ¿Qué parte de todo eso fue la que te hizo volver?"
      ];

    case "abandono_ritmo_contacto":
      return [
        "Tranqui, no hace falta llevar esto con prisa ni estar pendiente todo el tiempo. Podemos hablar con calma por aquí y ver si la charla se da natural.",
        "Si el ritmo te pesa, mejor bajarlo y seguir sin presión. A veces funciona mucho más una conversación tranquila que estar encima.",
        "No necesito que respondas rápido ni que esto se vuelva una obligación. Me basta con que cuando entres aquí la charla se sienta cómoda y con ganas de seguir."
      ];

    case "desconfianza_realidad":
      return [
        "Te respondo simple y claro: prefiero que esto suene natural antes que perfecto. Si algo te genera duda, dímelo directo y lo hablamos aquí.",
        "No me interesa sonar armado ni vender una imagen rara. Prefiero una conversación clara y normal, de esas que se sostienen solas.",
        "Si te hace ruido algo, mejor decirlo de frente y seguir desde ahí. Yo valoro más una charla clara que una respuesta demasiado ensayada."
      ];

    default:
      return [];
  }
}

function fallbackReplySuggestions(caso = {}) {
  const cliente = normalizeText(caso.clientePlano || "");
  const detail = cleanHuman(caso.detallePerfil?.value || "");

  if (/\b(about yourself|sobre ti|cuentame de ti|cuéntame de ti|tell me about yourself)\b/.test(cliente)) {
    return [
      "Soy más de conversaciones que se sientan reales que de vender una imagen perfecta. Me interesa más conectar bien que sonar impresionante. ¿Tú en qué te fijas primero cuando alguien te escribe?",
      "Prefiero una charla que fluya de verdad antes que aparentar demasiado. Me gusta cuando del otro lado hay curiosidad real y no solo frases hechas.",
      "No soy muy de inflarme ni de posar. Me va más una conversación natural, con algo de criterio y con ganas de seguir, que ya dice bastante de alguien."
    ];
  }

  if (/\b(how are you|como estas|cómo estás|que tal|qué tal|how was your day|como va tu dia|cómo va tu día|how is your day)\b/.test(cliente)) {
    return [
      "Todo bien por aquí. Prefiero una charla que salga natural antes que llenar esto de frases vacías. ¿Tu día viene tranquilo o te agarré en medio de algo?",
      "Bien por aquí, con ganas de una conversación que se sienta real y no de compromiso. ¿Tu día vino más relajado o más movido?",
      "Bastante bien, gracias. Soy más de conversaciones con algo de dirección que de respuestas por salir del paso. ¿Tú vienes con día tranquilo o con la cabeza a mil?"
    ];
  }

  if (/\b(de donde eres|donde vives|where are you from|where do you live)\b/.test(cliente) && caso.perfil?.ubicacionClienta) {
    return [
      `Estoy por ${caso.perfil.ubicacionClienta}, aunque me importa más cómo fluye la charla que la ubicación exacta. ¿Tú eres más de conversaciones tranquilas o con más chispa?`,
      `Ando por ${caso.perfil.ubicacionClienta}. Igual, para mí pesa más la energía de la conversación que el punto exacto del mapa.`,
      `Por ${caso.perfil.ubicacionClienta}. Aun así, lo que más me engancha siempre es que la conversación tenga algo real y no se sienta automática.`
    ];
  }

  if ((caso.activeThemes || []).length) {
    return [
      "Lo que acabas de contar me dejó con curiosidad. Quiero responderte bien sin volver esto pesado. ¿Te salió por experiencia o por intuición?",
      "Ahí sí noté algo con más fondo. Me interesa entender si lo ves así desde hace tiempo o si hubo algo que te hizo pensarlo así.",
      "Eso que acabas de contar tiene más miga de la que parece. Me dan ganas de seguir por ahí porque ya suena a una conversación más real que la típica."
    ];
  }

  if (detail) {
    return [
      `Me gustó leerte. Antes que llevar esto a frases copiadas, prefiero ir con algo más real. Vi ${detail} y me dio curiosidad saber qué es lo que más va contigo de eso.`,
      `Lo que dijiste me dejó con ganas de seguir por una línea natural. Vi ${detail} y siento que ahí hay un punto mejor para hablar que con cualquier saludo vacío.`,
      `Prefiero una conversación que tenga dirección. Vi ${detail} y me pareció mejor entrar por algo concreto que por un mensaje del montón.`
    ];
  }

  return [
    "Me gustó leerte. Quiero que esto vaya por una línea natural, no por frases hechas. ¿Eso que dices te sale más por intuición o por experiencia?",
    "Suena a que ahí hay una idea real detrás. Me dio curiosidad saber si lo ves así desde hace tiempo o si te pasó algo que te hizo pensarlo así.",
    "Lo que dices tiene un punto interesante. Me gustaría saber si lo sientes así por carácter o porque ya te tocó vivir algo parecido."
  ];
}

function fallbackReengagementSuggestions(caso = {}) {
  const detail = cleanHuman(caso.detallePerfil?.value || "");

  if (detail) {
    return [
      `Hola. Paso por aquí con algo más claro: vi ${detail} y me pareció mejor empezar por algo real que dejar otro saludo vacío. ¿Qué parte de eso va más contigo?`,
      `Hola. En vez de repetir una entrada floja, prefiero preguntarte algo concreto: vi ${detail} y me dio curiosidad saber qué es lo que más te engancha de eso.`,
      `Hola. Reaparezco con una simple para no sonar copiado: vi ${detail} y me parece mejor tirar por ahí que seguir con un mensaje de trámite.`
    ];
  }

  return [
    "Hola. Paso por aquí con una pregunta simple y real: ¿qué suele hacer que una conversación te parezca interesante desde el principio?",
    "Hola. En vez de dejar un mensaje más del montón, prefiero preguntarte algo concreto: ¿qué te hace seguir una charla por aquí?",
    "Hola. Reaparezco con una fácil para no sonar copiado: ¿eres más de gente tranquila o de quien entra con un poco más de chispa?"
  ];
}

function fallbackOpeningSuggestions(caso = {}) {
  const detail = cleanHuman(caso.detallePerfil?.value || "");

  if (detail) {
    return [
      `Hola. Vi ${detail} y me pareció mejor entrar por algo concreto que por una frase vacía. ¿Qué es lo que más te engancha de eso?`,
      `Hola. De todo el perfil, ${detail} fue lo que más me dio curiosidad. Quise empezar por ahí porque se siente más real que un saludo copiado.`,
      `Hola. Prefiero abrir con algo que sí tenga dirección: vi ${detail} y me quedé con la duda de si eso va más contigo por gusto, por energía o por costumbre.`
    ];
  }

  return [
    "Hola. Prefiero empezar con algo simple y real: ¿qué tipo de conversación sí te dan ganas de seguir cuando alguien te escribe por aquí?",
    "Hola. No quise abrir con una frase vacía, así que voy con una sencilla: ¿qué suele llamar tu atención cuando alguien te empieza a hablar?",
    "Hola. Antes que sonar igual que todos, prefiero preguntarte algo directo: ¿eres más de charlas tranquilas o de gente que entra con más chispa?"
  ];
}

function fallbackSuggestions(caso = {}) {
  const risk = fallbackRiskSuggestions(caso);
  if (risk.length) return risk;

  if (caso.mode === "RESPUESTA_CHAT") return fallbackReplySuggestions(caso);
  if (caso.mode === "REAPERTURA_SUAVE") return fallbackReengagementSuggestions(caso);
  return fallbackOpeningSuggestions(caso);
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
    [textoPlano, clientePlano, contextoPlano].filter(Boolean).join("\n")
  );

  const operatorRecent = rawContextLines
    .filter((x) => x.role === "operador")
    .slice(-4)
    .map((x) => x.text);

  const clientRecent = rawContextLines
    .filter((x) => x.role === "clienta")
    .slice(-4)
    .map((x) => x.text);

  const operatorKeywords = extractKeywords(operatorRecent.join(" "));
  const clientKeywords = extractKeywords(clientePlano || clientRecent.join(" "));
  const draftKeywords = extractKeywords(textoPlano);
  const detailKeywords = detallePerfil?.value ? extractKeywords(detallePerfil.value) : [];
  const activeThemes = dedupeStrings([
    ...clientKeywords.slice(0, 4),
    ...operatorKeywords.slice(0, 4),
    ...draftKeywords.slice(0, 4)
  ]).slice(0, 8);

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
    activeThemes,
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
    normalizeText(input.perfil || "").slice(0, 220),
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
    // Si OpenAI falla, seguimos con fallback útil.
  }

  pool.push(...mapOptionsToCandidates(fallbackSuggestions(caso), "fallback", caso));

  let selected = selectFinalCandidates(pool);

  if (selected.length < 3) {
    const fallbackPool = mapOptionsToCandidates(
      fallbackSuggestions(caso),
      "fallback",
      caso
    );

    for (const item of fallbackPool) {
      if (selected.some((x) => looksTooSimilar(x.text, item.text))) continue;
      selected.push(item);
      if (selected.length >= 3) break;
    }
  }

  const final = selected.slice(0, 3).map((item) => item.text);
  writeRecentSuggestions(caso.memoryKey, final);

  return {
    sugerencias: final,
    usageData: combineUsageData(usages),
    secondPassUsed,
    usedFallbackOnly: selected.length ? selected.every((x) => x.source === "fallback") : true
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
        content: `
Traduce al ingles natural de chat como una persona real escribiria.

REGLAS
No usar comillas
No usar simbolos raros
No sonar perfecto
Debe sonar natural y humano
Devuelve solo una version final
`.trim()
      },
      { role: "user", content: String(text ?? "") }
    ],
    temperature: 0.25,
    maxTokens: 160,
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
  return { ...result, shared: sharedJob.shared };
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
 * CONSUMPTION / COSTS
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

/* =========================================================
 * ANALYTICS
 * ======================================================= */

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
 * ADMIN / OPERATORS
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
    service: "server pro unico",
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
      max_tokens: SUGGESTION_MAX_TOKENS
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

function sendAdminHtml(req, res) {
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
    <p>El backend ya expone <code>/admin-api/*</code>, pero no encontró el archivo <code>admin.html</code> en Railway.</p>
    <p>Sube de nuevo tus archivos <code>admin.html</code> y <code>admin.js</code> para recuperar el panel visual completo.</p>
  </div>
</body>
</html>
  `);
}

function sendAdminJs(req, res) {
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
        ? resultado.sugerencias
        : []
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

    return res.json({
      ok: false,
      sugerencias: [],
      error: err.message || "Error interno"
    });
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

    return res.json({ ok: true, traducido: result.traducido });
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

    return res.json({ ok: false, error: err.message || "Error interno" });
  }
});

/* =========================================================
 * FALLBACKS / ERRORS
 * ======================================================= */

app.use((err, _req, res, _next) => {
  console.error("Error no controlado:", err);
  if (res.headersSent) return;
  return res.status(500).json({ ok: false, error: "Error interno" });
});

app.listen(PORT, () => {
  console.log(`Server unico completo activo en puerto ${PORT}`);
  console.log(`Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`);
  console.log(`SUGGESTION_MAX_TOKENS => ${SUGGESTION_MAX_TOKENS}`);
});
