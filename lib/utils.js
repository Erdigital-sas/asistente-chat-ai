// lib/utils.js
const { randomUUID, timingSafeEqual } = require("crypto");

function leerEnteroEnv(nombre, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[nombre];
  const n = Number.parseInt(raw, 10);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function leerDecimalEnv(nombre, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[nombre];
  const n = Number.parseFloat(raw);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function crearRequestId() {
  try {
    return randomUUID();
  } catch (_err) {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

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

function compactarBloque(texto = "", maxChars = 1200) {
  const limpio = String(texto ?? "").trim();
  if (!limpio) return "";

  if (limpio.length <= maxChars) return limpio;

  return limpio.slice(-maxChars);
}

function asegurarCierreNatural(texto = "") {
  const limpio = normalizarEspacios(String(texto ?? ""));
  if (!limpio) return "";

  return limpiarSalidaHumana(
    limpio
      .replace(/[?¿]+$/g, "")
      .replace(/[.!]+$/g, "")
      .trim()
  );
}

function limpiarLinea(texto = "") {
  return limpiarSalidaHumana(
    String(texto ?? "")
      .replace(/^\s*\d+[\).\-\s:]*/, "")
      .replace(/^\s*[•\-–—]+\s*/, "")
  );
}

function extraerBloquesIA(texto = "") {
  const raw = String(texto ?? "")
    .replace(/\r/g, "")
    .trim();

  if (!raw) return [];

  const bloques = [];
  const regex = /(?:^|\n)\s*\d+\s*[\).\-\:]*\s*([\s\S]*?)(?=(?:\n\s*\d+\s*[\).\-\:]*\s)|$)/g;

  let match;
  while ((match = regex.exec(raw))) {
    const bloque = normalizarEspacios(String(match[1] || "").replace(/\n+/g, " "));
    if (bloque) bloques.push(bloque);
  }

  if (bloques.length) return bloques;

  return raw
    .split(/\n+/)
    .map((linea) => normalizarEspacios(linea))
    .filter(Boolean);
}

function contarCaracteres(texto = "") {
  return normalizarEspacios(String(texto ?? "")).length;
}

function contarPreguntas(texto = "") {
  const t = String(texto ?? "");
  const abiertas = (t.match(/¿/g) || []).length;
  const cerradas = (t.match(/\?/g) || []).length;
  return abiertas + cerradas;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function redondearDinero(n = 0) {
  return Number(safeNumber(n, 0).toFixed(6));
}

function formatearFechaISO(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function primerDiaMesUTC(date = new Date()) {
  return formatearFechaISO(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function esFechaISOValida(texto = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(texto || ""));
}

function sumarDiasISO(fechaISO = "", dias = 0) {
  const d = new Date(`${fechaISO}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";

  d.setUTCDate(d.getUTCDate() + dias);
  return formatearFechaISO(d);
}

function compararFechasISO(a = "", b = "") {
  return String(a).localeCompare(String(b));
}

function construirRangoFechas(fromRaw = "", toRaw = "") {
  const hoy = formatearFechaISO(new Date());
  let from = esFechaISOValida(fromRaw) ? fromRaw : primerDiaMesUTC(new Date());
  let to = esFechaISOValida(toRaw) ? toRaw : hoy;

  if (compararFechasISO(from, to) > 0) {
    const temp = from;
    from = to;
    to = temp;
  }

  return {
    from,
    to,
    startIso: `${from}T00:00:00.000Z`,
    endExclusiveIso: `${sumarDiasISO(to, 1)}T00:00:00.000Z`
  };
}

function base64UrlEncode(input = "") {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input), "utf8");

  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input = "") {
  const normalized = String(input)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padding = normalized.length % 4 === 0
    ? ""
    : "=".repeat(4 - (normalized.length % 4));

  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function compararSeguro(a = "", b = "") {
  const aa = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");

  if (aa.length !== bb.length) return false;

  try {
    return timingSafeEqual(aa, bb);
  } catch (_err) {
    return false;
  }
}

async function seleccionarTodasLasPaginas(builderFactory, pageSize = 1000) {
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await builderFactory(from, from + pageSize - 1);

    if (error) {
      throw error;
    }

    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);

    if (chunk.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return rows;
}

function dedupeStrings(items = []) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const limpio = normalizarEspacios(item);
    const key = normalizarTexto(limpio);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(limpio);
  }

  return result;
}

function partirPipe(texto = "") {
  return dedupeStrings(
    String(texto ?? "")
      .split("|")
      .map((x) => normalizarEspacios(x))
      .filter(Boolean)
  );
}

module.exports = {
  leerEnteroEnv,
  leerDecimalEnv,
  crearRequestId,
  quitarTildes,
  normalizarTexto,
  normalizarEspacios,
  formatearNombreOperador,
  limpiarSalidaHumana,
  compactarBloque,
  asegurarCierreNatural,
  limpiarLinea,
  extraerBloquesIA,
  contarCaracteres,
  contarPreguntas,
  safeNumber,
  redondearDinero,
  formatearFechaISO,
  primerDiaMesUTC,
  esFechaISOValida,
  sumarDiasISO,
  compararFechasISO,
  construirRangoFechas,
  base64UrlEncode,
  base64UrlDecode,
  compararSeguro,
  seleccionarTodasLasPaginas,
  dedupeStrings,
  partirPipe
};