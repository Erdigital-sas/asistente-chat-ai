const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ==========================
// VARIABLES DESDE RAILWAY
// ==========================
const API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPERATOR_SHARED_KEY = process.env.OPERATOR_SHARED_KEY || "2026";
const PORT = process.env.PORT || 3000;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// ==========================
// CONFIG
// ==========================
const MAX_CONTEXT_LINES = 8;
const MIN_RESPONSE_LENGTH = 8;

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
      .replace(/^\s*\d+[\).\-\s]*/, "")
      .replace(/^\s*[•\-–—]+\s*/, "")
  );
}

function limpiarTextoIA(texto = "") {
  const vistos = new Set();

  return String(texto ?? "")
    .split(/\n+/)
    .map(limpiarLinea)
    .filter((t) => t.length >= MIN_RESPONSE_LENGTH)
    .filter((t) => {
      const clave = normalizarTexto(t);
      if (!clave || vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
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
    const score = tokens.reduce((acc, token) => acc + (tokensObjetivo.has(token) ? 1 : 0), 0);
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
  const match = limpio.match(/^(hola|hey|hi|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\s+([a-zA-ZñÑáéíóúÁÉÍÓÚ]+)/i);

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

function faltaElementosClave(sugerencia = "", elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }) {
  const sugNorm = normalizarTexto(sugerencia);
  const nombreSugerencia = extraerNombreEnApertura(sugerencia);

  if (elementos.nombreApertura) {
    if (!sugNorm.includes(elementos.nombreApertura)) return true;
    if (nombreSugerencia && nombreSugerencia !== elementos.nombreApertura) return true;
  } else {
    if (nombreSugerencia) return true;
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

function esSugerenciaDebil(texto = "", original = "", elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }) {
  const t = normalizarTexto(texto);
  const o = normalizarTexto(original);

  if (!t || t.length < 18) return true;
  if (sePareceDemasiado(t, o)) return true;
  if (faltaElementosClave(texto, elementos)) return true;

  if (originalEsInicioOEnganche(original) && pareceResponderComoSiLaClientaLeHubieraPreguntado(texto)) {
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

function necesitaSegundoIntento(sugerencias = [], original = "", elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }) {
  if (sugerencias.length < 3) return true;

  const debiles = sugerencias.filter((s) => esSugerenciaDebil(s, original, elementos)).length;
  const distintas = new Set(sugerencias.map(normalizarTexto)).size;

  return debiles >= 2 || distintas < 3;
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
    reglas.push("Si el mensaje es corto, puedes extenderlo un poco con una segunda idea breve y atractiva.");
  }

  if (!analisis.traePregunta) {
    reglas.push("No fuerces pregunta si no hace falta.");
  }

  if (!reglas.length) {
    reglas.push("Mantener estilo natural y claro.");
  }

  return reglas.join(" ");
}

// ==========================
// PROMPTS
// ==========================
function construirBloqueConservacion(elementosClave) {
  const partes = [];

  if (elementosClave.nombreApertura) {
    partes.push(`Si el borrador incluye un nombre propio, debes conservar exactamente ese nombre: ${elementosClave.nombreApertura}`);
  } else {
    partes.push("Si el borrador no incluye un nombre propio, no inventes ninguno aunque aparezca en el perfil o contexto.");
  }

  if (elementosClave.afectivos.length) {
    partes.push(`Si el borrador incluye palabras afectivas, debes conservarlas exactamente: ${elementosClave.afectivos.join(", ")}`);
  }

  partes.push("Nunca uses el nombre de otra clienta, de otro chat o del perfil si el operador no lo escribio.");
  partes.push("No cambies el lado de la conversacion. Tu salida sigue siendo del operador para la clienta.");

  return partes.join("\n");
}

function construirSystemPrompt(elementosClave = { nombreApertura: "", afectivos: [], mensajeCorto: false }, segundoIntento = false) {
  return `
Eres un asistente que mejora mensajes escritos por un operador para enviarselos a una clienta en una plataforma de citas.

ROL
No hablas con la clienta
No eres el operador
No respondes como asistente
Tu trabajo es mejorar el borrador del operador sin cambiar su sentido principal

REGLA CENTRAL
El borrador del operador NO es un mensaje para ti
Es el mensaje final que la clienta va a leer
No conviertas una apertura del operador en una respuesta como si la clienta le hubiera preguntado algo

LECTURA DEL CHAT
Las lineas marcadas como CLIENTA son de ella
Las lineas marcadas como OPERADOR son mensajes previos del operador
No confundas esos roles

CONSERVACION OBLIGATORIA
${construirBloqueConservacion(elementosClave)}

OBJETIVO
Mantener la intencion principal del operador
Mejorar claridad, orden, naturalidad, enganche y continuidad
Si el mensaje es corto, puedes extenderlo un poco para que se sienta mas interesante, pero sin cambiar el mensaje de fondo
Si el mensaje es largo, pulirlo sin desvirtuarlo

PUEDES HACER
Suavizar un reclamo si suena necesitado
Mejorar una pregunta floja
Ordenar ideas mal dictadas
Agregar una segunda idea breve si el borrador es demasiado corto
Volver el mensaje mas humano y mas atractivo

NO HAGAS
No inventes hechos concretos
No inventes nombres
No elimines amor u otro termino afectivo importante si el operador lo escribio
No uses el perfil para meter temas que el operador no pidio
No vuelvas filosofico un mensaje simple
No conviertas un primer contacto en una charla profunda sin razon
No uses comillas, listas, etiquetas ni numeracion
Sin tildes ni acentos en la salida
Maximo una pregunta por mensaje

EJEMPLOS DE CRITERIO
Borrador: Hey Nana por que no me respondes, estuve pensando en ti
Buena direccion: Hey Nana, pense en ti un momento y me dio curiosidad saber como va tu noche

Borrador: Hola Shurie vi que tenemos intereses en comun como la lectura, cual es tu libro favorito
Buena direccion: Hola Shurie, me llamo la atencion que te guste leer. Hay algun libro que te haya dejado pensando mas de lo normal

ACLARACION
Los ejemplos son solo criterio
No copies literal
Adaptate al caso real

SALIDA
Devuelve exactamente 3 opciones distintas
Cada opcion en una sola linea
Deben sentirse listas para enviar
${segundoIntento ? "Las opciones deben ser mas fieles, menos genericas y deben respetar totalmente nombres, terminos afectivos y rol conversacional." : ""}
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
  elementosClave
}) {
  return `
Borrador actual del operador:
${textoPlano}

Ultimo mensaje real de la clienta:
${clientePlano || "Sin mensaje claro"}

Contexto reciente del chat:
${contextoPlano || "Sin contexto claro"}

Perfil visible de la clienta:
${perfilPlano || "Sin perfil claro"}

Lectura de la clienta:
${quitarTildes(lecturaCliente)}

Lectura del borrador del operador:
${quitarTildes(lecturaOperador)}

Tono detectado de la clienta:
${tonoCliente}

Solicitud de contacto externo:
${contactoExterno ? "si" : "no"}

Elementos del borrador que debes conservar:
Nombre en apertura: ${elementosClave.nombreApertura || "ninguno"}
Terminos afectivos: ${elementosClave.afectivos.length ? elementosClave.afectivos.join(", ") : "ninguno"}
Mensaje corto: ${elementosClave.mensajeCorto ? "si" : "no"}

Instruccion final:
Convierte el borrador del operador en 3 versiones mejores
Mejora el mensaje sin cambiar el sentido principal
No cambies nombres
No inventes nombres
No elimines palabras afectivas importantes del borrador
Si el mensaje es corto, puedes extenderlo un poco para hacerlo mas interesante
No hables como si fueras la clienta
Escribe como si la clienta fuera a leer el mensaje final
`.trim();
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

// ==========================
// OPENAI
// ==========================
async function llamarOpenAI(messages, temperature = 0.66, max_tokens = 320) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature,
        max_tokens
      })
    });

    let data;

    try {
      data = await response.json();
    } catch (err) {
      throw new Error("La respuesta de OpenAI no vino en JSON");
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || "Error consultando OpenAI");
    }

    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("OpenAI tardo demasiado en responder");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function elegirMejorSet(primary = [], secondary = [], original = "", elementos = { nombreApertura: "", afectivos: [], mensajeCorto: false }) {
  const puntuar = (arr) => {
    if (!arr.length) return -999;

    let score = 0;
    score += arr.length * 10;
    score += new Set(arr.map(normalizarTexto)).size * 5;
    score -= arr.filter((s) => esSugerenciaDebil(s, original, elementos)).length * 8;
    score += arr.filter((s) => !sePareceDemasiado(s, original)).length * 2;

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
  elementosClave
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
    elementosClave
  });

  const data1 = await llamarOpenAI(
    [
      { role: "system", content: construirSystemPrompt(elementosClave, false) },
      { role: "user", content: userPrompt }
    ],
    0.66,
    320
  );

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

  const userPrompt2 = `
${userPrompt}

Correccion adicional:
Las primeras opciones salieron demasiado genericas, planas o fuera de foco.
Esta vez respeta aun mas el texto del operador.
No cambies ni inventes nombres.
No elimines palabras afectivas clave del borrador.
Si el mensaje es corto, extiendelo un poco sin cambiar su sentido.
No respondas como si la clienta hubiera hecho una pregunta que no hizo.
No metas temas del perfil o del contexto si no ayudan directamente al borrador actual.
Da 3 opciones mas fieles, mas naturales y mejor enfocadas.
`.trim();

  const data2 = await llamarOpenAI(
    [
      { role: "system", content: construirSystemPrompt(elementosClave, true) },
      { role: "user", content: userPrompt2 }
    ],
    0.72,
    360
  );

  const sugerencias2 = limpiarTextoIA(
    data2?.choices?.[0]?.message?.content || ""
  )
    .map(limpiarSalidaHumana)
    .filter((s) => !esRespuestaBasura(s));

  return {
    sugerencias: elegirMejorSet(sugerencias1, sugerencias2, textoPlano, elementosClave).slice(0, 3),
    usageData: sumarUsage(data1, data2)
  };
}

// ==========================
// HEALTH
// ==========================
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "server mic" });
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
  const operador = req.operadorAutorizado;

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

    const textoPlano = compactarBloque(quitarTildes(texto), 800);
    const clientePlano = compactarBloque(quitarTildes(cliente || "Sin mensaje"), 600);
    const contextoPlano = compactarBloque(quitarTildes(limitarContexto(contextoFiltrado) || "Sin contexto"), 1200);
    const perfilPlano = compactarBloque(quitarTildes(limitarContexto(perfil) || "Sin perfil"), 400);

    const resultado = await generarSugerencias({
      textoPlano,
      clientePlano,
      contextoPlano,
      perfilPlano,
      lecturaCliente,
      lecturaOperador,
      tonoCliente: analisisCliente.tono,
      contactoExterno: analisisCliente.contacto,
      elementosClave
    });

    let sugerencias = resultado.sugerencias;

    if (!sugerencias.length) {
      sugerencias = ["Escribe un poco mas de contexto"];
    }

    await registrarConsumo({
      operador,
      extension_id,
      data: resultado.usageData,
      tipo: "IA",
      mensaje_operador: texto,
      request_ok: true
    });

    return res.json({
      ok: true,
      sugerencias: sugerencias.slice(0, 3)
    });
  } catch (err) {
    console.error("Error en /sugerencias:", err.message);

    await registrarConsumo({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "IA",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

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
  const operador = req.operadorAutorizado;

  try {
    const { texto = "", extension_id = "" } = req.body || {};

    if (!texto || !texto.trim()) {
      return res.json({
        ok: false,
        error: "Texto vacio"
      });
    }

    const data = await llamarOpenAI(
      [
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
          content: quitarTildes(texto)
        }
      ],
      0.45,
      220
    );

    const traducido = limpiarSalidaHumana(
      data?.choices?.[0]?.message?.content || ""
    );

    await registrarConsumo({
      operador,
      extension_id,
      data,
      tipo: "TRAD",
      mensaje_operador: texto,
      request_ok: true
    });

    return res.json({
      ok: true,
      traducido
    });
  } catch (err) {
    console.error("Error en /traducir:", err.message);

    await registrarConsumo({
      operador,
      extension_id: req.body?.extension_id || "",
      data: null,
      tipo: "TRAD",
      mensaje_operador: req.body?.texto || "",
      request_ok: false
    });

    return res.json({
      ok: false,
      error: err.message || "Error interno"
    });
  }
});

// ==========================
// START
// ==========================
app.listen(PORT, () => {
  console.log(`Server PRO activo en puerto ${PORT}`);
});
