// routes/operator.js
const express = require("express");

const { runtimeStats } = require("../state");
const { autorizarOperador } = require("../services/operators");
const { guardarWarningResumen } = require("../services/warnings");
const { safeNumber } = require("../lib/utils");

const router = express.Router();

router.post("/login", autorizarOperador, async (req, res) => {
  return res.json({
    ok: true,
    operador: req.operadorAutorizado
  });
});

router.post("/warning-sync", autorizarOperador, async (req, res) => {
  const startedAt = Date.now();
  runtimeStats.warnings.total += 1;

  try {
    const {
      extension_id = "",
      fecha = "",
      counts = {}
    } = req.body || {};

    const result = await guardarWarningResumen({
      operador: req.operadorAutorizado,
      extension_id,
      fecha,
      counts
    });

    runtimeStats.warnings.ok += 1;
    runtimeStats.warnings.rowsUpserted += safeNumber(result.rowsUpserted);
    runtimeStats.warnings.lastMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      rows_upserted: result.rowsUpserted || 0
    });
  } catch (err) {
    runtimeStats.warnings.error += 1;
    runtimeStats.warnings.lastMs = Date.now() - startedAt;

    return res.json({
      ok: false,
      error: err.message || "No se pudo sincronizar warning"
    });
  }
});

module.exports = router;