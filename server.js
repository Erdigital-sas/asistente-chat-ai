"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = Number(process.env.PORT || 3000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);
const GEMINI_TEMPERATURE_CORRECT = Number(process.env.GEMINI_TEMPERATURE_CORRECT || 0);
const GEMINI_TEMPERATURE_TRANSLATE = Number(process.env.GEMINI_TEMPERATURE_TRANSLATE || 0.05);

const GEMINI_INPUT_COST_PER_1M = Number(process.env.GEMINI_INPUT_COST_PER_1M || 0.10);
const GEMINI_OUTPUT_COST_PER_1M = Number(process.env.GEMINI_OUTPUT_COST_PER_1M || 0.40);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  "";

const SUPABASE_TOKEN_TABLE = process.env.SUPABASE_TOKEN_TABLE || "token_usage";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || "change_admin_secret";
const ADMIN_TOKEN_TTL_HOURS = Number(process.env.ADMIN_TOKEN_TTL_HOURS || 12);

const OPERATOR_SESSION_SECRET =
  process.env.OPERATOR_SESSION_SECRET || "change_operator_secret";
const OPERATOR_SESSION_TTL_HOURS = Number(process.env.OPERATOR_SESSION_TTL_HOURS || 12);
const OPERATOR_SHARED_KEY = process.env.OPERATOR_SHARED_KEY || "";

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2500);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 3500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const rateBuckets = new Map();

if (!GEMINI_API_KEY) console.warn("WARNING: Falta GEMINI_API_KEY.");
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("WARNING: Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");
}
if (!ADMIN_PASSWORD) console.warn("WARNING: Falta ADMIN_PASSWORD.");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimitMiddleware);

/* =========================================================
 * HEALTH
 * ======================================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "IA Chat Lite backend",
    version: "3.2.0",
    admin: "/admin"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "IA Chat Lite backend",
    version: "3.2.0",
    mode: "lite",
    adminEnabled: true,
    operatorAuthEnabled: true,
    dictationProvider: "browser-web-speech-api",
    correctionProvider: GEMINI_API_KEY ? "gemini" : "not_configured",
    correctionModel: GEMINI_MODEL,
    translationProvider: GEMINI_API_KEY ? "gemini" : "not_configured",
    translationModel: GEMINI_MODEL,
    warningsProvider: "local-extension-and-supabase",
    suggestionsEnabled: false
  });
});

/* =========================================================
 * ADMIN STATIC
 * ======================================================= */

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin.js", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.js"));
});

/* =========================================================
 * ADMIN AUTH
 * ======================================================= */

app.post("/admin-api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Usuario y clave requeridos."
      });
    }

    if (username !== String(ADMIN_USER).toLowerCase() || password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: "Credenciales invalidas."
      });
    }

    const expiresAt = Date.now() + ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000;

    const token = signToken(
      {
        type: "admin",
        user: username,
        exp: expiresAt
      },
      ADMIN_TOKEN_SECRET
    );

    res.json({
      ok: true,
      token,
      user: username,
      expiresAt
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "No se pudo iniciar sesion admin."
    });
  }
});

app.get("/admin-api/session", requireAdmin, async (req, res) => {
  res.json({
    ok: true,
    user: req.admin.user
  });
});

/* =========================================================
 * ADMIN OPERATORS
 * ======================================================= */

app.get("/admin-api/operators", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const { data, error } = await supabase
      .from("operators")
      .select(
        "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
      )
      .order("created_at", { ascending: false });

    if (error) throw error;

    const operators = data || [];

    res.json({
      ok: true,
      operators,
      summary: {
        total: operators.length,
        activos: operators.filter((x) => x.status === "active").length,
        inactivos: operators.filter((x) => x.status !== "active").length
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudieron cargar operadores."
    });
  }
});

app.post("/admin-api/operators", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const username = normalizeUsername(req.body?.username);
    const displayName = String(
      req.body?.display_name ||
      req.body?.displayName ||
      username
    ).trim();

    const password = String(
      req.body?.password ||
      req.body?.clave ||
      OPERATOR_SHARED_KEY ||
      ""
    ).trim();

    const status = String(req.body?.status || "active").trim();
    const role = String(req.body?.role || "operator").trim();
    const notes = String(req.body?.notes || "").trim();

    if (!username) {
      return res.status(400).json({
        ok: false,
        error: "Usuario requerido."
      });
    }

    if (!displayName) {
      return res.status(400).json({
        ok: false,
        error: "Nombre requerido."
      });
    }

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: "Clave requerida."
      });
    }

    const { data, error } = await supabase
      .from("operators")
      .insert({
        username,
        display_name: displayName,
        password_hash: hashPassword(password),
        status,
        role,
        notes,
        updated_at: new Date().toISOString()
      })
      .select(
        "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
      )
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      operator: data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo crear operador."
    });
  }
});

