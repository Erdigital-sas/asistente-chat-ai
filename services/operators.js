// services/operators.js
const { createHmac } = require("crypto");

const {
  supabase,
  OPERATOR_SHARED_KEY,
  ADMIN_USER,
  ADMIN_PASSWORD,
  ADMIN_TOKEN_SECRET,
  ADMIN_TOKEN_TTL_HOURS,
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_LOGIN_MAX_ATTEMPTS,
  OPERATOR_CACHE_TTL_MS
} = require("../config");

const {
  operatorAuthCache,
  adminLoginAttempts
} = require("../state");

const {
  formatearNombreOperador,
  normalizarTexto,
  normalizarEspacios,
  base64UrlEncode,
  base64UrlDecode,
  compararSeguro,
  crearRequestId
} = require("../lib/utils");

function leerOperadorCache(nombreFormateado = "") {
  const key = normalizarTexto(nombreFormateado);
  const entry = operatorAuthCache.get(key);

  if (!entry) return "";

  if (entry.expiresAt <= Date.now()) {
    operatorAuthCache.delete(key);
    return "";
  }

  return entry.nombre || "";
}

function guardarOperadorCache(nombreFormateado = "", nombreReal = "") {
  const key = normalizarTexto(nombreFormateado);
  operatorAuthCache.set(key, {
    nombre: nombreReal,
    expiresAt: Date.now() + OPERATOR_CACHE_TTL_MS
  });
}

function borrarOperadorCache(nombre = "") {
  const key = normalizarTexto(formatearNombreOperador(nombre));
  if (!key) return;
  operatorAuthCache.delete(key);
}

function adminEstaConfigurado() {
  return Boolean(ADMIN_USER && ADMIN_PASSWORD && ADMIN_TOKEN_SECRET);
}

function firmarAdminToken(payloadB64 = "") {
  return base64UrlEncode(
    createHmac("sha256", ADMIN_TOKEN_SECRET).update(payloadB64).digest()
  );
}

function crearAdminToken(usuario = ADMIN_USER) {
  const now = Date.now();
  const payload = {
    sub: usuario || ADMIN_USER,
    role: "admin",
    iat: now,
    exp: now + (ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000),
    nonce: crearRequestId()
  };

  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = firmarAdminToken(payloadB64);

  return `${payloadB64}.${signature}`;
}

function verificarAdminToken(token = "") {
  const [payloadB64, signature] = String(token || "").split(".");

  if (!payloadB64 || !signature) {
    throw new Error("Token admin invalido");
  }

  const expected = firmarAdminToken(payloadB64);

  if (!compararSeguro(signature, expected)) {
    throw new Error("Token admin invalido");
  }

  let payload = null;

  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (_err) {
    throw new Error("Token admin invalido");
  }

  if (!payload?.sub || payload?.role !== "admin") {
    throw new Error("Token admin invalido");
  }

  if (!payload?.exp || payload.exp < Date.now()) {
    throw new Error("Sesion admin expirada");
  }

  return payload;
}

function limpiarIntentosAdmin() {
  const ahora = Date.now();

  for (const [key, entry] of adminLoginAttempts.entries()) {
    const recientes = (entry?.timestamps || []).filter(
      (ts) => (ahora - ts) < ADMIN_LOGIN_WINDOW_MS
    );

    if (!recientes.length) {
      adminLoginAttempts.delete(key);
      continue;
    }

    adminLoginAttempts.set(key, { timestamps: recientes });
  }
}

function obtenerClaveRateAdmin(req, usuario = "") {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || "sin-ip";
  return `${ip}::${normalizarTexto(usuario || "admin")}`;
}

function adminLoginBloqueado(rateKey = "") {
  if (!rateKey) return false;

  limpiarIntentosAdmin();
  const entry = adminLoginAttempts.get(rateKey);
  if (!entry) return false;

  return (entry.timestamps || []).length >= ADMIN_LOGIN_MAX_ATTEMPTS;
}

function registrarIntentoAdmin(rateKey = "", ok = false) {
  if (!rateKey) return;

  if (ok) {
    adminLoginAttempts.delete(rateKey);
    return;
  }

  limpiarIntentosAdmin();

  const entry = adminLoginAttempts.get(rateKey) || { timestamps: [] };
  entry.timestamps.push(Date.now());

  adminLoginAttempts.set(rateKey, entry);
}

function obtenerAdminTokenDesdeRequest(req) {
  const auth = String(req.headers.authorization || "");

  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }

  return String(req.headers["x-admin-token"] || req.body?.token || req.query?.token || "");
}

function credencialesAdminValidas(usuario = "", password = "") {
  return (
    compararSeguro(normalizarTexto(usuario), normalizarTexto(ADMIN_USER)) &&
    compararSeguro(String(password || ""), String(ADMIN_PASSWORD || ""))
  );
}

function autorizarAdmin(req, res, next) {
  if (!adminEstaConfigurado()) {
    return res.status(503).json({
      ok: false,
      error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET en Railway"
    });
  }

  try {
    const token = obtenerAdminTokenDesdeRequest(req);

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Sesion admin requerida"
      });
    }

    const payload = verificarAdminToken(token);
    req.adminAuth = payload;
    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: err.message || "Sesion admin invalida"
    });
  }
}

