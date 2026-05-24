'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  process.env.GEMINI_TRANSLATE_MODEL ||
  'gemini-2.5-flash-lite';

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ||
  'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);
const GEMINI_TEMPERATURE_CORRECT = Number(process.env.GEMINI_TEMPERATURE_CORRECT || 0);
const GEMINI_TEMPERATURE_TRANSLATE = Number(process.env.GEMINI_TEMPERATURE_TRANSLATE || 0.1);

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2500);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 3500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 90);

const rateBuckets = new Map();

if (!GEMINI_API_KEY) {
  console.warn('WARNING: Falta GEMINI_API_KEY. /corregir y /traducir no funcionarán hasta configurarlo.');
}

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimitMiddleware);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'IA Chat Lite backend',
    version: '2.8.0',
    message: 'Backend activo con Gemini.'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'IA Chat Lite backend',
    version: '2.8.0',
    mode: 'lite',
    dictationProvider: 'browser-web-speech-api',
    correctionProvider: GEMINI_API_KEY ? 'gemini' : 'not_configured',
    correctionModel: GEMINI_MODEL,
    translationProvider: GEMINI_API_KEY ? 'gemini' : 'not_configured',
    translationModel: GEMINI_MODEL,
    warningsProvider: 'local-extension',
    suggestionsEnabled: false
  });
});

app.post('/corregir', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'GEMINI_API_KEY no está configurada. No se puede corregir.'
      });
    }

    const text = sanitizeText(req.body?.text);
    const conversationContext = sanitizeContext(req.body?.conversationContext);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Texto vacío.'
      });
    }

    const result = await processWithGemini({
      action: 'correct',
      text,
      conversationContext,
      operatorId: req.body?.operatorId,
      pageUrl: req.body?.pageUrl,
      pageTitle: req.body?.pageTitle
    });

    res.json({
      ok: true,
      provider: 'gemini',
      text: result.text,
      correctedText: result.text,
      usage: result.usage,
      model: result.model
    });
  } catch (error) {
    console.error('Error /corregir:', error);

    res.status(500).json({
      ok: false,
      error: 'No se pudo corregir el texto.'
    });
  }
});

app.post('/traducir', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'GEMINI_API_KEY no está configurada. No se puede traducir.'
      });
    }

    const text = sanitizeText(req.body?.text);
    const conversationContext = sanitizeContext(req.body?.conversationContext);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Texto vacío.'
      });
    }

    const result = await processWithGemini({
      action: 'translate',
      text,
      conversationContext,
      operatorId: req.body?.operatorId,
      pageUrl: req.body?.pageUrl,
      pageTitle: req.body?.pageTitle,
      targetLang: req.body?.targetLang || 'auto'
    });

    res.json({
      ok: true,
      provider: 'gemini',
      text: result.text,
      translation: result.text,
      translatedText: result.text,
      usage: result.usage,
      model: result.model
    });
  } catch (error) {
    console.error('Error /traducir:', error);

    res.status(500).json({
      ok: false,
      error: 'No se pudo traducir el texto.'
    });
  }
});

app.post('/sugerencias', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'El endpoint /sugerencias está desactivado en IA Chat Lite.'
  });
});

app.post('/suggestions', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'El endpoint /suggestions está desactivado en IA Chat Lite.'
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint no encontrado.'
  });
});