app.post("/admin-api/operators/bulk", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const raw = String(req.body?.text || req.body?.operators || "").trim();
    const defaultPassword = String(
      req.body?.password ||
      req.body?.clave ||
      OPERATOR_SHARED_KEY ||
      ""
    ).trim();

    if (!raw) {
      return res.status(400).json({
        ok: false,
        error: "Lista vacia."
      });
    }

    if (!defaultPassword) {
      return res.status(400).json({
        ok: false,
        error: "Clave general requerida."
      });
    }

    const passwordHash = hashPassword(defaultPassword);

    const rows = raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line
          .split(/[,\t;]/)
          .map((x) => x.trim())
          .filter(Boolean);

        const username = normalizeUsername(parts[0] || "");
        const displayName = parts[1] || parts[0] || username;

        return {
          username,
          display_name: displayName,
          password_hash: passwordHash,
          status: "active",
          role: "operator",
          updated_at: new Date().toISOString()
        };
      })
      .filter((row) => row.username);

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        error: "No hay operadores validos."
      });
    }

    const { data, error } = await supabase
      .from("operators")
      .upsert(rows, { onConflict: "username" })
      .select(
        "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
      );

    if (error) throw error;

    res.json({
      ok: true,
      created: data?.length || 0,
      operators: data || []
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudieron crear operadores."
    });
  }
});

app.patch("/admin-api/operators/:id/status", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const id = req.params.id;
    const status = String(req.body?.status || "").trim();

    if (!["active", "inactive", "blocked"].includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Estado invalido."
      });
    }

    const { data, error } = await supabase
      .from("operators")
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select(
        "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
      )
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      operator: data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo actualizar operador."
    });
  }
});

app.patch("/admin-api/operators/:id/password", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const id = req.params.id;
    const password = String(req.body?.password || "").trim();

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: "Clave requerida."
      });
    }

    const { data, error } = await supabase
      .from("operators")
      .update({
        password_hash: hashPassword(password),
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select(
        "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
      )
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      operator: data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo cambiar clave."
    });
  }
});

app.delete("/admin-api/operators/:id", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const id = req.params.id;

    const { error } = await supabase
      .from("operators")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo eliminar operador."
    });
  }
});

/* =========================================================
 * ADMIN DASHBOARD V3.2
 * ======================================================= */

app.get("/admin-api/dashboard", requireAdmin, async (req, res) => {
  try {
    ensureSupabase();

    const range = buildDateRange(req.query.from, req.query.to);

    const [usageResult, operatorsResult, warningsResult] = await Promise.all([
      supabase
        .from(SUPABASE_TOKEN_TABLE)
        .select("*")
        .gte("created_at", range.startIso)
        .lt("created_at", range.endExclusiveIso)
        .order("created_at", { ascending: false })
        .limit(20000),

      supabase
        .from("operators")
        .select("id, username, display_name, status, role, last_login_at"),

      supabase
        .from("warning_events")
        .select("*")
        .gte("created_at", range.startIso)
        .lt("created_at", range.endExclusiveIso)
        .order("created_at", { ascending: false })
        .limit(20000)
    ]);

    if (usageResult.error) throw usageResult.error;
    if (operatorsResult.error) throw operatorsResult.error;

    let warningRows = [];

    if (!warningsResult.error) {
      warningRows = warningsResult.data || [];
    } else if (!String(warningsResult.error.message || "").includes("does not exist")) {
      throw warningsResult.error;
    }

    const usageRows = usageResult.data || [];
    const operators = operatorsResult.data || [];
    const operatorMap = buildOperatorMap(operators);

    const summary = buildUsageSummary(usageRows);
    summary.warnings_total = warningRows.length;

    const operatorStats = buildOperatorStats(usageRows, operatorMap);
    const warningTop = buildWarningTop(warningRows, operatorMap);
    const dailySeries = buildDailySeries(usageRows);
    const dailyOperatorSeries = buildDailyOperatorSeries(usageRows, operatorMap);
    const dailyWarningSeries = buildDailyWarningSeries(warningRows, operatorMap);

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      range: {
        from: range.from,
        to: range.to
      },
      summary,
      operators,
      operator_stats: operatorStats,
      warning_top: warningTop,
      daily_series: dailySeries,
      daily_operator_series: dailyOperatorSeries,
      daily_warning_series: dailyWarningSeries,
      pricing: {
        provider: "gemini",
        model: GEMINI_MODEL,
        input_per_1m: GEMINI_INPUT_COST_PER_1M,
        output_per_1m: GEMINI_OUTPUT_COST_PER_1M
      }
    });
  } catch (error) {
    console.error("Error /admin-api/dashboard:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo cargar dashboard."
    });
  }
});

