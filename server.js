const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 API KEY
const API_KEY = process.env.OPENAI_API_KEY;

// 🔥 SUPABASE CONFIG
const SUPABASE_URL = "https://qezzjjlvkrnizppsabmw.supabase.co";
const SUPABASE_KEY = "TU_SECRET_KEY_AQUI";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================
// DETECTOR CONTACTO EXTERNO
// ==========================
function esSolicitudContacto(texto = "") {
  const t = texto.toLowerCase();

  return (
    t.includes("whatsapp") ||
    t.includes("telegram") ||
    t.includes("phone") ||
    t.includes("number") ||
    t.includes("email") ||
    t.includes("mail") ||
    t.includes("correo") ||
    t.includes("instagram") ||
    t.includes("ig") ||
    t.includes("snap") ||
    t.includes("snapchat") ||
    t.includes("facebook") ||
    t.includes("contact") ||
    t.includes("número")
  );
}

// ==========================
// DETECCIÓN EMOCIÓN
// ==========================
function detectarEmocion(texto = "") {
  const t = texto.toLowerCase();

  if (t.includes("love") || t.includes("miss") || t.includes("baby")) return "afectiva";
  if (t.includes("busy") || t.includes("work")) return "ocupada";
  if (t.length < 20 || t.includes("ok")) return "fria";

  return "neutral";
}

// ==========================
// TEST
// ==========================
app.get("/", (req, res) => {
  res.send("Servidor IA activo 🔥");
});

