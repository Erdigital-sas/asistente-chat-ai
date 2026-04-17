const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 API KEY desde entorno (Railway)
const API_KEY = process.env.OPENAI_API_KEY;

// ===== FETCH COMPATIBLE (IMPORTANTE)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ===== DETECTOR CONTACTO EXTERNO (AMPLIO)
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

// ===== DETECCIÓN EMOCIÓN
function detectarEmocion(texto = "") {
  const t = texto.toLowerCase();

  if (t.includes("love") || t.includes("miss") || t.includes("baby")) return "afectiva";
  if (t.includes("busy") || t.includes("work")) return "ocupada";
  if (t.length < 20 || t.includes("ok")) return "fria";

  return "neutral";
}

// ===== TEST SERVER (MUY IMPORTANTE EN PRODUCCIÓN)
app.get("/", (req, res) => {
  res.send("Servidor IA activo 🔥");
});


// ==========================
// 🔥 SUGERENCIAS IA
// ==========================
app.post("/sugerencias", async (req, res) => {
  try {
    const { texto, contexto, cliente } = req.body;

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
Eres un experto en psicología y comunicación en una plataforma de citas hablando con una mujer.

Tu trabajo es mejorar el mensaje del operador.

Reglas:
- NO eres una IA
- NO estás respondiendo
- SOLO reescribes el mensaje
- NO cambies la intención
- No inventes información
- No saludes si ya hay conversación
- Usa tono natural, cercano y masculino hacia una mujer

SITUACIÓN CRÍTICA:
Si la cliente menciona:
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

Debes sonar:
- tranquilo
- seguro
- natural

Ejemplo correcto:
"Prefiero seguir hablando por aquí, me siento más cómodo así 😊"

Emoción detectada: ${emocion}

Contexto:
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
// 🌍 TRADUCCIÓN
// ==========================
app.post("/traducir", async (req, res) => {
  try {
    const { texto } = req.body;

    if (!texto) {
      return res.json({ ok: false });
    }

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
            content: "Traduce al inglés de forma natural y atractiva para hablar con una mujer."
          },
          {
            role: "user",
            content: texto
          }
        ]
      })
    });

    const data = await response.json();
    const traducido = data.choices?.[0]?.message?.content;

    res.json({ ok: true, traducido });

  } catch (err) {
    console.log(err);
    res.json({ ok: false });
  }
});


// 🚀 PUERTO DINÁMICO (CLAVE PARA RAILWAY)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});