/* =========================================================
 * OPERATOR AUTH
 * ======================================================= */

app.post("/auth/operator-login", async (req, res) => {
  try {
    ensureSupabase();

    const username = normalizeUsername(req.body?.username || req.body?.operador);
    const password = String(req.body?.password || req.body?.clave || "").trim();

    if (!username || !password) {
      return res.status(400).json({
        ok: false,
        error: "Usuario y clave requeridos."
      });
    }

    const { data: operator, error } = await supabase
      .from("operators")
      .select("*")
      .eq("username", username)
      .maybeSingle();

    if (error) throw error;

    if (!operator) {
      return res.status(401).json({
        ok: false,
        error: "Operador no existe."
      });
    }

    if (operator.status !== "active") {
      return res.status(403).json({
        ok: false,
        error: "Operador inactivo o bloqueado."
      });
    }

    const validPassword = operator.password_hash
      ? verifyPassword(password, operator.password_hash)
      : operator.shared_key
        ? safeCompare(password, operator.shared_key)
        : OPERATOR_SHARED_KEY
          ? safeCompare(password, OPERATOR_SHARED_KEY)
          : false;

    if (!validPassword) {
      return res.status(401).json({
        ok: false,
        error: "Clave invalida."
      });
    }

    const expiresAt = new Date(
      Date.now() + OPERATOR_SESSION_TTL_HOURS * 60 * 60 * 1000
    );
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);

    const { error: sessionError } = await supabase
      .from("operator_sessions")
      .insert({
        operator_id: operator.id,
        token_hash: tokenHash,
        user_agent: req.headers["user-agent"] || "",
        extension_id: String(req.body?.extensionId || ""),
        expires_at: expiresAt.toISOString()
      });

    if (sessionError) throw sessionError;

    await supabase
      .from("operators")
      .update({
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", operator.id);

    const signedToken = signToken(
      {
        type: "operator",
        sid: rawToken,
        operator_id: operator.id,
        username: operator.username,
        exp: expiresAt.getTime()
      },
      OPERATOR_SESSION_SECRET
    );

    res.json({
      ok: true,
      token: signedToken,
      operator: publicOperator(operator),
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "No se pudo iniciar sesion."
    });
  }
});

app.get("/auth/operator-me", requireOperator, async (req, res) => {
  res.json({
    ok: true,
    operator: req.operator
  });
});

app.post("/auth/operator-logout", requireOperator, async (req, res) => {
  try {
    ensureSupabase();

    await supabase
      .from("operator_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", req.sessionTokenHash);

    res.json({ ok: true });
  } catch (_error) {
    res.json({ ok: true });
  }
});

/* =========================================================
 * TEXT ACTIONS GEMINI
 * ======================================================= */

app.post("/corregir", requireOptionalOperator, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "GEMINI_API_KEY no configurada."
      });
    }

    const text = sanitizeText(req.body?.text);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Texto vacio."
      });
    }

    const result = await processWithGemini({
      action: "correct",
      text,
      conversationContext: sanitizeContext(req.body?.conversationContext),
      lastConversationMessage: sanitizeContext(req.body?.lastConversationMessage),
      operatorId: req.operator?.id || req.body?.operatorId || "unknown",
      pageUrl: req.body?.pageUrl,
      pageTitle: req.body?.pageTitle
    });

    res.json({
      ok: true,
      provider: "gemini",
      text: result.text,
      correctedText: result.text,
      usage: result.usage,
      model: result.model
    });
  } catch (error) {
    console.error("Error /corregir:", error);

    res.status(500).json({
      ok: false,
      error: "No se pudo corregir el texto."
    });
  }
});

