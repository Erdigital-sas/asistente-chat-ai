const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function leerEnteroEnv(nombre, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[nombre];
  const n = Number.parseInt(raw, 10);

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
  openai: {
    total: 0,
    ok: 0,
    error: 0,
    suggestionCalls: 0,
    translationCalls: 0,
    lastMs: 0
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
const API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPERATOR_SHARED_KEY = process.env.OPERATOR_SHARED_KEY || "2026";
const PORT = process.env.PORT || 3000;

const OPENAI_URL =
  process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions";

const OPENAI_MODEL_SUGGESTIONS =
  process.env.OPENAI_MODEL_SUGGESTIONS ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";

const OPENAI_MODEL_TRANSLATE =
  process.env.OPENAI_MODEL_TRANSLATE ||
  process.env.OPENAI_MODEL_FAST ||
  "gpt-4o-mini";

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

const TARGET_SUGGESTION_SPECS = [
  { min: 200, max: 260, ideal: 230 },
  { min: 200, max: 260, ideal: 230 },
  { min: 320, max: 420, ideal: 370 }
];

// ==========================
// VALIDACION INICIAL
// ==========================
if (!API_KEY) {
  console.error("Falta OPENAI_API_KEY en Railway");
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

/*
IMPORTANTE
Esta cola por operador vive en memoria de esta replica.
Si luego activas 2 o mas replicas en Railway, la siguiente etapa correcta
es mover esta cola a Redis o a un store compartido.
*/
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
  return TARGET_SUGGESTION_SPECS[index] || TARGET_SUGGESTION_SPECS[0];
}

function cumpleLongitudObjetivo(texto = "", index = 0) {
  const spec = obtenerSpecSugerencia(index);
  const total = contarCaracteres(texto);
  return total >= spec.min && total <= spec.max;
}

function puntuarLongitud(texto = "", index = 0) {
  const spec = obtenerSpecSugerencia(index);
  const total = contarCaracteres(texto);

  if (!total) return -25;
  if (cumpleLongitudObjetivo(texto, index)) return 12;

  const distancia = Math.abs(total - spec.ideal);
  return Math.max(-12, 8 - Math.ceil(distancia / 20));
}

function setCumpleLongitudes(sugerencias = []) {
  return (
    sugerencias.length >= 3 &&
    sugerencias.slice(0, 3).every((s, idx) => cumpleLongitudObjetivo(s, idx))
  );
}

function construirReporteLongitudes(sugerencias = []) {
  return TARGET_SUGGESTION_SPECS.map((spec, idx) => {
    const actual = contarCaracteres(sugerencias[idx] || "");
    return `Opcion ${idx + 1}: ${actual} caracteres. Objetivo ${spec.min}-${spec.max}.`;
  }).join("\n");
}

function esRespuestaBasura(texto = "") {
  const t = normalizarTexto(texto);

  return (
    t.length < MIN_RESPONSE_LENGTH ||
    /^(ok|okay|yes|no|hola|hi|vale|bien|jaja|haha|hmm|mm|fine|nice|cool)[.!?]*$/.test(t)
  );
}

function sePareceDemasiado(a = "", b = "") {
  const ta = normalizarTexto(a);
  const tb = normalizarTexto(b);

  if (!ta || !tb) return false;
  if (ta === tb) return true;

  const wa = new Set(ta.split(" ").filter(Boolean));
  const wb = tb.split(" ").filter(Boolean);

  if (!wb.length) return false;

  const overlap = wb.filter((w) => wa.has(w)).length;
  return overlap / wb.length >= 0.85;
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

function detectarElementosClave(texto = "") {
  const palabras = normalizarTexto(texto).split(/\s+/).filter(Boolean);

  return {
    nombreApertura: extraerNombreEnApertura(texto),
    afectivos: extraerAfectivosPresentes(texto),
    mensajeCorto: palabras.length <= 9 || normalizarTexto(texto).length < 55
  };
}

function faltaElementosClave(
  sugerencia = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }
) {
  const sugNorm = normalizarTexto(sugerencia);
  const nombreSugerencia = extraerNombreEnApertura(sugerencia);

  if (elementos.nombreApertura) {
    if (!sugNorm.includes(elementos.nombreApertura)) return true;
    if (nombreSugerencia && nombreSugerencia !== elementos.nombreApertura) {
      return true;
    }
  } else if (nombreSugerencia) {
    return true;
  }

  if (elementos.afectivos.length) {
    const faltaAfectivo = elementos.afectivos.some((term) => !sugNorm.includes(term));
    if (faltaAfectivo) return true;
  }

  return false;
}

function pareceResponderComoSiLaClientaLeHubieraPreguntado(texto = "") {
  const t = normalizarTexto(texto);

  return (
    /^(hola[, ]*)?(gracias por preguntar|gracias,|estoy bien|todo bien por aqui|bien por aqui|espero que tu dia)/.test(t) ||
    /^(hola[, ]*)?agradezco que lo menciones/.test(t)
  );
}

function originalEsInicioOEnganche(original = "") {
  const o = normalizarTexto(original);

  return (
    /\b(como estas|que haces|que tal|como te va|por que no me respondes|estuve pensando en ti|vi que|me llamo la atencion|me gustaria saber|cual es tu libro favorito|conocer mas de ti)\b/.test(o)
  );
}

function esSugerenciaDebil(
  texto = "",
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }
) {
  const t = normalizarTexto(texto);

  if (!t || t.length < 18) return true;
  if (contarPreguntas(texto) > 2) return true;
  if (sePareceDemasiado(texto, original)) return true;
  if (faltaElementosClave(texto, elementos)) return true;

  if (originalEsInicioOEnganche(original) &&
      pareceResponderComoSiLaClientaLeHubieraPreguntado(texto)) {
    return true;
  }

  if (elementos.mensajeCorto && t.split(/\s+/).filter(Boolean).length < 11) {
    return true;
  }

  const patrones = [
    /^hola[, ]?(como estas|que tal|que haces|como va tu dia)/,
    /^me gustaria saber de ti/,
    /^espero tu respuesta/,
    /^hola[, ]?como va tu dia/,
    /^que andas haciendo ahora/,
    /^que estas haciendo en este momento/,
    /^hola[, ]?todo bien por aqui/,
    /^agradezco que lo menciones/,
    /^gracias, espero que tu dia vaya bien/
  ];

  return patrones.some((p) => p.test(t));
}

function necesitaSegundoIntento(
  sugerencias = [],
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }
) {
  if (sugerencias.length < 3) return true;
  if (!setCumpleLongitudes(sugerencias)) return true;

  const debiles = sugerencias.filter((s) => esSugerenciaDebil(s, original, elementos)).length;
  const distintas = new Set(sugerencias.map(normalizarTexto)).size;

  return debiles >= 1 || distintas < 3;
}

