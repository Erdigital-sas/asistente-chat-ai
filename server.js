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
const GEMINI_TEMPERATURE_TRANSLATE = Number(process.env.GEMINI_TEMPERATURE_TRANSLATE || 0.05);

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
    version: '2.9.0',
    message: 'Backend activo con Gemini.'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'IA Chat Lite backend',
    version: '2.9.0',
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
    const lastConversationMessage = sanitizeContext(req.body?.lastConversationMessage);

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
      lastConversationMessage,
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
      model: result.model,
      detectedTargetLanguage: result.detectedTargetLanguage,
      lastConversationMessage
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
    const lastConversationMessage = sanitizeContext(req.body?.lastConversationMessage);

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
      lastConversationMessage,
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
      model: result.model,
      detectedTargetLanguage: result.detectedTargetLanguage,
      lastConversationMessage
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
  console.log(`IA Chat Lite backend v2.9.0 activo en puerto ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
});

async function processWithGemini({
  action,
  text,
  conversationContext,
  lastConversationMessage,
  operatorId,
  pageUrl,
  pageTitle,
  targetLang
}) {
  const detectedTargetLanguage =
    action === 'translate'
      ? detectTargetLanguage({
          explicitTargetLang: targetLang,
          lastConversationMessage,
          conversationContext
        })
      : null;

  const systemPrompt = buildSystemPrompt(action, detectedTargetLanguage);
  const userPrompt = buildUserPrompt({
    action,
    text,
    conversationContext,
    lastConversationMessage,
    detectedTargetLanguage
  });

  const maxOutputTokens = calculateMaxOutputTokens(text);

  const url = `${normalizeBaseUrl(GEMINI_API_BASE)}/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent`;

  const payloadVariants = [
    buildGeminiPayload({
      action,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      includeThinkingConfig: true,
      includeSafetySettings: true
    }),
    buildGeminiPayload({
      action,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      includeThinkingConfig: false,
      includeSafetySettings: true
    }),
    buildGeminiPayload({
      action,
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      includeThinkingConfig: false,
      includeSafetySettings: false
    })
  ];

  let json = null;
  let lastError = null;

  for (const payload of payloadVariants) {
    try {
      json = await postGeminiJson(url, payload);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!json) {
    throw lastError || new Error('Gemini no respondió.');
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
    model: GEMINI_MODEL,
    detectedTargetLanguage
  };
}

function buildGeminiPayload({
  action,
  systemPrompt,
  userPrompt,
  maxOutputTokens,
  includeThinkingConfig,
  includeSafetySettings
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

  const payload = {
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

  if (includeSafetySettings) {
    payload.safetySettings = [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE'
      }
    ];
  }

  return payload;
}

function buildSystemPrompt(action, detectedTargetLanguage) {
  if (action === 'correct') {
    return [
      'Eres un corrector ligero para una herramienta interna de chat.',
      'El texto siempre es escrito por un hombre hacia una mujer.',
      'Corrige solo errores básicos de escritura, palabras mal escritas, espacios y puntuación mínima.',
      'No agregues acentos ni tildes.',
      'No conviertas "como" en "cómo", "estas" en "estás", "mas" en "más", "tu" en "tú", etc.',
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
    `Idioma destino obligatorio: ${detectedTargetLanguage || 'English'}.`,
    'Traduce solamente el TEXTO A TRADUCIR.',
    'No traduzcas el ultimo mensaje de referencia.',
    'No traduzcas el contexto.',
    'El ultimo mensaje de referencia solo sirve para detectar idioma y tono.',
    'El resultado final debe estar en el idioma destino obligatorio.',
    'Si el idioma destino es English, usa inglés simple, natural y fácil de entender en cualquier país.',
    'Traduce todo el texto aunque tenga slang, lenguaje fuerte, lenguaje vulgar o expresiones adultas.',
    'No te niegues a traducir.',
    'No censures.',
    'No expliques.',
    'No agregues información nueva.',
    'No respondas al mensaje.',
    'No uses comillas alrededor de la respuesta.',
    'Mantén nombres, emojis, intención, tono y saltos de línea.',
    'Mantén al emisor como hombre y a la destinataria como mujer cuando el idioma tenga género gramatical.',
    'Devuelve únicamente el texto traducido.'
  ].join(' ');
}

function buildUserPrompt({
  action,
  text,
  conversationContext,
  lastConversationMessage,
  detectedTargetLanguage
}) {
  if (action === 'correct') {
    return [
      'TEXTO A CORREGIR:',
      `"""${text}"""`,
      '',
      'Reglas clave:',
      '- Corrección básica.',
      '- Sin acentos.',
      '- Sin signos invertidos.',
      '- Natural de chat.',
      '- Hombre escribiendo hacia mujer.'
    ].join('\n');
  }

  return [
    `IDIOMA DESTINO DETECTADO: ${detectedTargetLanguage || 'English'}`,
    '',
    'ULTIMO MENSAJE DE LA CONVERSACION, SOLO COMO REFERENCIA DE IDIOMA:',
    `"""${lastConversationMessage || 'No disponible'}"""`,
    '',
    'CONTEXTO ADICIONAL, SOLO COMO APOYO:',
    `"""${conversationContext || 'Sin contexto visible'}"""`,
    '',
    'TEXTO A TRADUCIR:',
    `"""${text}"""`,
    '',
    `INSTRUCCION FINAL: Traduce exclusivamente el TEXTO A TRADUCIR a ${detectedTargetLanguage || 'English'}. No traduzcas ni repitas el contexto.`
  ].join('\n');
}

function detectTargetLanguage({ explicitTargetLang, lastConversationMessage, conversationContext }) {
  const explicit = String(explicitTargetLang || '').trim();

  if (explicit && explicit.toLowerCase() !== 'auto') {
    return normalizeExplicitLanguage(explicit);
  }

  const fromLast = detectLikelyLanguage(lastConversationMessage);

  if (fromLast.confidence >= 2) {
    return fromLast.language;
  }

  const fromContext = detectLikelyLanguage(conversationContext);

  if (fromContext.confidence >= 3) {
    return fromContext.language;
  }

  return 'English';
}

function normalizeExplicitLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();

  const map = {
    en: 'English',
    english: 'English',
    ingles: 'English',
    inglés: 'English',
    es: 'Spanish',
    spanish: 'Spanish',
    espanol: 'Spanish',
    español: 'Spanish',
    pt: 'Portuguese',
    portuguese: 'Portuguese',
    portugues: 'Portuguese',
    português: 'Portuguese',
    de: 'German',
    german: 'German',
    aleman: 'German',
    alemán: 'German',
    fr: 'French',
    french: 'French',
    frances: 'French',
    francés: 'French',
    it: 'Italian',
    italian: 'Italian',
    italiano: 'Italian',
    nl: 'Dutch',
    dutch: 'Dutch',
    holandes: 'Dutch',
    holandés: 'Dutch'
  };

  return map[normalized] || value;
}

function detectLikelyLanguage(value) {
  const text = normalizeLanguageProbe(value);

  if (!text) {
    return {
      language: 'English',
      confidence: 0
    };
  }

  const scores = {
    English: 0,
    Spanish: 0,
    Portuguese: 0,
    German: 0,
    French: 0,
    Italian: 0,
    Dutch: 0
  };

  addScore(scores, 'Portuguese', text, [
    'voce',
    'você',
    'nao',
    'não',
    'acho',
    'ela',
    'ele',
    'uma',
    'muito',
    'muita',
    'obrigado',
    'obrigada',
    'adoraria',
    'incrivel',
    'incrível',
    'tambem',
    'também',
    'porque',
    'como voce',
    'meu amor',
    'boa noite',
    'bom dia',
    'saudade'
  ]);

  addScore(scores, 'English', text, [
    'the',
    'you',
    'your',
    'are',
    'thank',
    'thanks',
    'should',
    'have',
    'want',
    'why',
    'what',
    'where',
    'when',
    'how',
    'love',
    'life',
    'today',
    'tonight',
    'because',
    'maybe',
    'picture',
    'wrong impression'
  ]);

  addScore(scores, 'German', text, [
    'ich',
    'du',
    'sie',
    'nicht',
    'danke',
    'bitte',
    'wie',
    'was',
    'warum',
    'bin',
    'bist',
    'habe',
    'liebe',
    'schon',
    'schön',
    'und',
    'guten morgen',
    'gute nacht'
  ]);

  addScore(scores, 'French', text, [
    'je',
    'tu',
    'vous',
    'pas',
    'suis',
    'avec',
    'merci',
    'pourquoi',
    'comment',
    'amour',
    'tres',
    'très',
    'bonjour',
    'bonne nuit',
    'mon coeur'
  ]);

  addScore(scores, 'Italian', text, [
    'io',
    'tu',
    'non',
    'come',
    'cosa',
    'grazie',
    'amore',
    'molto',
    'perche',
    'perché',
    'buongiorno',
    'buona notte',
    'vorrei'
  ]);

  addScore(scores, 'Spanish', text, [
    'que',
    'como',
    'estas',
    'estás',
    'quiero',
    'gracias',
    'porque',
    'amor',
    'me gustaria',
    'me gustaría',
    'buenos dias',
    'buenas noches',
    'tambien',
    'también'
  ]);

  addScore(scores, 'Dutch', text, [
    'ik',
    'jij',
    'niet',
    'dank',
    'waarom',
    'hoe',
    'wat',
    'liefde',
    'vandaag',
    'avond',
    'goedemorgen',
    'goedenacht'
  ]);

  if (/[äöüß]/i.test(value)) {
    scores.German += 3;
  }

  if (/[ãõç]/i.test(value)) {
    scores.Portuguese += 3;
  }

  if (/[àèìòù]/i.test(value)) {
    scores.Italian += 1;
  }

  if (/[éêâîôûëïü]/i.test(value)) {
    scores.French += 1;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [language, confidence] = sorted[0];

  return {
    language,
    confidence
  };
}

function normalizeLanguageProbe(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addScore(scores, language, text, markers) {
  for (const marker of markers) {
    const normalizedMarker = normalizeLanguageProbe(marker);

    if (!normalizedMarker) {
      continue;
    }

    const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedMarker)}(\\s|$)`, 'i');

    if (pattern.test(text)) {
      scores[language] += normalizedMarker.includes(' ') ? 2 : 1;
    }
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