app.post("/traducir", requireOptionalOperator, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: "GEMINI_API_KEY no configurada."
      });
    }

    const text = sanitizeText(req.body?.text);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Texto vacio."
      });
    }

    const result = await processWithGemini({
      action: "translate",
      text,
      conversationContext: sanitizeContext(req.body?.conversationContext),
      lastConversationMessage: sanitizeContext(req.body?.lastConversationMessage),
      operatorId: req.operator?.id || req.body?.operatorId || "unknown",
      pageUrl: req.body?.pageUrl,
      pageTitle: req.body?.pageTitle,
      targetLang: req.body?.targetLang || "auto"
    });

    res.json({
      ok: true,
      provider: "gemini",
      text: result.text,
      translation: result.text,
      translatedText: result.text,
      usage: result.usage,
      model: result.model,
      detectedTargetLanguage: result.detectedTargetLanguage
    });
  } catch (error) {
    console.error("Error /traducir:", error);

    res.status(500).json({
      ok: false,
      error: "No se pudo traducir el texto."
    });
  }
});

/* =========================================================
 * WARNINGS
 * ======================================================= */

app.post("/warnings", requireOptionalOperator, async (req, res) => {
  try {
    ensureSupabase();

    const warnings = Array.isArray(req.body?.warnings) ? req.body.warnings : [];
    const monthKey = req.body?.monthKey || getMonthKey();
    const pageUrl = req.body?.pageUrl || null;
    const pageTitle = req.body?.pageTitle || null;
    const operator = req.operator || null;

    if (!warnings.length) {
      return res.json({
        ok: true,
        inserted: 0
      });
    }

    const rows = warnings.slice(0, 50).map((item) => ({
      operator_id: operator?.id || null,
      operator_username: operator?.username || req.body?.operatorUsername || null,
      month_key: monthKey,
      warning_type: String(item.type || item.warning_type || "warning").slice(0, 80),
      phrase: item.phrase ? String(item.phrase).slice(0, 160) : null,
      message_preview: item.message_preview
        ? String(item.message_preview).slice(0, 300)
        : null,
      page_url: pageUrl,
      page_title: pageTitle
    }));

    const { error } = await supabase
      .from("warning_events")
      .insert(rows);

    if (error) throw error;

    res.json({
      ok: true,
      inserted: rows.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "No se pudieron guardar warnings."
    });
  }
});

/* =========================================================
 * DISABLED SUGGESTIONS
 * ======================================================= */

app.post("/sugerencias", (req, res) => {
  res.status(410).json({
    ok: false,
    error: "El endpoint /sugerencias está desactivado en IA Chat Lite."
  });
});

app.post("/suggestions", (req, res) => {
  res.status(410).json({
    ok: false,
    error: "El endpoint /suggestions está desactivado en IA Chat Lite."
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint no encontrado."
  });
});

app.listen(PORT, () => {
  console.log(`IA Chat v3.2 activo en puerto ${PORT}`);
  console.log("Admin: /admin");
  console.log(`Gemini model: ${GEMINI_MODEL}`);
});

