// lib/analytics.js
const {
  supabase,
  OPENAI_MODEL_SUGGESTIONS,
  OPENAI_MODEL_TRANSLATE,
  SUGGESTION_INPUT_COST_PER_1M,
  SUGGESTION_OUTPUT_COST_PER_1M,
  TRANSLATE_INPUT_COST_PER_1M,
  TRANSLATE_OUTPUT_COST_PER_1M
} = require("../config");

const {
  safeNumber,
  redondearDinero,
  formatearNombreOperador,
  normalizarTexto,
  normalizarEspacios,
  seleccionarTodasLasPaginas
} = require("./utils");

function obtenerCostosPorTipo(tipo = "") {
  const t = String(tipo || "").toUpperCase();

  if (t.startsWith("IA")) {
    return {
      input: SUGGESTION_INPUT_COST_PER_1M,
      output: SUGGESTION_OUTPUT_COST_PER_1M,
      lane: "IA"
    };
  }

  if (t.startsWith("TRAD")) {
    return {
      input: TRANSLATE_INPUT_COST_PER_1M,
      output: TRANSLATE_OUTPUT_COST_PER_1M,
      lane: "TRAD"
    };
  }

  return {
    input: 0,
    output: 0,
    lane: "OTRO"
  };
}

function calcularCostoEstimado({
  tipo = "",
  prompt_tokens = 0,
  completion_tokens = 0
}) {
  const costos = obtenerCostosPorTipo(tipo);

  const inputCost = (safeNumber(prompt_tokens) / 1_000_000) * costos.input;
  const outputCost = (safeNumber(completion_tokens) / 1_000_000) * costos.output;

  return redondearDinero(inputCost + outputCost);
}

async function cargarConsumoPorRango(range, operadoresFiltrados = []) {
  return seleccionarTodasLasPaginas((from, to) => {
    let query = supabase
      .from("consumo")
      .select("operador,tipo,tokens,prompt_tokens,completion_tokens,request_ok,created_at,extension_id")
      .gte("created_at", range.startIso)
      .lt("created_at", range.endExclusiveIso)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (operadoresFiltrados.length) {
      query = query.in("operador", operadoresFiltrados);
    }

    return query;
  });
}

async function cargarWarningsPorRango(range, operadoresFiltrados = []) {
  return seleccionarTodasLasPaginas((from, to) => {
    let query = supabase
      .from("warning_resumen_diario")
      .select("operador,extension_id,fecha,frase,cantidad_total,created_at,updated_at")
      .gte("fecha", range.from)
      .lte("fecha", range.to)
      .order("fecha", { ascending: false })
      .range(from, to);

    if (operadoresFiltrados.length) {
      query = query.in("operador", operadoresFiltrados);
    }

    return query;
  });
}

function crearSummaryDashboard() {
  return {
    total_requests: 0,
    ok_requests: 0,
    error_requests: 0,
    ia_requests: 0,
    trad_requests: 0,
    cache_hits: 0,
    shared_hits: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    active_operators: 0,
    warnings_total: 0,
    warnings_unique_pairs: 0
  };
}

function crearOperatorStat(operador = "") {
  return {
    operador,
    requests_total: 0,
    ok_requests: 0,
    error_requests: 0,
    ia_requests: 0,
    trad_requests: 0,
    cache_hits: 0,
    shared_hits: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0,
    last_activity: ""
  };
}

function crearSerieDia(fecha = "") {
  return {
    fecha,
    requests_total: 0,
    ia_requests: 0,
    trad_requests: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_total: 0,
    warnings_total: 0
  };
}