// ==========================
// IA PRINCIPAL
// ==========================
app.post("/sugerencias", async (req, res) => {
  try {
    const { texto, contexto, cliente, perfil, operador } = req.body;

    if (!texto) {
      return res.json({ ok: false, sugerencias: [] });
    }

    const emocion = detectarEmocion(cliente);
    const contacto = esSolicitudContacto(cliente);

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
Eres un hombre real con experiencia en comunicación emocional hablando con una mujer en una plataforma de citas.

Tu único objetivo es mejorar el mensaje del operador sin cambiar su intención.

━━━━━━━━━━━━━━━━━━
🧠 FUNCIÓN PRINCIPAL
━━━━━━━━━━━━━━━━━━
- SOLO reescribes el mensaje
- NO respondes por tu cuenta
- NO inventas información
- NO agregas contexto nuevo
- Mantienes exactamente la intención original

━━━━━━━━━━━━━━━━━━
⚠️ REGLAS CRÍTICAS
━━━━━━━━━━━━━━━━━━
- No cambies el significado del mensaje
- No agregues información que no existe
- No hagas preguntas nuevas si no estaban implícitas
- No saludes si ya hay conversación
- No actúes como IA
- No expliques lo que haces

━━━━━━━━━━━━━━━━━━
🚫 CONTACTO EXTERNO
━━━━━━━━━━━━━━━━━━
Si la mujer menciona:
- teléfono
- whatsapp
- email
- redes sociales
- contacto fuera del sitio

DEBES:
- rechazar SIEMPRE
- no negociar
- no abrir posibilidad futura
- no decir "luego"
- no decir "más adelante"
- no sugerir salir de la plataforma

Ejemplo correcto:
"Prefiero seguir hablando por aquí, me siento más cómodo así 😊"

━━━━━━━━━━━━━━━━━━
💬 ESTILO
━━━━━━━━━━━━━━━━━━
Tu forma de escribir debe ser:
- natural
- masculina
- cercana
- emocional sin exagerar
- fluida

Evita:
- sonar robótico
- exagerar emoción
- repetir palabras

━━━━━━━━━━━━━━━━━━
🧠 AJUSTE POR EMOCIÓN
━━━━━━━━━━━━━━━━━━
Emoción detectada: ${emocion}

- afectiva → más cercano y cálido
- ocupada → directo y ligero
- fria → breve y natural
- neutral → equilibrio

━━━━━━━━━━━━━━━━━━
🎯 USO DE INTERESES
━━━━━━━━━━━━━━━━━━
Intereses en común: ${perfil?.intereses_comunes || ""}
Intereses del cliente: ${perfil?.intereses_cliente || ""}

- Prioriza los intereses en común
- Usa máximo 1 o 2 intereses
- No enumeres todos
- No fuerces conversación

━━━━━━━━━━━━━━━━━━
👤 PERFIL DE LA MUJER
━━━━━━━━━━━━━━━━━━
Nombre: ${perfil?.nombre || ""}
Edad: ${perfil?.edad || ""}

━━━━━━━━━━━━━━━━━━
📌 CONTEXTO
━━━━━━━━━━━━━━━━━━
${contexto || ""}
`
          },
          {
            role: "user",
            content: `
REESCRIBE ESTE MENSAJE:

${texto}

Último mensaje de ella:
${cliente || ""}

REGLAS:
- Mantén intención
- No respondas
- No inventes
- No cambies sentido

Devuelve 3 versiones del mismo mensaje.
`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log("ERROR OPENAI:", errorText);
      return res.json({ ok: false, sugerencias: [] });
    }

    const data = await response.json();
    const textoIA = data.choices?.[0]?.message?.content;

    if (!textoIA) {
      console.log("ERROR IA:", data);
      return res.json({ ok: false, sugerencias: [] });
    }

    // 🔥 TOKENS APROX
    const tokens = JSON.stringify(data).length / 4;

    // 🔥 GUARDAR EN SUPABASE
    await supabase.from("consumo").insert([
      {
        operador: operador || "sin_nombre",
        tokens,
        tipo: "IA"
      }
    ]);

    const sugerencias = textoIA
      .split(/\n+/)
      .map(t =>
        t
          .replace(/^\d+[\).\-\s]*/, "")
          .replace(/^"+|"+$/g, "")
          .trim()
      )
      .filter(t => t.length > 0);

    res.json({
      ok: true,
      sugerencias: sugerencias.slice(0, 3)
    });

  } catch (err) {
    console.log(err);
    res.json({ ok: false, sugerencias: [] });
  }
});

// ==========================
// TRADUCCIÓN
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
            content: "Traduce al inglés de forma natural y atractiva."
          },
          {
            role: "user",
            content: texto
          }
        ]
      })
    });

    const data = await response.json();

    const tokens = JSON.stringify(data).length / 4;

    await supabase.from("consumo").insert([
      {
        operador: operador || "sin_nombre",
        tokens,
        tipo: "TRADUCCION"
      }
    ]);

    res.json({
      ok: true,
      traducido: data.choices?.[0]?.message?.content
    });

  } catch (err) {
    console.log(err);
    res.json({ ok: false });
  }
});

// ==========================
// PANEL ADMIN
// ==========================
app.get("/admin", async (req, res) => {

  const { data } = await supabase.from("consumo").select("*");

  let resumen = {};

  data.forEach(r => {
    if (!resumen[r.operador]) {
      resumen[r.operador] = { requests: 0, tokens: 0 };
    }

    resumen[r.operador].requests++;
    resumen[r.operador].tokens += r.tokens;
  });

  let html = `
  <h1 style="font-family:Arial">📊 Panel Operadores</h1>
  <table border="1" cellpadding="10">
  <tr>
    <th>Operador</th>
    <th>Requests</th>
    <th>Tokens</th>
    <th>Costo</th>
  </tr>
  `;

  Object.entries(resumen).forEach(([op, d]) => {
    const costo = (d.tokens / 1000000) * 0.4;

    html += `
    <tr>
      <td>${op}</td>
      <td>${d.requests}</td>
      <td>${Math.round(d.tokens)}</td>
      <td>$${costo.toFixed(2)}</td>
    </tr>`;
  });

  html += "</table>";

  res.send(html);
});

// ==========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});