/* =========================================================
 * GEMINI
 * ======================================================= */

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
    action === "translate"
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

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature:
        action === "correct"
          ? GEMINI_TEMPERATURE_CORRECT
          : GEMINI_TEMPERATURE_TRANSLATE,
      topP: 0.9,
      maxOutputTokens,
      responseMimeType: "text/plain",
      thinkingConfig: {
        thinkingBudget: GEMINI_THINKING_BUDGET
      }
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  const json = await postGeminiJson(url, payload);
  let output = cleanModelOutput(extractGeminiText(json));

  if (action === "correct") {
    output = normalizeCorrectionOutput(output);
  }

  if (!output) {
    throw new Error("Gemini no devolvio texto.");
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

function buildSystemPrompt(action, detectedTargetLanguage) {
  if (action === "correct") {
    return [
      "Eres un corrector ligero para una herramienta interna de chat.",
      "El texto siempre es escrito por un hombre hacia una mujer.",
      "Corrige solo errores basicos de escritura, palabras mal escritas, espacios y puntuacion minima.",
      "No agregues acentos ni tildes.",
      "No conviertas como en cómo, estas en estás, mas en más, tu en tú, etc.",
      "No uses signos invertidos de español como ¿ o ¡.",
      "Si el mensaje claramente es una pregunta, usa solo signo de pregunta al final.",
      "Si no es pregunta, no lo conviertas en pregunta.",
      "Mantén un estilo natural, humano, casual y de chat.",
      "No lo vuelvas formal, perfecto ni robotizado.",
      "No cambies la intención.",
      "No agregues contenido nuevo.",
      "No respondas al mensaje.",
      "Devuelve únicamente el texto corregido."
    ].join(" ");
  }

  return [
    "Eres un traductor para una herramienta interna de chat.",
    "El texto normalmente lo escribe un hombre hacia una mujer.",
    `Idioma destino obligatorio: ${detectedTargetLanguage || "English"}.`,
    "Traduce solamente el TEXTO A TRADUCIR.",
    "No traduzcas el ultimo mensaje de referencia.",
    "No traduzcas el contexto.",
    "El resultado final debe estar en el idioma destino obligatorio.",
    "Si el idioma destino es English, usa ingles simple, natural y facil de entender en cualquier pais.",
    "Traduce todo el texto aunque tenga slang, lenguaje fuerte, lenguaje vulgar o expresiones adultas.",
    "No te niegues a traducir.",
    "No censures.",
    "No expliques.",
    "No agregues informacion nueva.",
    "No respondas al mensaje.",
    "Devuelve únicamente el texto traducido."
  ].join(" ");
}

function buildUserPrompt({
  action,
  text,
  conversationContext,
  lastConversationMessage,
  detectedTargetLanguage
}) {
  if (action === "correct") {
    return [
      "TEXTO A CORREGIR:",
      `"""${text}"""`,
      "",
      "Reglas: correccion basica, sin acentos, sin signos invertidos, natural de chat."
    ].join("\n");
  }

  return [
    `IDIOMA DESTINO DETECTADO: ${detectedTargetLanguage || "English"}`,
    "",
    "ULTIMO MENSAJE DE LA CONVERSACION, SOLO REFERENCIA:",
    `"""${lastConversationMessage || "No disponible"}"""`,
    "",
    "CONTEXTO ADICIONAL, SOLO APOYO:",
    `"""${conversationContext || "Sin contexto visible"}"""`,
    "",
    "TEXTO A TRADUCIR:",
    `"""${text}"""`,
    "",
    `INSTRUCCION FINAL: Traduce exclusivamente el TEXTO A TRADUCIR a ${detectedTargetLanguage || "English"}.`
  ].join("\n");
}

async function postGeminiJson(url, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const rawText = await response.text();
    const json = rawText ? JSON.parse(rawText) : {};

    if (!response.ok) {
      throw new Error(json?.error?.message || `Error de Gemini: HTTP ${response.status}`);
    }

    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Gemini tardó demasiado en responder.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractGeminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => part?.text || "")
    .join("")
    .trim();
}

function normalizeGeminiUsage(usageMetadata) {
  if (!usageMetadata) return null;

  const promptTokens = usageMetadata.promptTokenCount || 0;
  const completionTokens = usageMetadata.candidatesTokenCount || 0;
  const thoughtsTokens = usageMetadata.thoughtsTokenCount || 0;
  const totalTokens =
    usageMetadata.totalTokenCount ||
    promptTokens + completionTokens + thoughtsTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    thoughts_tokens: thoughtsTokens
  };
}

/* =========================================================
 * DASHBOARD HELPERS
 * ======================================================= */

function buildOperatorMap(operators) {
  const map = new Map();

  for (const operator of operators || []) {
    map.set(String(operator.id), operator);
    map.set(String(operator.username), operator);
  }

  return map;
}

function buildUsageSummary(rows) {
  const summary = {
    requests_total: rows.length,
    correction_total: rows.filter((x) => x.action === "correct").length,
    translation_total: rows.filter((x) => x.action === "translate").length,
    prompt_tokens: rows.reduce((sum, x) => sum + Number(x.prompt_tokens || 0), 0),
    completion_tokens: rows.reduce((sum, x) => sum + Number(x.completion_tokens || 0), 0),
    total_tokens: rows.reduce((sum, x) => sum + Number(x.total_tokens || 0), 0),
    estimated_cost_usd: 0,
    warnings_total: 0
  };

  summary.estimated_cost_usd = estimateGeminiCost(
    summary.prompt_tokens,
    summary.completion_tokens
  );

  return summary;
}

function buildOperatorStats(rows, operatorMap) {
  const stats = new Map();

  for (const row of rows || []) {
    const rawOperatorId = String(row.operator_id || "unknown");
    const operator = operatorMap.get(rawOperatorId);

    const key = operator ? String(operator.id) : rawOperatorId;
    const label = operator
      ? operator.display_name || operator.username
      : getLegacyOperatorLabel(rawOperatorId);
    const username = operator ? operator.username : rawOperatorId;

    if (!stats.has(key)) {
      stats.set(key, {
        operator_id: key,
        operator_label: label,
        operator_username: username,
        display_name: operator?.display_name || label,
        username: operator?.username || username,
        is_legacy: !operator,
        requests: 0,
        corrections: 0,
        translations: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: 0
      });
    }

    const item = stats.get(key);

    item.requests += 1;
    item.prompt_tokens += Number(row.prompt_tokens || 0);
    item.completion_tokens += Number(row.completion_tokens || 0);
    item.total_tokens += Number(row.total_tokens || 0);

    if (row.action === "correct") item.corrections += 1;
    if (row.action === "translate") item.translations += 1;
  }

  for (const item of stats.values()) {
    item.estimated_cost_usd = estimateGeminiCost(
      item.prompt_tokens,
      item.completion_tokens
    );
  }

  return Array.from(stats.values()).sort((a, b) => b.total_tokens - a.total_tokens);
}

