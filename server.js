const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================
// 🔐 ENV VARIABLES
// ==========================
const API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================
// 🔒 CONFIG
// ==========================
const MAX_CONTEXT_LINES = 3;
const MIN_RESPONSE_LENGTH = 8;

// ==========================
// 🧠 UTILIDADES
// ==========================
function esSolicitudContacto(texto = "") {
  const t = texto.toLowerCase();

  return [
    "whatsapp","telegram","phone","number","email","mail",
    "correo","instagram","ig","snap","snapchat","facebook",
    "contact","número"
  ].some(k => t.includes(k));
}

function detectarEmocion(texto = "") {
  const t = texto.toLowerCase();

  if (t.includes("love") || t.includes("miss") || t.includes("baby")) return "afectiva";
  if (t.includes("busy") || t.includes("work")) return "ocupada";
  if (t.length < 20 || t.includes("ok")) return "fria";

  return "neutral";
}

function limpiarTextoIA(texto = "") {
  return texto
    .split(/\n+/)
    .map(t =>
      t
        .replace(/^\d+[\).\-\s]*/, "")
        .replace(/^"+|"+$/g, "")
        .trim()
    )
    .filter(t => t.length >= MIN_RESPONSE_LENGTH);
}

function limitarContexto(ctx = "") {
  return ctx
    .split("\n")
    .slice(-MAX_CONTEXT_LINES)
    .join("\n");
}

function esRespuestaBasura(texto = "") {
  const t = texto.toLowerCase();

  return (
    t.length < MIN_RESPONSE_LENGTH ||
    t === "ok" ||
    t === "jaja" ||
    t === "yes" ||
    t === "no"
  );
}

// ==========================
// 🧠 IA PRINCIPAL
// ==========================
app.post("/sugerencias", async (req, res) => {
  try {
    const { texto, contexto, cliente, perfil, operador } = req.body;

    if (!texto || texto.trim().length < 2) {
      return res.json({ ok: false, sugerencias: [] });
    }

    const emocion = detectarEmocion(cliente);
    const contacto = esSolicitudContacto(cliente);
    const contextoReducido = limitarContexto(contexto);

    const systemPrompt = `
Eres un asistente experto en comunicación que ayuda a un operador (hombre) a responderle a una mujer en una app de citas.

⚠️ IMPORTANTE:
- NO hablas con la mujer
- NO eres el operador
- SOLO mejoras el mensaje del operador

━━━━━━━━━━━━━━━━━━
🧠 FUNCIÓN
━━━━━━━━━━━━━━━━━━
- Reescribir el mensaje
- Mantener intención EXACTA
- Mejorar claridad, atractivo y fluidez

━━━━━━━━━━━━━━━━━━
⚠️ REGLAS CRÍTICAS
━━━━━━━━━━━━━━━━━━
- NO cambiar significado
- NO inventar información
- NO agregar contexto nuevo
- NO responder por tu cuenta

━━━━━━━━━━━━━━━━━━
❓ USO DE PREGUNTAS
━━━━━━━━━━━━━━━━━━
- Puedes hacer preguntas SOLO si son naturales
- Deben basarse en el contexto o perfil
- No preguntas genéricas como "cómo estás"
- Máximo 1 pregunta por mensaje

━━━━━━━━━━━━━━━━━━
🚫 FORMATO PROHIBIDO
━━━━━━━━━━━━━━━━━━
- No usar comillas
- No usar guiones (-)
- No usar símbolos especiales
- No usar formato estructurado
- No usar emojis al inicio
- Máximo 1 emoji y solo si es natural

━━━━━━━━━━━━━━━━━━
🧠 ESTILO HUMANO
━━━━━━━━━━━━━━━━━━
- Debe parecer escrito por una persona real
- Puede tener ligeras imperfecciones naturales
- No sonar perfecto
- Fluido, natural, conversacional

━━━━━━━━━━━━━━━━━━
🚫 CONTACTO EXTERNO
━━━━━━━━━━━━━━━━━━
${contacto ? `
La mujer pidió contacto externo.
Debes rechazar SIEMPRE de forma natural.
` : "No hay solicitud de contacto externo."}

━━━━━━━━━━━━━━━━━━
🧠 EMOCIÓN
━━━━━━━━━━━━━━━━━━
${emocion}

━━━━━━━━━━━━━━━━━━
📌 CONTEXTO
━━━━━━━━━━━━━━━━━━
${contextoReducido}
`;

    const userPrompt = `
Mensaje del operador:
${texto}

Último mensaje de la mujer:
${cliente || ""}

━━━━━━━━━━━━━━━━━━
🎯 OBJETIVO
━━━━━━━━━━━━━━━━━━
Genera 3 versiones del mensaje mejoradas.

━━━━━━━━━━━━━━━━━━
⚠️ REGLAS
━━━━━━━━━━━━━━━━━━
- Mantener significado exacto
- No inventar información
- No cambiar intención
- No usar comillas
- No usar guiones
- No usar símbolos raros
- No sonar perfecto

━━━━━━━━━━━━━━━━━━
📌 IMPORTANTE
━━━━━━━━━━━━━━━━━━
Las respuestas deben poder enviarse directamente sin parecer generadas por IA.

Devuelve SOLO 3 opciones en líneas separadas.
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.85
      })
    });

    const data = await response.json();

    let sugerencias = limpiarTextoIA(
      data.choices?.[0]?.message?.content || ""
    );

    sugerencias = sugerencias.filter(s => !esRespuestaBasura(s));

    if (!sugerencias.length) {
      sugerencias = ["Escribe un poco más de contexto"];
    }

    await supabase.from("consumo").insert([
      {
        operador: operador || "anon",
        tokens: JSON.stringify(data).length / 4,
        tipo: "IA"
      }
    ]);

    res.json({
      ok: true,
      sugerencias: sugerencias.slice(0, 3)
    });

  } catch (err) {
    console.error(err);
    res.json({ ok: false, sugerencias: [] });
  }
});

// ==========================
// 🌍 TRADUCCIÓN
// ==========================
app.post("/traducir", async (req, res) => {
  try {
    const { texto, operador } = req.body;

    if (!texto) return res.json({ ok: false });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Traduce al inglés como una persona real escribiría.

REGLAS:
- No usar guiones
- No usar comillas
- No usar símbolos especiales
- No sonar perfecto
- Debe sonar natural y humano
`
          },
          { role: "user", content: texto }
        ],
        temperature: 0.4
      })
    });

    const data = await response.json();

    await supabase.from("consumo").insert([
      {
        operador: operador || "anon",
        tokens: JSON.stringify(data).length / 4,
        tipo: "TRAD"
      }
    ]);

    res.json({
      ok: true,
      traducido: data.choices?.[0]?.message?.content
    });

  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

// ==========================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server PRO activo");
});