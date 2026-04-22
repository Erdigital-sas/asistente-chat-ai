// server.js - SERVER UNICO REAL
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID, timingSafeEqual } = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL_SUGGESTIONS = process.env.OPENAI_MODEL_SUGGESTIONS || process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MODEL_TRANSLATE = process.env.OPENAI_MODEL_TRANSLATE || process.env.OPENAI_MODEL_FAST || "gpt-4o-mini";
const OPENAI_TIMEOUT_SUGGESTIONS_MS = Math.max(8000, Math.min(45000, Number(process.env.OPENAI_TIMEOUT_SUGGESTIONS_MS || 17000)));
const OPENAI_TIMEOUT_TRANSLATE_MS = Math.max(4000, Math.min(25000, Number(process.env.OPENAI_TIMEOUT_TRANSLATE_MS || 10000)));
const OPERATOR_SHARED_KEY = String(process.env.OPERATOR_SHARED_KEY || "2026");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const OPERATOR_CACHE_TTL_MS = Math.max(30000, Math.min(60 * 60 * 1000, Number(process.env.OPERATOR_CACHE_TTL_MS || 5 * 60 * 1000)));
const TRANSLATION_CACHE_TTL_MS = Math.max(60000, Math.min(2 * 60 * 60 * 1000, Number(process.env.TRANSLATION_CACHE_TTL_MS || 15 * 60 * 1000)));
const TRANSLATION_CACHE_LIMIT = Math.max(50, Math.min(5000, Number(process.env.TRANSLATION_CACHE_LIMIT || 500)));
const SUGGESTION_MEMORY_TTL_MS = 20 * 60 * 1000;
const SUGGESTION_MEMORY_LIMIT = 500;

if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Falta SUPABASE_URL o SUPABASE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const operatorAuthCache = new Map();
const translationCache = new Map();
const recentSuggestionMemory = new Map();