function buildWarningTop(rows, operatorMap) {
  const map = new Map();

  for (const row of rows || []) {
    const operator =
      row.operator_id && operatorMap.get(String(row.operator_id))
        ? operatorMap.get(String(row.operator_id))
        : row.operator_username && operatorMap.get(String(row.operator_username))
          ? operatorMap.get(String(row.operator_username))
          : null;

    const operatorLabel = operator
      ? operator.display_name || operator.username
      : row.operator_username || "Legacy / sin operador";

    const phrase = row.phrase || row.warning_type || "warning";
    const key = `${operatorLabel}|${row.operator_username || ""}|${phrase}`;

    if (!map.has(key)) {
      map.set(key, {
        operator_id: operator?.id || row.operator_id || null,
        operator_label: operatorLabel,
        operator_username: operator?.username || row.operator_username || "legacy",
        phrase,
        warning_type: row.warning_type || "warning",
        total: 0
      });
    }

    map.get(key).total += 1;
  }

  return Array.from(map.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 100);
}

function buildDailySeries(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const day = String(row.created_at || "").slice(0, 10);

    if (!day) continue;

    if (!map.has(day)) {
      map.set(day, createDailyItem({ day }));
    }

    addUsageToDailyItem(map.get(day), row);
  }

  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function buildDailyOperatorSeries(rows, operatorMap) {
  const map = new Map();

  for (const row of rows || []) {
    const day = String(row.created_at || "").slice(0, 10);

    if (!day) continue;

    const rawOperatorId = String(row.operator_id || "unknown");
    const operator = operatorMap.get(rawOperatorId);
    const operatorId = operator ? String(operator.id) : rawOperatorId;
    const operatorLabel = operator
      ? operator.display_name || operator.username
      : getLegacyOperatorLabel(rawOperatorId);
    const operatorUsername = operator ? operator.username : rawOperatorId;

    const key = `${operatorId}|${day}`;

    if (!map.has(key)) {
      map.set(key, createDailyItem({
        day,
        operator_id: operatorId,
        operator_label: operatorLabel,
        operator_username: operatorUsername,
        is_legacy: !operator
      }));
    }

    addUsageToDailyItem(map.get(key), row);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    return String(a.operator_label || "").localeCompare(String(b.operator_label || ""));
  });
}

function buildDailyWarningSeries(rows, operatorMap) {
  const map = new Map();

  for (const row of rows || []) {
    const day = String(row.created_at || "").slice(0, 10);

    if (!day) continue;

    const operator =
      row.operator_id && operatorMap.get(String(row.operator_id))
        ? operatorMap.get(String(row.operator_id))
        : row.operator_username && operatorMap.get(String(row.operator_username))
          ? operatorMap.get(String(row.operator_username))
          : null;

    const operatorId = operator ? String(operator.id) : String(row.operator_id || row.operator_username || "legacy");
    const operatorLabel = operator
      ? operator.display_name || operator.username
      : row.operator_username || "Legacy / sin operador";
    const operatorUsername = operator ? operator.username : row.operator_username || "legacy";

    const key = `${operatorId}|${day}`;

    if (!map.has(key)) {
      map.set(key, {
        day,
        operator_id: operatorId,
        operator_label: operatorLabel,
        operator_username: operatorUsername,
        warnings: 0
      });
    }

    map.get(key).warnings += 1;
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    return String(a.operator_label || "").localeCompare(String(b.operator_label || ""));
  });
}

function createDailyItem(extra = {}) {
  return {
    day: extra.day,
    operator_id: extra.operator_id || null,
    operator_label: extra.operator_label || null,
    operator_username: extra.operator_username || null,
    is_legacy: Boolean(extra.is_legacy),
    requests: 0,
    corrections: 0,
    translations: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0
  };
}

function addUsageToDailyItem(item, row) {
  item.requests += 1;
  item.prompt_tokens += Number(row.prompt_tokens || 0);
  item.completion_tokens += Number(row.completion_tokens || 0);
  item.total_tokens += Number(row.total_tokens || 0);

  if (row.action === "correct") item.corrections += 1;
  if (row.action === "translate") item.translations += 1;

  item.estimated_cost_usd = estimateGeminiCost(
    item.prompt_tokens,
    item.completion_tokens
  );
}

