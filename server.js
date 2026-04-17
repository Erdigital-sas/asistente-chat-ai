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
- NO hacer preguntas nuevas
- NO responder por tu cuenta

━━━━━━━━━━━━━━━━━━
🚫 CONTACTO EXTERNO
━━━━━━━━━━━━━━━━━━
${contacto ? `
La mujer pidió contacto externo.

Debes rechazar SIEMPRE de forma firme pero natural.
No negocies.
No abras posibilidad futura.
` : "No hay solicitud de contacto externo."}

━━━━━━━━━━━━━━━━━━
💬 ESTILO
━━━━━━━━━━━━━━━━━━
- natural
- masculino
- atractivo
- emocional sin exagerar
- fluido

━━━━━━━━━━━━━━━━━━
🧠 EMOCIÓN
━━━━━━━━━━━━━━━━━━
${emocion}

━━━━━━━━━━━━━━━━━━
🎯 PERFIL
━━━━━━━━━━━━━━━━━━
Nombre: ${perfil?.nombre || ""}
Edad: ${perfil?.edad || ""}
Intereses: ${perfil?.intereses_comunes || ""}

━━━━━━━━━━━━━━━━━━
📌 CONTEXTO
━━━━━━━━━━━━━━━━━━
${contextoReducido}
`;

    const userPrompt = `
Mensaje del operador:
"${texto}"

Último mensaje de la mujer:
"${cliente || ""}"

━━━━━━━━━━━━━━━━━━
🎯 OBJETIVO
━━━━━━━━━━━━━━━━━━

Genera 3 versiones del mensaje:

🟢 Limpia → más clara y natural  
🟡 Mejorada → más emocional  
🔥 Alta conversión → más atractiva  

━━━━━━━━━━━━━━━━━━
⚠️ REGLAS
━━━━━━━━━━━━━━━━━━
- NO cambiar significado
- NO inventar contexto
- NO agregar cosas nuevas
- NO hacer preguntas nuevas

━━━━━━━━━━━━━━━━━━
🌍 TRADUCCIÓN
━━━━━━━━━━━━━━━━━━
Debe poder traducirse fácil a inglés

━━━━━━━━━━━━━━━━━━
📌 IMPORTANTE
━━━━━━━━━━━━━━━━━━
- Puedes acortar o mejorar
- No alargues sin sentido

Devuelve SOLO las 3 opciones en líneas separadas.
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
        temperature: 0.7
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

    const tokens = JSON.stringify(data).length / 4;

    await supabase.from("consumo").insert([
      {
        operador: operador || "anon",
        tokens,
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
          { role: "system", content: "Traduce al inglés natural." },
          { role: "user", content: texto }
        ],
        temperature: 0.3
      })
    });

    const data = await response.json();

    const tokens = JSON.stringify(data).length / 4;

    await supabase.from("consumo").insert([
      {
        operador: operador || "anon",
        tokens,
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