function construirDashboardAnalytics({
  consumoRows = [],
  warningRows = [],
  range,
  operadoresFiltrados = []
}) {
  const summary = crearSummaryDashboard();
  const operatorMap = new Map();
  const warningOperatorTotals = new Map();
  const warningTopMap = new Map();
  const seriesMap = new Map();

  for (const row of consumoRows) {
    const operador = formatearNombreOperador(row.operador || "anon") || "Anon";
    const tipo = normalizarEspacios(row.tipo || "");
    const totalTokens = safeNumber(row.tokens);
    const promptTokens = safeNumber(row.prompt_tokens);
    const completionTokens = safeNumber(row.completion_tokens);
    const requestOk = row.request_ok !== false;
    const fecha = String(row.created_at || "").slice(0, 10) || range.from;

    const cost = calcularCostoEstimado({
      tipo,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens
    });

    summary.total_requests += 1;
    if (requestOk) summary.ok_requests += 1;
    else summary.error_requests += 1;

    if (tipo.startsWith("IA")) summary.ia_requests += 1;
    if (tipo.startsWith("TRAD")) summary.trad_requests += 1;
    if (tipo.endsWith("_CACHE")) summary.cache_hits += 1;
    if (tipo.endsWith("_SHARED")) summary.shared_hits += 1;

    summary.total_tokens += totalTokens;
    summary.prompt_tokens += promptTokens;
    summary.completion_tokens += completionTokens;
    summary.estimated_cost_total += cost;

    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, crearOperatorStat(operador));
    }

    const op = operatorMap.get(operador);
    op.requests_total += 1;
    if (requestOk) op.ok_requests += 1;
    else op.error_requests += 1;
    if (tipo.startsWith("IA")) op.ia_requests += 1;
    if (tipo.startsWith("TRAD")) op.trad_requests += 1;
    if (tipo.endsWith("_CACHE")) op.cache_hits += 1;
    if (tipo.endsWith("_SHARED")) op.shared_hits += 1;
    op.total_tokens += totalTokens;
    op.prompt_tokens += promptTokens;
    op.completion_tokens += completionTokens;
    op.estimated_cost_total += cost;

    if (!op.last_activity || String(row.created_at || "") > op.last_activity) {
      op.last_activity = String(row.created_at || "");
    }

    if (!seriesMap.has(fecha)) {
      seriesMap.set(fecha, crearSerieDia(fecha));
    }

    const serie = seriesMap.get(fecha);
    serie.requests_total += 1;
    if (tipo.startsWith("IA")) serie.ia_requests += 1;
    if (tipo.startsWith("TRAD")) serie.trad_requests += 1;
    serie.total_tokens += totalTokens;
    serie.prompt_tokens += promptTokens;
    serie.completion_tokens += completionTokens;
    serie.estimated_cost_total += cost;
  }

  for (const row of warningRows) {
    const operador = formatearNombreOperador(row.operador || "anon") || "Anon";
    const frase = normalizarEspacios(row.frase || "");
    const cantidad = safeNumber(row.cantidad_total);
    const fecha = String(row.fecha || "") || range.from;

    summary.warnings_total += cantidad;

    const pairKey = `${operador}||${normalizarTexto(frase)}`;
    if (!warningTopMap.has(pairKey)) {
      warningTopMap.set(pairKey, {
        operador,
        frase,
        total_count: 0,
        last_date: fecha
      });
    }

    const top = warningTopMap.get(pairKey);
    top.total_count += cantidad;
    if (!top.last_date || fecha > top.last_date) {
      top.last_date = fecha;
    }

    warningOperatorTotals.set(
      operador,
      safeNumber(warningOperatorTotals.get(operador)) + cantidad
    );

    if (!seriesMap.has(fecha)) {
      seriesMap.set(fecha, crearSerieDia(fecha));
    }

    const serie = seriesMap.get(fecha);
    serie.warnings_total += cantidad;
  }

  summary.warnings_unique_pairs = warningTopMap.size;

  for (const [operador, totalWarnings] of warningOperatorTotals.entries()) {
    if (!operatorMap.has(operador)) {
      operatorMap.set(operador, crearOperatorStat(operador));
    }

    operatorMap.get(operador).warnings_total = totalWarnings;
  }

  summary.active_operators = operatorMap.size;
  summary.estimated_cost_total = redondearDinero(summary.estimated_cost_total);

  const operatorStats = Array.from(operatorMap.values())
    .map((op) => ({
      ...op,
      estimated_cost_total: redondearDinero(op.estimated_cost_total)
    }))
    .sort((a, b) => {
      if (b.estimated_cost_total !== a.estimated_cost_total) {
        return b.estimated_cost_total - a.estimated_cost_total;
      }

      if (b.total_tokens !== a.total_tokens) {
        return b.total_tokens - a.total_tokens;
      }

      return a.operador.localeCompare(b.operador);
    });

  const warningTop = Array.from(warningTopMap.values())
    .sort((a, b) => {
      if (b.total_count !== a.total_count) {
        return b.total_count - a.total_count;
      }

      return a.operador.localeCompare(b.operador);
    });

  const series = Array.from(seriesMap.values())
    .map((x) => ({
      ...x,
      estimated_cost_total: redondearDinero(x.estimated_cost_total)
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return {
    generated_at: new Date().toISOString(),
    range: {
      from: range.from,
      to: range.to
    },
    summary,
    operator_stats: operatorStats,
    warning_top: warningTop,
    series,
    operator_filter: operadoresFiltrados,
    pricing: {
      suggestions_model: OPENAI_MODEL_SUGGESTIONS,
      translate_model: OPENAI_MODEL_TRANSLATE,
      suggestion_input_cost_per_1m: SUGGESTION_INPUT_COST_PER_1M,
      suggestion_output_cost_per_1m: SUGGESTION_OUTPUT_COST_PER_1M,
      translate_input_cost_per_1m: TRANSLATE_INPUT_COST_PER_1M,
      translate_output_cost_per_1m: TRANSLATE_OUTPUT_COST_PER_1M
    }
  };
}

module.exports = {
  obtenerCostosPorTipo,
  calcularCostoEstimado,
  cargarConsumoPorRango,
  cargarWarningsPorRango,
  construirDashboardAnalytics
};