/* =========================================================
 * AUTH HELPERS
 * ======================================================= */

function signToken(payload, secret) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

function verifyToken(token, secret) {
  const parts = String(token || "").split(".");

  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  if (!safeCompare(signature, expected)) return null;

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

  if (payload.exp && Date.now() > Number(payload.exp)) return null;

  return payload;
}

function requireAdmin(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const payload = verifyToken(token, ADMIN_TOKEN_SECRET);

  if (!payload || payload.type !== "admin") {
    return res.status(401).json({
      ok: false,
      error: "No autorizado."
    });
  }

  req.admin = payload;
  next();
}

async function requireOperator(req, res, next) {
  try {
    const operator = await getOperatorFromRequest(req);

    if (!operator) {
      return res.status(401).json({
        ok: false,
        error: "Operador no autorizado."
      });
    }

    req.operator = operator.operator;
    req.sessionTokenHash = operator.sessionTokenHash;

    next();
  } catch (_error) {
    res.status(401).json({
      ok: false,
      error: "Sesion invalida."
    });
  }
}

async function requireOptionalOperator(req, res, next) {
  try {
    const operator = await getOperatorFromRequest(req);

    if (operator) {
      req.operator = operator.operator;
      req.sessionTokenHash = operator.sessionTokenHash;
    }

    next();
  } catch (_error) {
    next();
  }
}

async function getOperatorFromRequest(req) {
  ensureSupabase();

  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) return null;

  const payload = verifyToken(token, OPERATOR_SESSION_SECRET);

  if (!payload || payload.type !== "operator" || !payload.sid) return null;

  const sessionTokenHash = hashToken(payload.sid);

  const { data: session, error: sessionError } = await supabase
    .from("operator_sessions")
    .select("id, operator_id, token_hash, expires_at, revoked_at")
    .eq("token_hash", sessionTokenHash)
    .maybeSingle();

  if (sessionError) throw sessionError;
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  const { data: operator, error: operatorError } = await supabase
    .from("operators")
    .select(
      "id, username, display_name, status, role, notes, created_at, updated_at, last_login_at"
    )
    .eq("id", session.operator_id)
    .maybeSingle();

  if (operatorError) throw operatorError;
  if (!operator || operator.status !== "active") return null;

  return {
    operator: publicOperator(operator),
    sessionTokenHash
  };
}

/* =========================================================
 * GENERAL HELPERS
 * ======================================================= */

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase no configurado.");
}