app.listen(PORT, () => {
  console.log(`IA Chat Lite backend v2.8.0 activo en puerto ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
});

async function processWithGemini({
  action,
  text,
  conversationContext,
  operatorId,
  pageUrl,
  pageTitle,
  targetLang
}) {
  const systemPrompt = buildSystemPrompt(action, targetLang);
  const userPrompt = buildUserPrompt(action, text, conversationContext);
  const maxOutputTokens = calculateMaxOutputTokens(text);

  const url = `${normalizeBaseUrl(GEMINI_API_BASE)}/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const payloadWithThinking = buildGeminiPayload({
    action,
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    includeThinkingConfig: true
  });

  let json;

  try {
    json = await postGeminiJson(url, payloadWithThinking);
  } catch (error) {
    if (!shouldRetryWithoutThinkingConfig(error)) {
      throw error;
    }

    const fallbackPayload = buildGeminiPayload({
      action,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      includeThinkingConfig: false
    });

    json = await postGeminiJson(url, fallbackPayload);
  }

  let output = cleanModelOutput(extractGeminiText(json));

  if (action === 'correct') {
    output = normalizeCorrectionOutput(output);
  }

  if (!output) {
    const blockReason = json?.promptFeedback?.blockReason;
    const finishReason = json?.candidates?.[0]?.finishReason;

    throw new Error(
      `Gemini no devolvió texto válido.${blockReason ? ` BlockReason: ${blockReason}.` : ''}${
        finishReason ? ` FinishReason: ${finishReason}.` : ''
      }`
    );
  }

  const usage = normalizeGeminiUsage(json?.usageMetadata || null);

  await trackUsage({
    operatorId,
    action,
    model: `gemini/${GEMINI_MODEL}`,
    usage,
    pageUrl,
    pageTitle
  });

  return {
    text: output,
    usage,
    model: GEMINI_MODEL
  };
}

function buildGeminiPayload({
  action,
  systemPrompt,
  userPrompt,
  maxOutputTokens,
  includeThinkingConfig
}) {
  const generationConfig = {
    temperature: action === 'correct' ? GEMINI_TEMPERATURE_CORRECT : GEMINI_TEMPERATURE_TRANSLATE,
    topP: 0.9,
    maxOutputTokens,
    responseMimeType: 'text/plain'
  };

  if (includeThinkingConfig && Number.isFinite(GEMINI_THINKING_BUDGET)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: GEMINI_THINKING_BUDGET
    };
  }

  return {
    systemInstruction: {
      parts: [
        {
          text: systemPrompt
        }
      ]
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: userPrompt
          }
        ]
      }
    ],
    generationConfig
  };
}

function buildSystemPrompt(action, targetLang) {
  if (action === 'correct') {
    return [
      'Eres un corrector ligero para una herramienta interna de chat.',
      'El texto siempre es escrito por un hombre hacia una mujer.',
      'Corrige solo errores básicos de escritura, palabras mal escritas, espacios y puntuación mínima.',
      'No agregues acentos ni tildes. No conviertas "como" en "cómo", "estas" en "estás", "mas" en "más", etc.',
      'No uses signos invertidos de español como "¿" o "¡".',
      'Si el mensaje claramente es una pregunta, usa solo signo de pregunta al final.',
      'Si no es pregunta, no lo conviertas en pregunta.',
      'Mantén un estilo natural, humano, casual y de chat.',
      'No lo vuelvas formal, perfecto ni robotizado.',
      'No cambies la intención.',
      'No agregues contenido nuevo.',
      'No respondas al mensaje.',
      'No hagas sugerencias.',
      'Mantén al emisor como hombre y a la destinataria como mujer cuando haya género gramatical.',
      'Devuelve únicamente el texto corregido.'
    ].join(' ');
  }

  return [
    'Eres un traductor para una herramienta interna de chat.',
    'El texto normalmente lo escribe un hombre hacia una mujer.',
    'Tu objetivo es traducir el texto del operador al idioma que corresponde a la conversación.',
    'Usa el contexto de conversación solamente para detectar el idioma destino y el tono.',
    'No traduzcas el contexto; solo traduce el texto marcado como TEXTO A TRADUCIR.',
    'Si el contexto muestra que la conversación está en inglés, traduce a inglés simple, natural y fácil de entender en cualquier país.',
    'Si el contexto muestra que la conversación está en portugués, alemán, francés, italiano u otro idioma, traduce a ese idioma.',
    'Si el contexto no permite detectar idioma destino, traduce a inglés simple global.',
    `targetLang actual: ${targetLang || 'auto'}.`,
    'Conserva nombres, emojis, intención, tono y saltos de línea.',
    'Traduce lenguaje fuerte, vulgar, slang o adulto de forma natural y equivalente, sin censurar y sin negarte.',
    'No suavices demasiado el significado, pero tampoco agregues intensidad que no exista.',
    'Mantén al emisor como hombre y a la destinataria como mujer cuando el idioma tenga género gramatical.',
    'No agregues información nueva.',
    'No respondas al mensaje.',
    'No expliques nada.',
    'No uses comillas alrededor de la respuesta.',
    'Devuelve únicamente el texto traducido.'
  ].join(' ');
}

