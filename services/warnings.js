// services/warnings.js
const {
  supabase
} = require("../config");

const {
  formatearNombreOperador,
  normalizarEspacios,
  esFechaISOValida,
  formatearFechaISO,
  safeNumber
} = require("../lib/utils");

function limpiarCountsWarning(counts = {}) {
  const limpio = {};
  const entries = Object.entries(counts || {}).slice(0, 100);

  for (const [fraseRaw, cantidadRaw] of entries) {
    const frase = normalizarEspacios(String(fraseRaw || "")).slice(0, 180);
    const cantidad = Math.max(0, Math.min(999999, Number.parseInt(cantidadRaw, 10) || 0));

    if (!frase || cantidad <= 0) continue;
    limpio[frase] = (limpio[frase] || 0) + cantidad;
  }

  return limpio;
}

async function guardarWarningResumen({
  operador = "",
  extension_id = "",
  fecha = "",
  counts = {}
}) {
  const operadorFinal = formatearNombreOperador(operador || "");
  const fechaFinal = esFechaISOValida(fecha) ? fecha : formatearFechaISO(new Date());
  const countsLimpios = limpiarCountsWarning(counts);

  if (!operadorFinal) {
    throw new Error("Operador invalido para warning");
  }

  const frases = Object.keys(countsLimpios);
  if (!frases.length) {
    return { rowsUpserted: 0 };
  }

  const { data: existentes, error: errorRead } = await supabase
    .from("warning_resumen_diario")
    .select("frase, cantidad_total")
    .eq("operador", operadorFinal)
    .eq("fecha", fechaFinal)
    .in("frase", frases);

  if (errorRead) {
    throw new Error("No se pudieron leer los warnings existentes");
  }

  const actuales = new Map();
  for (const row of existentes || []) {
    actuales.set(String(row.frase || ""), safeNumber(row.cantidad_total));
  }

  const payload = frases.map((frase) => ({
    operador: operadorFinal,
    extension_id: normalizarEspacios(extension_id) || "",
    fecha: fechaFinal,
    frase,
    cantidad_total: safeNumber(actuales.get(frase)) + safeNumber(countsLimpios[frase]),
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase
    .from("warning_resumen_diario")
    .upsert(payload, {
      onConflict: "operador,fecha,frase"
    });

  if (error) {
    throw new Error(error.message || "No se pudo guardar warning");
  }

  return { rowsUpserted: payload.length };
}

module.exports = {
  limpiarCountsWarning,
  guardarWarningResumen
};