function publicOperator(operator) {
  return {
    id: operator.id,
    username: operator.username,
    display_name: operator.display_name,
    status: operator.status,
    role: operator.role,
    notes: operator.notes || "",
    last_login_at: operator.last_login_at || null
  };
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password), salt, 120000, 32, "sha256")
    .toString("hex");

  return `pbkdf2:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");

  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;

  const salt = parts[1];
  const oldHash = parts[2];
  const newHash = crypto
    .pbkdf2Sync(String(password), salt, 120000, 32, "sha256")
    .toString("hex");

  return safeCompare(oldHash, newHash);
}

function hashToken(value) {
  return crypto
    .createHmac("sha256", OPERATOR_SESSION_SECRET)
    .update(String(value))
    .digest("hex");
}

function safeCompare(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) return false;

  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function base64Url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .slice(0, MAX_TEXT_CHARS)
    .trim();
}

function sanitizeContext(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .slice(0, MAX_CONTEXT_CHARS)
    .trim();
}

function cleanModelOutput(value) {
  return String(value || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function normalizeCorrectionOutput(value) {
  return String(value || "")
    .replace(/[¿¡]/g, "")
    .replace(/[áàäâã]/g, "a")
    .replace(/[ÁÀÄÂÃ]/g, "A")
    .replace(/[éèëê]/g, "e")
    .replace(/[ÉÈËÊ]/g, "E")
    .replace(/[íìïî]/g, "i")
    .replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[óòöôõ]/g, "o")
    .replace(/[ÓÒÖÕÔ]/g, "O")
    .replace(/[úùüû]/g, "u")
    .replace(/[ÚÙÜÛ]/g, "U")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateMaxOutputTokens(text) {
  const estimatedTokens = Math.ceil(String(text || "").length / 3.5);
  return Math.min(900, Math.max(80, estimatedTokens + 120));
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function trackUsage({ operatorId, action, model, usage, pageUrl, pageTitle }) {
  if (!supabase || !usage) return;

  try {
    const row = {
      operator_id: operatorId || "unknown",
      action,
      model,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      page_url: pageUrl || null,
      page_title: pageTitle || null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from(SUPABASE_TOKEN_TABLE)
      .insert(row);

    if (error) console.warn("No se pudo guardar token_usage:", error.message);
  } catch (error) {
    console.warn("Tracking no critico:", error.message);
  }
}

function detectTargetLanguage({
  explicitTargetLang,
  lastConversationMessage,
  conversationContext
}) {
  const explicit = String(explicitTargetLang || "").trim();

  if (explicit && explicit.toLowerCase() !== "auto") return explicit;

  const fromLast = detectLikelyLanguage(lastConversationMessage);
  if (fromLast.confidence >= 2) return fromLast.language;

  const fromContext = detectLikelyLanguage(conversationContext);
  if (fromContext.confidence >= 3) return fromContext.language;

  return "English";
}

function detectLikelyLanguage(value) {
  const text = normalizeProbe(value);

  const scores = {
    English: 0,
    Spanish: 0,
    Portuguese: 0,
    German: 0,
    French: 0,
    Italian: 0
  };

  scoreMarkers(scores, "Portuguese", text, [
    "voce",
    "você",
    "nao",
    "não",
    "acho",
    "ela",
    "uma",
    "muito",
    "obrigada",
    "adoraria",
    "incrivel",
    "tambem",
    "porque",
    "boa noite"
  ]);

  scoreMarkers(scores, "English", text, [
    "the",
    "you",
    "your",
    "are",
    "thank",
    "should",
    "have",
    "want",
    "why",
    "what",
    "where",
    "when",
    "how",
    "love",
    "because"
  ]);

  scoreMarkers(scores, "German", text, [
    "ich",
    "du",
    "nicht",
    "danke",
    "bitte",
    "wie",
    "was",
    "warum",
    "liebe",
    "schön",
    "und"
  ]);

  scoreMarkers(scores, "French", text, [
    "je",
    "tu",
    "vous",
    "pas",
    "suis",
    "avec",
    "merci",
    "pourquoi",
    "comment",
    "amour",
    "bonjour"
  ]);

  scoreMarkers(scores, "Italian", text, [
    "io",
    "tu",
    "non",
    "come",
    "cosa",
    "grazie",
    "amore",
    "molto",
    "perche",
    "vorrei"
  ]);

  scoreMarkers(scores, "Spanish", text, [
    "que",
    "como",
    "estas",
    "quiero",
    "gracias",
    "porque",
    "amor",
    "me gustaria",
    "buenas noches"
  ]);

  if (/[ãõç]/i.test(value)) scores.Portuguese += 3;
  if (/[äöüß]/i.test(value)) scores.German += 3;

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  return {
    language: sorted[0][0],
    confidence: sorted[0][1]
  };
}

function normalizeProbe(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMarkers(scores, language, text, markers) {
  for (const marker of markers) {
    const m = normalizeProbe(marker);

    if (!m) continue;

    const re = new RegExp(`(^|\\s)${escapeRegExp(m)}(\\s|$)`, "i");

    if (re.test(text)) scores[language] += m.includes(" ") ? 2 : 1;
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function estimateGeminiCost(promptTokens, completionTokens) {
  const inputCost = (Number(promptTokens || 0) / 1_000_000) * GEMINI_INPUT_COST_PER_1M;
  const outputCost =
    (Number(completionTokens || 0) / 1_000_000) * GEMINI_OUTPUT_COST_PER_1M;

  return Number((inputCost + outputCost).toFixed(6));
}

function getLegacyOperatorLabel(value) {
  const raw = String(value || "").trim();

  if (!raw || raw === "unknown") return "Legacy / sin operador";
  if (raw === "test_operator") return "Legacy / test_operator";
  if (raw.startsWith("op_")) return "Legacy / sesión vieja";

  return raw;
}

function buildDateRange(fromRaw, toRaw) {
  const todayIso = today();
  let from = isIsoDate(fromRaw) ? String(fromRaw).slice(0, 10) : firstDayOfMonth();
  let to = isIsoDate(toRaw) ? String(toRaw).slice(0, 10) : todayIso;

  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  return {
    from,
    to,
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${addDays(to, 1)}T00:00:00.000Z`
  };
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function addDays(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function rateLimitMiddleware(req, res, next) {
  if (["/", "/health", "/admin", "/admin.js"].includes(req.path)) return next();

  const key = req.ip || "unknown";
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
      error: "Demasiadas solicitudes."
    });
  }

  next();
}