function buildUserPrompt(action, text, conversationContext) {
  if (action === 'correct') {
    return [
      'TEXTO A CORREGIR:',
      `"""${text}"""`,
      '',
      'Recuerda: corrección básica, sin acentos, sin signos invertidos, estilo natural de chat.'
    ].join('\n');
  }

  return [
    'CONTEXTO VISIBLE DE LA CONVERSACIÓN:',
    `"""${conversationContext || 'Sin contexto visible.'}"""`,
    '',
    'TEXTO A TRADUCIR:',
    `"""${text}"""`,
    '',
    'Instrucción final: traduce solo el TEXTO A TRADUCIR al idioma real de la conversación. Si no está claro, usa inglés simple global.'
  ].join('\n');
}

async function postGeminiJson(url, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const rawText = await response.text();

    let json = {};

    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error('Gemini respondió con JSON inválido.');
    }

    if (!response.ok) {
      const message =
        json?.error?.message ||
        json?.error?.status ||
        `Error de Gemini: HTTP ${response.status}`;

      throw new Error(message);
    }

    return json;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Gemini tardó demasiado en responder.');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function shouldRetryWithoutThinkingConfig(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    message.includes('thinkingconfig') ||
    message.includes('thinking_config') ||
    message.includes('thinkingbudget') ||
    message.includes('thinking_budget') ||
    message.includes('unknown name') ||
    message.includes('unknown field') ||
    message.includes('invalid json payload')
  );
}

function extractGeminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => part?.text || '')
    .join('')
    .trim();
}

function normalizeGeminiUsage(usageMetadata) {
  if (!usageMetadata) {
    return null;
  }

  const promptTokens = usageMetadata.promptTokenCount || 0;
  const completionTokens = usageMetadata.candidatesTokenCount || 0;
  const thoughtsTokens = usageMetadata.thoughtsTokenCount || 0;
  const totalTokens =
    usageMetadata.totalTokenCount || promptTokens + completionTokens + thoughtsTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    thoughts_tokens: thoughtsTokens
  };
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .slice(0, MAX_TEXT_CHARS)
    .trim();
}

function sanitizeContext(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+\n/g, '\n')
    .slice(0, MAX_CONTEXT_CHARS)
    .trim();
}

function cleanModelOutput(value) {
  return String(value || '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["“]|["”]$/g, '')
    .trim();
}

function normalizeCorrectionOutput(value) {
  return String(value || '')
    .replace(/[¿¡]/g, '')
    .replace(/[áàäâã]/g, 'a')
    .replace(/[ÁÀÄÂÃ]/g, 'A')
    .replace(/[éèëê]/g, 'e')
    .replace(/[ÉÈËÊ]/g, 'E')
    .replace(/[íìïî]/g, 'i')
    .replace(/[ÍÌÏÎ]/g, 'I')
    .replace(/[óòöôõ]/g, 'o')
    .replace(/[ÓÒÖÔÕ]/g, 'O')
    .replace(/[úùüû]/g, 'u')
    .replace(/[ÚÙÜÛ]/g, 'U')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculateMaxOutputTokens(text) {
  const estimatedTokens = Math.ceil(String(text || '').length / 3.5);
  return Math.min(900, Math.max(80, estimatedTokens + 120));
}

async function trackUsage({ operatorId, action, model, usage, pageUrl, pageTitle }) {
  if (!supabase || !usage) {
    return;
  }

  try {
    const tableName = process.env.SUPABASE_TOKEN_TABLE || 'token_usage';

    const row = {
      operator_id: operatorId || 'unknown',
      action,
      model,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      page_url: pageUrl || null,
      page_title: pageTitle || null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from(tableName).insert(row);

    if (error) {
      console.warn('No se pudo guardar tracking en Supabase:', error.message);
    }
  } catch (error) {
    console.warn('Error no crítico guardando tracking:', error?.message || error);
  }
}

function rateLimitMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/') {
    return next();
  }

  const key = getRateLimitKey(req);
  const now = Date.now();

  const bucket = rateBuckets.get(key) || {
    count: 0,
    resetAt: now + RATE_LIMIT_WINDOW_MS
  };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas solicitudes. Intenta de nuevo en unos segundos.'
    });
  }

  cleanOldRateBuckets(now);
  next();
}

function getRateLimitKey(req) {
  return req.body?.operatorId || req.ip || 'unknown';
}

function cleanOldRateBuckets(now) {
  if (rateBuckets.size < 5000) {
    return;
  }

  for (const [key, bucket] of rateBuckets.entries()) {
    if (now > bucket.resetAt) {
      rateBuckets.delete(key);
    }
  }
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}
