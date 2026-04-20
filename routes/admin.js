// routes/admin.js
const express = require("express");

const { runtimeStats } = require("../state");
const { construirRangoFechas } = require("../lib/utils");
const {
  cargarConsumoPorRango,
  cargarWarningsPorRango,
  construirDashboardAnalytics
} = require("../lib/analytics");

const {
  autorizarAdmin,
  adminEstaConfigurado,
  obtenerClaveRateAdmin,
  adminLoginBloqueado,
  credencialesAdminValidas,
  registrarIntentoAdmin,
  crearAdminToken,
  listarOperadoresAdmin,
  resumirOperadores,
  crearOReactivarOperadorAdmin,
  parsearNombresBulk,
  parsearFiltroOperadores,
  borrarOperadorCache
} = require("../services/operators");

const {
  getAdminHtmlPath,
  getAdminJsPath
} = require("../services/core");

const { supabase, ADMIN_USER, ADMIN_TOKEN_TTL_HOURS, OPERATOR_SHARED_KEY } = require("../config");

const router = express.Router();

router.get(["/admin", "/admin/"], (_req, res) => {
  return res.sendFile(getAdminHtmlPath());
});

router.get("/admin.js", (_req, res) => {
  return res.sendFile(getAdminJsPath());
});

router.post("/admin-api/login", async (req, res) => {
  runtimeStats.admin.loginTotal += 1;

  if (!adminEstaConfigurado()) {
    runtimeStats.admin.loginError += 1;
    return res.status(503).json({
      ok: false,
      error: "Configura ADMIN_USER, ADMIN_PASSWORD y ADMIN_TOKEN_SECRET en Railway"
    });
  }

  const usuario = String(req.body?.usuario || "").trim();
  const password = String(req.body?.password || "").trim();

  if (!usuario || !password) {
    runtimeStats.admin.loginError += 1;
    return res.status(400).json({
      ok: false,
      error: "Completa usuario y password"
    });
  }

  const rateKey = obtenerClaveRateAdmin(req, usuario);

  if (adminLoginBloqueado(rateKey)) {
    runtimeStats.admin.loginError += 1;
    return res.status(429).json({
      ok: false,
      error: "Demasiados intentos. Espera unos minutos"
    });
  }

  if (!credencialesAdminValidas(usuario, password)) {
    registrarIntentoAdmin(rateKey, false);
    runtimeStats.admin.loginError += 1;
    return res.status(401).json({
      ok: false,
      error: "Credenciales admin invalidas"
    });
  }

  registrarIntentoAdmin(rateKey, true);
  runtimeStats.admin.loginOk += 1;

  return res.json({
    ok: true,
    token: crearAdminToken(ADMIN_USER),
    user: ADMIN_USER,
    operator_shared_key: OPERATOR_SHARED_KEY,
    expires_in_hours: ADMIN_TOKEN_TTL_HOURS
  });
});

router.get("/admin-api/session", autorizarAdmin, async (req, res) => {
  return res.json({
    ok: true,
    user: req.adminAuth?.sub || ADMIN_USER,
    expires_at: req.adminAuth?.exp || null,
    operator_shared_key: OPERATOR_SHARED_KEY
  });
});

router.get("/admin-api/operators", autorizarAdmin, async (_req, res) => {
  try {
    const operators = await listarOperadoresAdmin();
    runtimeStats.admin.operatorList += 1;

    return res.json({
      ok: true,
      summary: resumirOperadores(operators),
      operators
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo listar operadores"
    });
  }
});

router.post("/admin-api/operators", autorizarAdmin, async (req, res) => {
  try {
    const result = await crearOReactivarOperadorAdmin(req.body?.nombre || "");
    runtimeStats.admin.operatorCreate += 1;

    return res.json({
      ok: true,
      action: result.action,
      operator: result.operator
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo guardar el operador"
    });
  }
});

router.post("/admin-api/operators/bulk", autorizarAdmin, async (req, res) => {
  try {
    const nombres = parsearNombresBulk(req.body?.texto || req.body?.nombres || "");

    if (!nombres.length) {
      return res.status(400).json({
        ok: false,
        error: "Pega al menos un nombre"
      });
    }

    const result = {
      created: [],
      reactivated: [],
      updated: [],
      existing: [],
      errors: []
    };

    for (const nombre of nombres) {
      try {
        const item = await crearOReactivarOperadorAdmin(nombre);
        if (item.action === "created") result.created.push(item.operator);
        else if (item.action === "reactivated") result.reactivated.push(item.operator);
        else if (item.action === "updated") result.updated.push(item.operator);
        else result.existing.push(item.operator);
      } catch (err) {
        result.errors.push({
          nombre,
          error: err.message || "No se pudo procesar"
        });
      }
    }

    runtimeStats.admin.operatorCreate +=
      result.created.length + result.reactivated.length + result.updated.length;

    const operators = await listarOperadoresAdmin();

    return res.json({
      ok: true,
      result,
      summary: resumirOperadores(operators),
      operators
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo procesar el alta masiva"
    });
  }
});

router.patch("/admin-api/operators/:id/status", autorizarAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const activo = Boolean(req.body?.activo);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID invalido"
      });
    }

    const { data: actual, error: errorRead } = await supabase
      .from("operadores")
      .select("id, nombre, activo, created_at")
      .eq("id", id)
      .maybeSingle();

    if (errorRead) {
      throw new Error("No se pudo leer el operador");
    }

    if (!actual) {
      return res.status(404).json({
        ok: false,
        error: "Operador no encontrado"
      });
    }

    if (!activo) {
      borrarOperadorCache(actual.nombre);
    }

    const { data, error } = await supabase
      .from("operadores")
      .update({ activo })
      .eq("id", id)
      .select("id, nombre, activo, created_at")
      .single();

    if (error || !data) {
      throw new Error("No se pudo actualizar el operador");
    }

    runtimeStats.admin.operatorUpdate += 1;

    return res.json({
      ok: true,
      operator: data
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo actualizar el operador"
    });
  }
});

router.delete("/admin-api/operators/:id", autorizarAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID invalido"
      });
    }

    const { data: actual, error: errorRead } = await supabase
      .from("operadores")
      .select("id, nombre, activo, created_at")
      .eq("id", id)
      .maybeSingle();

    if (errorRead) {
      throw new Error("No se pudo leer el operador");
    }

    if (!actual) {
      return res.status(404).json({
        ok: false,
        error: "Operador no encontrado"
      });
    }

    const { error } = await supabase
      .from("operadores")
      .delete()
      .eq("id", id);

    if (error) {
      throw new Error("No se pudo eliminar el operador");
    }

    borrarOperadorCache(actual.nombre);
    runtimeStats.admin.operatorDelete += 1;

    return res.json({
      ok: true,
      operator: actual
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || "No se pudo eliminar el operador"
    });
  }
});

router.get("/admin-api/dashboard", autorizarAdmin, async (req, res) => {
  try {
    const range = construirRangoFechas(req.query?.from || "", req.query?.to || "");
    const operadoresFiltrados = parsearFiltroOperadores(req.query?.operadores || "");

    const [consumoRows, warningRows] = await Promise.all([
      cargarConsumoPorRango(range, operadoresFiltrados),
      cargarWarningsPorRango(range, operadoresFiltrados)
    ]);

    runtimeStats.admin.dashboardLoads += 1;

    return res.json({
      ok: true,
      ...construirDashboardAnalytics({
        consumoRows,
        warningRows,
        range,
        operadoresFiltrados
      })
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "No se pudo cargar el dashboard"
    });
  }
});

module.exports = router;