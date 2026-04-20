// services/translation.js
const {
  OPENAI_MODEL_TRANSLATE,
  OPENAI_TIMEOUT_TRANSLATE_MS,
  TRANSLATION_CACHE_TTL_MS,
  TRANSLATION_CACHE_LIMIT
} = require("../config");

const {
  translationCache
} = require("../state");

const {
  normalizarTexto,
  limpiarSalidaHumana
} = require("../lib/utils");

const {
  llamarOpenAI
} = require("./openai");

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

module.exports = {
  getTranslationCacheKey,
  leerTraduccionCache,
  guardarTraduccionCache,
  traducirTexto
};