function sumarUsage(...datas) {
  const usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  datas.forEach((data) => {
    const u = data?.usage || {};
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.total_tokens += u.total_tokens || 0;
  });

  return { usage };
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

  const palabras = t.split(/\s+/).filter(Boolean);

  return {
    traePregunta,
    preguntaGenerica,
    fraseQuemada,
    muyPlano,
    reclamo,
    mezclaDeIdeas,
    primerContacto,
    mensajeCorto: palabras.length <= 9 || t.length < 55
  };
}

function construirLecturaOperador(analisis) {
  const reglas = [];

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
    reglas.push("Si es primer contacto, prioriza curiosidad natural.");
  }

  if (analisis.mensajeCorto) {
    reglas.push("Si el mensaje es corto, debes ampliarlo de forma util con una segunda idea natural.");
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
  const c = normalizarTexto(cliente);
  const ctx = normalizarTexto(contexto);

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
    /(vi que|tu perfil|me llamo la atencion|intereses en comun|conocer mas de ti)/.test(t) ||
    ((!c && !ctx) && /^(hola|hey|hi)\b/.test(t))
  ) {
    return "enganche";
  }

  return "conversacion";
}

function construirGuiaIntencion(intencion = "") {
  const mapa = {
    enganche: "Buscar una entrada atractiva, clara y facil de responder, con curiosidad natural.",
    coqueteo: "Mantener un tono cercano y atractivo sin sonar intenso, necesitado ni artificial.",
    conversacion: "Responder y mover la charla con fluidez, naturalidad y continuidad.",
    reenganche: "Recuperar la conversacion sin reclamo duro, con seguridad, calidez y mejor enganche.",
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

function construirSystemPrompt(
  elementosClave = { nombreApertura: "", afectivos: [], mensajeCorto: false },
  segundoIntento = false
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

CONSERVACION OBLIGATORIA
${construirBloqueConservacion(elementosClave)}

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
- esten listas para enviar
${segundoIntento ? "- corrijan por completo cualquier problema de longitud, genericidad o falta de foco del intento anterior" : ""}

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
  guiaIntencion
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
    .maybeSingle();

  if (error) {
    throw new Error("No se pudo validar el operador");
  }

  if (!data || !data.activo) {
    throw new Error("Operador no autorizado");
  }

  guardarOperadorCache(operadorFormateado, data.nombre);
  return data.nombre;
}

async function autorizarOperador(req, res, next) {
  try {
    const { operador = "", clave = "" } = req.body || {};
    const nombreValido = await validarOperadorAcceso(operador, clave);
    req.operadorAutorizado = nombreValido;
    next();
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
// OPENAI
// ==========================
function obtenerOpenAILimiter(lane = "sugerencias") {
  return lane === "traduccion"
    ? translationOpenAILimiter
    : suggestionsOpenAILimiter;
}

async function llamarOpenAI({
  lane = "sugerencias",
  model,
  messages,
  temperature = 0.58,
  maxTokens = 420,
  timeoutMs = 20000
}) {
  const limiter = obtenerOpenAILimiter(lane);

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
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
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

function elegirMejorSet(
  primary = [],
  secondary = [],
  original = "",
  elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }
) {
  const puntuar = (arr) => {
    if (!arr.length) return -999;

    let score = 0;
    score += arr.length * 10;
    score += new Set(arr.map(normalizarTexto)).size * 5;
    score += arr.reduce((acc, s, idx) => acc + puntuarLongitud(s, idx), 0);
    score += arr.filter((s) => !sePareceDemasiado(s, original)).length * 2;
    score -= arr.filter((s) => esSugerenciaDebil(s, original, elementos)).length * 8;
    score += setCumpleLongitudes(arr) ? 18 : -18;

    return score;
  };

  return puntuar(secondary) > puntuar(primary) ? secondary : primary;
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
  guiaIntencion
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
    guiaIntencion
  });

  const data1 = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      { role: "system", content: construirSystemPrompt(elementosClave, false) },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.56,
    maxTokens: 360,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const sugerencias1 = limpiarTextoIA(
    data1?.choices?.[0]?.message?.content || ""
  )
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  if (!necesitaSegundoIntento(sugerencias1, textoPlano, elementosClave)) {
    return {
      sugerencias: sugerencias1.slice(0, 3),
      usageData: data1
    };
  }

  runtimeStats.suggestions.secondPasses += 1;

  const reporteLongitudes1 = construirReporteLongitudes(sugerencias1);

  const userPrompt2 = `
${userPrompt}

CORRECCION OBLIGATORIA
El intento anterior no cumplio bien calidad o longitud.

Reporte del intento anterior:
${reporteLongitudes1}

Corrige esto ahora:
- opcion 1 entre 200 y 260 caracteres
- opcion 2 entre 200 y 260 caracteres
- opcion 3 entre 320 y 420 caracteres
- mas precision
- mas naturalidad
- mas utilidad real para el operador
- cero relleno
- respeta por completo nombres, afectivos e intencion
- no respondas como si la clienta hubiera dicho otra cosa
`.trim();

  const data2 = await llamarOpenAI({
    lane: "sugerencias",
    model: OPENAI_MODEL_SUGGESTIONS,
    messages: [
      { role: "system", content: construirSystemPrompt(elementosClave, true) },
      { role: "user", content: userPrompt2 }
    ],
    temperature: 0.62,
    maxTokens: 440,
    timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
  });

  const sugerencias2 = limpiarTextoIA(
    data2?.choices?.[0]?.message?.content || ""
  )
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  return {
    sugerencias: elegirMejorSet(
      sugerencias1,
      sugerencias2,
      textoPlano,
      elementosClave
    ).slice(0, 3),
    usageData: sumarUsage(data1, data2)
  };
}

async function traducirTexto(texto = "") {
  const data = await llamarOpenAI({
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
      {
        role: "user",
        content: String(texto ?? "")
      }
    ],
    temperature: 0.3,
    maxTokens: 140,
    timeoutMs: OPENAI_TIMEOUT_TRANSLATE_MS
  });

  const traducido = limpiarSalidaHumana(
    data?.choices?.[0]?.message?.content || ""
  );

  if (!traducido) {
    throw new Error("No se pudo traducir");
  }

  return {
    traducido,
    usageData: data
  };
}

// ==========================
// HEALTH
// ==========================
app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "server pro",
    uptime_seconds: Math.floor((Date.now() - runtimeStats.startedAt) / 1000),
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
// LOGIN
// ==========================
app.post("/login", autorizarOperador, async (req, res) => {
  return res.json({
    ok: true,
    operador: req.operadorAutorizado
  });
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
            guiaIntencion
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
    `Lanes OpenAI => sugerencias: ${SUGGESTION_OPENAI_CONCURRENCY} | traduccion: ${TRANSLATION_OPENAI_CONCURRENCY}`
  );
});