function validarNombreOperadorAdmin(nombre = "") {
  const nombreFinal = formatearNombreOperador(nombre);

  if (!nombreFinal) {
    throw new Error("Escribe un nombre valido");
  }

  if (nombreFinal.length < 3) {
    throw new Error("El nombre del operador es demasiado corto");
  }

  if (nombreFinal.length > 80) {
    throw new Error("El nombre del operador es demasiado largo");
  }

  return nombreFinal;
}

async function listarOperadoresAdmin() {
  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .order("nombre", { ascending: true });

  if (error) {
    throw new Error("No se pudo leer la lista de operadores");
  }

  return Array.isArray(data) ? data : [];
}

async function buscarOperadorPorNombreAdmin(nombre = "") {
  const nombreFinal = validarNombreOperadorAdmin(nombre);

  const { data, error } = await supabase
    .from("operadores")
    .select("id, nombre, activo, created_at")
    .ilike("nombre", nombreFinal)
    .limit(10);

  if (error) {
    throw new Error("No se pudo buscar el operador");
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

function resumirOperadores(operators = []) {
  const total = operators.length;
  const activos = operators.filter((x) => Boolean(x.activo)).length;
  const inactivos = total - activos;

  return {
    total,
    activos,
    inactivos
  };
}

async function crearOReactivarOperadorAdmin(nombre = "") {
  const nombreFinal = validarNombreOperadorAdmin(nombre);
  const existente = await buscarOperadorPorNombreAdmin(nombreFinal);

  if (existente) {
    const necesitaUpdate = !existente.activo || existente.nombre !== nombreFinal;

    if (!necesitaUpdate) {
      return {
        action: "exists",
        operator: existente
      };
    }

    borrarOperadorCache(existente.nombre);

    const { data, error } = await supabase
      .from("operadores")
      .update({
        nombre: nombreFinal,
        activo: true
      })
      .eq("id", existente.id)
      .select("id, nombre, activo, created_at")
      .single();

    if (error || !data) {
      throw new Error("No se pudo actualizar el operador");
    }

    return {
      action: existente.activo ? "updated" : "reactivated",
      operator: data
    };
  }

  const { data, error } = await supabase
    .from("operadores")
    .insert([
      {
        nombre: nombreFinal,
        activo: true
      }
    ])
    .select("id, nombre, activo, created_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "No se pudo crear el operador");
  }

  return {
    action: "created",
    operator: data
  };
}

function parsearNombresBulk(raw = "") {
  const nombres = String(raw ?? "")
    .split(/\r?\n|,/)
    .map((item) => formatearNombreOperador(item))
    .filter(Boolean);

  const vistos = new Set();
  const salida = [];

  for (const nombre of nombres) {
    const clave = normalizarTexto(nombre);
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(nombre);
  }

  return salida.slice(0, 300);
}

function parsearFiltroOperadores(raw = "") {
  const nombres = String(raw ?? "")
    .split(",")
    .map((item) => formatearNombreOperador(item))
    .filter(Boolean);

  return [...new Set(nombres)].slice(0, 100);
}

async function validarOperadorAcceso(operador = "", clave = "") {
  const operadorFormateado = formatearNombreOperador(operador);

  if (!operadorFormateado) {
    throw new Error("Operador vacio");
  }

  if (!compararSeguro(String(clave || ""), String(OPERATOR_SHARED_KEY || ""))) {
    throw new Error("Clave invalida");
  }

  const cacheHit = leerOperadorCache(operadorFormateado);
  if (cacheHit) {
    return cacheHit;
  }

  const { data, error } = await supabase
    .from("operadores")
    .select("nombre, activo")
    .ilike("nombre", operadorFormateado)
    .limit(10);

  if (error) {
    throw new Error("No se pudo validar el operador");
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;

  if (!row || !row.activo) {
    throw new Error("Operador no autorizado");
  }

  guardarOperadorCache(operadorFormateado, row.nombre);
  return row.nombre;
}

async function autorizarOperador(req, res, next) {
  try {
    const { operador = "", clave = "" } = req.body || {};
    const nombreValido = await validarOperadorAcceso(operador, clave);
    req.operadorAutorizado = nombreValido;
    return next();
  } catch (err) {
    return res.json({
      ok: false,
      error: err.message || "No autorizado"
    });
  }
}

module.exports = {
  leerOperadorCache,
  guardarOperadorCache,
  borrarOperadorCache,
  adminEstaConfigurado,
  crearAdminToken,
  verificarAdminToken,
  limpiarIntentosAdmin,
  obtenerClaveRateAdmin,
  adminLoginBloqueado,
  registrarIntentoAdmin,
  obtenerAdminTokenDesdeRequest,
  credencialesAdminValidas,
  autorizarAdmin,
  validarNombreOperadorAdmin,
  listarOperadoresAdmin,
  buscarOperadorPorNombreAdmin,
  resumirOperadores,
  crearOReactivarOperadorAdmin,
  parsearNombresBulk,
  parsearFiltroOperadores,
  validarOperadorAcceso,
  autorizarOperador
};