const runtimeStats = {
  startedAt: Date.now(),
  http: { total: 0, ok: 0, error: 0, lastMs: 0 },
  suggestions: { total: 0, ok: 0, error: 0, lastMs: 0 },
  translations: { total: 0, ok: 0, error: 0, cacheHits: 0, lastMs: 0 },
  warnings: { total: 0, ok: 0, error: 0, rowsUpserted: 0, lastMs: 0 },
  openai: { total: 0, ok: 0, error: 0, lastMs: 0 }
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

function removeAccents(text = "") {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(text = "") {
  return removeAccents(String(text ?? "")).toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanHuman(text = "") {
  return normalizeSpaces(String(text ?? "").replace(/[“”"]/g, "")).trim();
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

function formatOperatorName(name = "") {
  return normalizeSpaces(name)
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function getOperatorCacheKey(name = "") {
  return normalizeText(formatOperatorName(name));
}

function readOperatorCache(name = "") {
  const key = getOperatorCacheKey(name);
  const entry = operatorAuthCache.get(key);
  if (!entry) return "";
  if (entry.expiresAt <= Date.now()) {
    operatorAuthCache.delete(key);
    return "";
  }
  return entry.value || "";
}

function writeOperatorCache(name = "", value = "") {
  const key = getOperatorCacheKey(name);
  if (!key || !value) return;
  operatorAuthCache.set(key, {
    value,
    expiresAt: Date.now() + OPERATOR_CACHE_TTL_MS
  });
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
    return res.json({ ok: false, error: err.message || "No autorizado" });
  }
}

function normalizeChatSignals(raw = {}) {
  return {
    ultimo_role_visible: String(raw?.ultimo_role_visible || "").trim(),
    hay_clienta_visible: Boolean(raw?.hay_clienta_visible),
    hay_operador_visible: Boolean(raw?.hay_operador_visible),
    solo_operador_visible: Boolean(raw?.solo_operador_visible),
    total_clienta_visible: Number(raw?.total_clienta_visible || 0),
    total_operador_visible: Number(raw?.total_operador_visible || 0)
  };
}

function parseContextLines(context = "") {
  return String(context ?? "")
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter(Boolean)
    .map((line) => {
      if (/^CLIENTA:/i.test(line)) {
        return { role: "clienta", text: normalizeSpaces(line.replace(/^CLIENTA:\s*/i, "")) };
      }
      if (/^OPERADOR:/i.test(line)) {
        return { role: "operador", text: normalizeSpaces(line.replace(/^OPERADOR:\s*/i, "")) };
      }
      return { role: "", text: line };
    })
    .filter((x) => x.role && x.text);
}

function sanitizeLocation(raw = "") {
  const text = cleanHuman(raw);
  if (!text) return "";
  if (text.length < 3 || text.length > 32) return "";
  if (/\d/.test(text)) return "";
  if (/^(about|bio|interested in|looking for|my content|present requests)$/i.test(text)) return "";
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

function pickProfileDetail(perfil = {}, texto = "") {
  const lower = normalizeText(texto);
  const asksLocation = /\b(de donde eres|donde eres|where are you from|de donde vienes|donde vives|where do you live)\b/i.test(lower);

  if (perfil.interesesEnComun?.length) {
    return { type: "interes_comun", value: perfil.interesesEnComun[0] };
  }

  if (perfil.interesesClienta?.length) {
    return { type: "interes_clienta", value: perfil.interesesClienta[0] };
  }

  // Para evitar volver a caer en nombre = ciudad, la ubicacion solo se usa si la pregunta va claramente por ahi.
  if (asksLocation && perfil.ubicacionClienta) {
    return { type: "ubicacion", value: perfil.ubicacionClienta };
  }

  return { type: "none", value: "" };
}

function inferContactType({ chatSignals, contextoPlano = "" }) {
  const contextLines = parseContextLines(contextoPlano);
  const hasOperatorContext = contextLines.some((x) => x.role === "operador");

  if (chatSignals.ultimo_role_visible === "clienta" && chatSignals.hay_clienta_visible) {
    return "viejo_con_respuesta";
  }

  if (chatSignals.solo_operador_visible || chatSignals.ultimo_role_visible === "operador") {
    return hasOperatorContext || chatSignals.total_operador_visible > 0
      ? "viejo_sin_respuesta"
      : "nuevo_total";
  }

  return hasOperatorContext ? "viejo_sin_respuesta" : "nuevo_total";
}

function detectMode({ texto = "", cliente = "", contexto = "", chatSignals = {} }) {
  const signals = normalizeChatSignals(chatSignals);
  const clientText = normalizeSpaces(cliente);
  const contextLines = parseContextLines(contexto);
  const lastContextRole = contextLines.length ? contextLines[contextLines.length - 1].role : "";

  // Regla dura: solo se responde como chat vivo si lo ultimo visible es de la clienta.
  if (signals.ultimo_role_visible === "clienta" && signals.hay_clienta_visible) {
    return "RESPUESTA_CHAT";
  }

  // Si solo se ve operador, nunca respondemos como si ella hubiera hablado.
  if (signals.solo_operador_visible || signals.ultimo_role_visible === "operador") {
    return (signals.total_operador_visible > 0 || contextLines.some((x) => x.role === "operador"))
      ? "REAPERTURA_SUAVE"
      : "APERTURA_FRIA";
  }

  // Si no mandaron señales, solo entramos a RESPUESTA_CHAT si el contexto lo sostiene de forma clara.
  if (lastContextRole === "clienta" && clientText && clientText.length >= 6) {
    return "RESPUESTA_CHAT";
  }

  if (/\b(no respondes|me dejaste en visto|sigues ahi|desapareciste|no me contestas)\b/i.test(texto)) {
    return "REAPERTURA_SUAVE";
  }

  return contextLines.some((x) => x.role === "operador")
    ? "REAPERTURA_SUAVE"
    : "APERTURA_FRIA";
}

const META_REGEX = /\b(responderte mejor|escribirte mejor|con mas intencion|con mas calma|me dejo curiosidad real|por como lo dijiste|siempre hablas asi|pilot[oó] automatico|tu mejor vibra|tu mejor energia)\b/i;
const CONTACT_REGEX = /\b(whatsapp|telegram|instagram|snapchat|discord|numero|telefono|phone|mail|email|correo|fuera de la app|outside the app)\b/i;
const MEET_REGEX = /\b(vernos|en persona|cafe juntos|salir contigo|my place|your place|dinner|drink together|come over|cena|tragos|direccion|ubicacion)\b/i;
const BAD_OPENING_REPLY_REGEX = /^(entiendo|tiene sentido|lo que dices|por donde vas|gracias por decirme|me interesa lo que dices)/i;
const BAD_CONTINUITY_REGEX = /\b(retomar|seguir conversando|continuar la charla|de nuevo|otra vez|como te decia)\b/i;

function buildSystemPrompt(caso = {}) {
  return `
Eres un editor conversacional premium para una app de citas.

Debes devolver exactamente 3 opciones finales listas para enviar.
Deben sonar humanas, naturales, claras y faciles de responder.

Reglas:
- no inventes nombres
- no inventes ciudades ni recuerdos
- no uses mas de una pregunta por opcion
- no metas frases meta sobre escribir mejor o responder mejor
- no propongas salir de la app ni contacto externo
- no uses tono de coach ni poeta
- usa el perfil solo como apoyo y como maximo un detalle
- si no hay respuesta real de la clienta, no escribas como si ya vinieran conversando

Modo actual: ${caso.mode}

Si es APERTURA_FRIA:
abre natural, con curiosidad concreta y facil de responder.

Si es REAPERTURA_SUAVE:
reabre sin reclamo y sin fingir continuidad.

Si es RESPUESTA_CHAT:
responde primero a lo ultimo de ella.

Devuelve:
1. ...
2. ...
3. ...
`.trim();
}

function buildUserPrompt(caso = {}) {
  return `
BORRADOR DEL OPERADOR
"""
${caso.textoPlano}
"""

ULTIMO MENSAJE DE LA CLIENTA
"""
${caso.clientePlano || "Sin mensaje claro"}
"""

CONTEXTO RELEVANTE
"""
${caso.contextoPlano || "Sin contexto claro"}
"""

PERFIL
- intereses en comun: ${(caso.perfil.interesesEnComun || []).join(" | ") || "ninguno"}
- intereses clienta: ${(caso.perfil.interesesClienta || []).join(" | ") || "ninguno"}
- ubicacion: ${caso.perfil.ubicacionClienta || "ninguna"}

DETALLE PRIORITARIO
${caso.detallePerfil?.value || "ninguno"}

IMPORTANTE
- si no hay respuesta real de la clienta, no escribas como si ya vinieran conversando
- si hay respuesta real, respondela primero
- usa perfil solo como apoyo y como maximo un detalle
- no metas frases reflexivas vacias

Devuelve solo 3 opciones numeradas.
`.trim();
}

function extractOptions(raw = "") {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];

  const options = [];
  const regex = /(?:^|\n)\s*\d+\s*[\.\)\-:]\s*([\s\S]*?)(?=(?:\n\s*\d+\s*[\.\)\-:])|$)/g;
  let match;

  while ((match = regex.exec(text))) {
    const item = normalizeSpaces(match[1]);
    if (item) options.push(item);
  }

  if (options.length) return options;

  return text
    .split("\n")
    .map((x) => normalizeSpaces(x))
    .filter(Boolean);
}

function countQuestions(text = "") {
  return (String(text).match(/\?/g) || []).length + (String(text).match(/¿/g) || []).length;
}

function isBadSuggestion(suggestion = "", caso = {}) {
  const s = cleanHuman(suggestion);
  const t = normalizeText(s);
  if (!s) return true;
  if (s.length < 18) return true;
  if (countQuestions(s) > 2) return true;
  if (META_REGEX.test(t)) return true;
  if (CONTACT_REGEX.test(t)) return true;
  if (MEET_REGEX.test(t)) return true;

  if (caso.mode !== "RESPUESTA_CHAT" && BAD_OPENING_REPLY_REGEX.test(s)) {
    return true;
  }

  if (caso.mode !== "RESPUESTA_CHAT" && BAD_CONTINUITY_REGEX.test(t)) {
    return true;
  }

  return false;
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

function getSuggestionMemoryKey(caso = {}) {
  return [
    normalizeText(caso.operador || "anon").slice(0, 80),
    normalizeText(caso.mode || "x"),
    normalizeText(caso.textoPlano || "").slice(0, 220),
    normalizeText(caso.clientePlano || "").slice(0, 180),
    normalizeText(caso.contextoPlano || "").slice(-260)
  ].join("||");
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
    values: values.slice(0, 6),
    expiresAt: Date.now() + SUGGESTION_MEMORY_TTL_MS
  });
}

function looksTooSimilar(a = "", b = "") {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const setA = new Set(na.split(/\s+/).filter(Boolean));
  const wordsB = nb.split(/\s+/).filter(Boolean);
  if (!wordsB.length) return false;
  const overlap = wordsB.filter((w) => setA.has(w)).length;
  return overlap / wordsB.length >= 0.8;
}

function parseReplyFallbackFromClient(cliente = "") {
  const lower = normalizeText(cliente);

  if (/\b(tell me (a little )?about yourself|about yourself)\b/.test(lower)) {
    return [
      "Me gusta ir con calma y que la charla se sienta natural, no forzada. Suelo conectar mejor cuando hay curiosidad real de los dos. ¿Y tú qué valoras más cuando empiezas a hablar con alguien?",
      "Soy más de conversaciones reales que de aparentar demasiado. Me gusta cuando hay buena energía y se puede hablar sin máscara. ¿Tú en qué te fijas primero cuando alguien te escribe?",
      "Prefiero una charla que fluya de verdad antes que vender una imagen perfecta. Me interesa más conectar bien que sonar impresionante. ¿Y tú qué sueles notar primero en alguien?"
    ];
  }

  if (/\b(how are you|como estas|que tal|how was your day|como va tu dia|how is your day)\b/.test(lower)) {
    return [
      "Estoy bien, gracias. Prefiero una charla natural antes que ir con frases vacías. ¿Tu día viene tranquilo o te agarré justo en medio de algo?",
      "Bien por aquí, con ganas de una conversación que se sienta real. ¿Tu día viene más relajado o te ha tocado moverte bastante?",
      "Todo bien por aquí. Me gusta más cuando la charla sale natural y no parece copiada. ¿Tu día ha ido más tranquilo o más movido?"
    ];
  }

  return [
    "Me gustó leerte. Quiero que esto vaya por una línea natural, no por frases hechas. ¿Eso que dices te sale más por intuición o por experiencia?",
    "Suena a que ahí hay una idea real detrás. Me dio curiosidad saber si lo ves así desde hace tiempo o si te pasó algo que te hizo pensarlo así.",
    "Lo que dices tiene un punto interesante. Me gustaría saber si lo sientes así por carácter o porque ya te tocó vivir algo parecido."
  ];
}

function fallbackSuggestions(caso = {}) {
  const detail = caso.detallePerfil || { type: "none", value: "" };
  const detailValue = cleanHuman(detail.value);

  if (caso.mode === "RESPUESTA_CHAT") {
    return parseReplyFallbackFromClient(caso.clientePlano || "");
  }

  if (caso.mode === "REAPERTURA_SUAVE") {
    if (detail.type === "interes_comun" || detail.type === "interes_clienta") {
      const v = detailValue.toLowerCase();
      return [
        `Hola. Paso por aqui con algo mas claro: vi ${v} en tu perfil y me parecio mejor empezar por algo real. ¿Que es lo que mas te engancha de eso?`,
        `Hola. En vez de repetir un saludo vacio, prefiero preguntarte algo concreto: vi ${v} en tu perfil. ¿Te tira mas por gusto, por energia o por costumbre?`,
        `Hola. Reaparezco con una simple para no sonar copiado: vi ${v} en tu perfil. ¿Que parte de eso va mas contigo?`
      ];
    }

    return [
      "Hola. Paso por aquí con una pregunta simple y real: ¿qué suele hacer que una conversación te parezca interesante desde el principio?",
      "Hola. En vez de dejar un mensaje más del montón, prefiero preguntarte algo concreto: ¿qué te hace seguir una charla por aquí?",
      "Hola. Reaparezco con una fácil para no sonar copiado: ¿eres más de gente tranquila o de quien entra con un poco más de chispa?"
    ];
  }

  if (detail.type === "interes_comun" || detail.type === "interes_clienta") {
    const v = detailValue.toLowerCase();
    return [
      `Hola. Vi ${v} en tu perfil y me parecio mejor empezar por algo real que por una frase vacia. ¿Que es lo que mas te gusta de eso?`,
      `Hola. Entre todo lo que podia decirte, ${v} fue lo que mas me dio curiosidad. ¿Que te engancha mas de eso?`,
      `Hola. Prefiero abrir con algo concreto: vi ${v} en tu perfil. ¿Eso va mas contigo por gusto o por lo que te hace sentir?`
    ];
  }

  return [
    "Hola. Prefiero empezar con algo simple y real: ¿qué tipo de conversación sí te dan ganas de seguir cuando alguien te escribe por aquí?",
    "Hola. No quise abrir con una frase vacía, así que voy con una sencilla: ¿qué suele llamar tu atención cuando alguien te empieza a hablar?",
    "Hola. Antes que sonar igual que todos, prefiero preguntarte algo directo: ¿eres más de charlas tranquilas o de gente que entra con más chispa?"
  ];
}

async function callOpenAI({ model, messages, temperature = 0.7, maxTokens = 260, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  runtimeStats.openai.total += 1;

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
      throw new Error("OpenAI tardo demasiado en responder");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateSuggestions({ operador = "", texto = "", cliente = "", contexto = "", perfil = "", chat_signals = {}, page_type = "" }) {
  const pageType = String(page_type || "").trim().toLowerCase();
  const caso = {
    operador,
    textoPlano: compact(texto, 700),
    clientePlano: compact(cliente, 450),
    contextoPlano: compact(contexto, 900),
    perfil: parseProfile(perfil),
    chatSignals: normalizeChatSignals(chat_signals)
  };

  if (pageType && pageType !== "chat") {
    throw new Error("La IA solo funciona en una vista real de chat");
  }

  caso.mode = detectMode({
    texto: caso.textoPlano,
    cliente: caso.clientePlano,
    contexto: caso.contextoPlano,
    chatSignals: caso.chatSignals
  });

  caso.tipoContacto = inferContactType({
    chatSignals: caso.chatSignals,
    contextoPlano: caso.contextoPlano
  });
  caso.detallePerfil = pickProfileDetail(caso.perfil, caso.textoPlano);
  caso.memoryKey = getSuggestionMemoryKey(caso);
  const recent = readRecentSuggestions(caso.memoryKey);

  let options = [];
  let usageData = null;

  try {
    const data = await callOpenAI({
      model: OPENAI_MODEL_SUGGESTIONS,
      messages: [
        { role: "system", content: buildSystemPrompt(caso) },
        { role: "user", content: buildUserPrompt(caso) }
      ],
      temperature: caso.mode === "RESPUESTA_CHAT" ? 0.68 : 0.84,
      maxTokens: 280,
      timeoutMs: OPENAI_TIMEOUT_SUGGESTIONS_MS
    });

    usageData = data;
    options = extractOptions(data?.choices?.[0]?.message?.content || "")
      .map((x) => cleanHuman(x))
      .filter(Boolean)
      .filter((x) => !isBadSuggestion(x, caso))
      .filter((x) => !recent.some((r) => looksTooSimilar(r, x)));
  } catch (_err) {
    options = [];
    usageData = null;
  }

  const fallback = fallbackSuggestions(caso)
    .map((x) => cleanHuman(x))
    .filter(Boolean)
    .filter((x) => !isBadSuggestion(x, caso))
    .filter((x) => !recent.some((r) => looksTooSimilar(r, x)));

  const final = [];
  for (const item of [...options, ...fallback]) {
    if (!item) continue;
    if (final.some((x) => looksTooSimilar(x, item))) continue;
    final.push(item);
    if (final.length >= 3) break;
  }

  const result = final.length ? final : fallback.slice(0, 3);
  writeRecentSuggestions(caso.memoryKey, result);

  return {
    sugerencias: result,
    usageData
  };
}

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

async function translateText(text = "") {
  const data = await callOpenAI({
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
    temperature: 0.3,
    maxTokens: 140,
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

function isValidIsoDate(text = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text || ""));
}

function formatDateISO(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function saveWarningSummary({ operador = "", extension_id = "", fecha = "", counts = {} }) {
  const operadorFinal = formatOperatorName(operador || "");
  const fechaFinal = isValidIsoDate(fecha) ? fecha : formatDateISO(new Date());
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
    .upsert(payload, { onConflict: "operador,fecha,frase" });

  if (error) {
    throw new Error(error.message || "No se pudo guardar warning");
  }

  return { rowsUpserted: payload.length };
}

async function registerConsumption({ operador = "", extension_id = "", data = null, tipo = "", mensaje_operador = "", request_ok = true }) {
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
    await registerConsumption(payload);
  });
}

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "server unico real",
    uptime_seconds: Math.floor((Date.now() - runtimeStats.startedAt) / 1000),
    models: {
      sugerencias: OPENAI_MODEL_SUGGESTIONS,
      traduccion: OPENAI_MODEL_TRANSLATE
    },
    stats: runtimeStats
  });
});

app.post("/login", authorizeOperator, async (req, res) => {
  return res.json({ ok: true, operador: req.operadorAutorizado });
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

    return res.json({ ok: true, rows_upserted: result.rowsUpserted || 0 });
  } catch (err) {
    runtimeStats.warnings.error += 1;
    runtimeStats.warnings.lastMs = Date.now() - startedAt;
    return res.json({ ok: false, error: err.message || "No se pudo sincronizar warning" });
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
      return res.json({ ok: false, sugerencias: [], error: "Texto vacio" });
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

    registerConsumptionAsync({
      operador,
      extension_id,
      data: resultado?.usageData || null,
      tipo: "IA",
      mensaje_operador: texto,
      request_ok: true
    });

    runtimeStats.suggestions.ok += 1;
    runtimeStats.suggestions.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      sugerencias: Array.isArray(resultado?.sugerencias) ? resultado.sugerencias : []
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
    return res.json({ ok: false, sugerencias: [], error: err.message || "Error interno" });
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
      data: result.usageData || null,
      tipo: "TRAD",
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

app.use((err, _req, res, _next) => {
  console.error("Error no controlado:", err);
  if (res.headersSent) return;
  return res.status(500).json({ ok: false, error: "Error interno" });
});

app.listen(PORT, () => {
  console.log(`Server unico real activo en puerto ${PORT}`);
  console.log(`Modelos => sugerencias: ${OPENAI_MODEL_SUGGESTIONS} | traduccion: ${OPENAI_MODEL_TRANSLATE}`);
});
