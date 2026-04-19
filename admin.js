const STORAGE_TOKEN_KEY = "ia_chat_admin_token";
const STORAGE_USER_KEY = "ia_chat_admin_user";

const state = {
  token: localStorage.getItem(STORAGE_TOKEN_KEY) || "",
  user: localStorage.getItem(STORAGE_USER_KEY) || "",
  sharedKey: "",
  operators: [],
  summary: {
    total: 0,
    activos: 0,
    inactivos: 0
  },
  dashboard: {
    generated_at: "",
    range: { from: "", to: "" },
    summary: {},
    operator_stats: [],
    warning_top: [],
    series: [],
    pricing: {}
  },
  flashTimer: null
};

function $(id) {
  return document.getElementById(id);
}

function existeEl(id) {
  return Boolean($(id));
}

function normalizarEspacios(texto = "") {
  return String(texto ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(texto = "") {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateInputLocal(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function getTodayLocal() {
  return formatDateInputLocal(new Date());
}

function getFirstDayOfMonthLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
}

function getStartOfLastNDays(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return formatDateInputLocal(d);
}

function formatDateTime(value = "") {
  if (!value) return "-";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return d.toLocaleString("es-ES", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function formatNumber(value = 0) {
  return new Intl.NumberFormat("es-ES").format(Number(value || 0));
}

function formatUsd(value = 0) {
  const n = Number(value || 0);
  const abs = Math.abs(n);

  let digits = 6;
  if (abs >= 100) digits = 2;
  else if (abs >= 1) digits = 4;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(n);
}

function showFlash(texto = "", tipo = "info") {
  const flash = $("flash");
  if (!flash) return;

  flash.className = `flash ${tipo}`;
  flash.textContent = texto;
  flash.classList.add("show");

  if (state.flashTimer) {
    clearTimeout(state.flashTimer);
  }

  state.flashTimer = setTimeout(() => {
    flash.classList.remove("show");
    state.flashTimer = null;
  }, 2800);
}

function setSession(token = "", user = "", sharedKey = "") {
  state.token = token || "";
  state.user = user || "";
  state.sharedKey = sharedKey || state.sharedKey || "";

  if (state.token) {
    localStorage.setItem(STORAGE_TOKEN_KEY, state.token);
  } else {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
  }

  if (state.user) {
    localStorage.setItem(STORAGE_USER_KEY, state.user);
  } else {
    localStorage.removeItem(STORAGE_USER_KEY);
  }
}

function clearSession() {
  state.token = "";
  state.user = "";
  state.sharedKey = "";
  state.operators = [];
  state.summary = {
    total: 0,
    activos: 0,
    inactivos: 0
  };
  state.dashboard = {
    generated_at: "",
    range: { from: "", to: "" },
    summary: {},
    operator_stats: [],
    warning_top: [],
    series: [],
    pricing: {}
  };

  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_USER_KEY);
}

function setView(logged) {
  $("login-view").classList.toggle("hidden", logged);
  $("app-view").classList.toggle("hidden", !logged);
}

async function api(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const res = await fetch(url, {
    ...options,
    headers
  });

  let data = null;

  try {
    data = await res.json();
  } catch (_err) {
    data = {
      ok: false,
      error: "Respuesta invalida del server"
    };
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || "Error del servidor");
  }

  return data;
}

function initAnalyticsDates() {
  if (existeEl("analytics-from") && !$("analytics-from").value) {
    $("analytics-from").value = getFirstDayOfMonthLocal();
  }

  if (existeEl("analytics-to") && !$("analytics-to").value) {
    $("analytics-to").value = getTodayLocal();
  }

  if (existeEl("analytics-group") && !$("analytics-group").value) {
    $("analytics-group").value = "day";
  }
}

async function loadHealth() {
  const dot = $("server-dot");
  const text = $("server-text");
  const loginHealth = $("login-health");

  try {
    const res = await fetch("/health", { cache: "no-store" });
    const data = await res.json();

    const online = Boolean(data?.ok);

    if (dot) {
      dot.classList.toggle("off", !online);
    }

    if (text) {
      text.textContent = online ? "Server online" : "Server sin respuesta";
    }

    if (loginHealth) {
      loginHealth.innerHTML = `
        <div class="status-pill">
          <span class="dot ${online ? "" : "off"}"></span>
          <span>${online ? "Server online" : "Server sin respuesta"}</span>
        </div>
      `;
    }
  } catch (_err) {
    if (dot) dot.classList.add("off");
    if (text) text.textContent = "Server sin respuesta";

    if (loginHealth) {
      loginHealth.innerHTML = `
        <div class="status-pill">
          <span class="dot off"></span>
          <span>Server sin respuesta</span>
        </div>
      `;
    }
  }
}

// ==========================
// CRUD OPERADORES
// ==========================
function renderSummary() {
  $("admin-user").textContent = state.user || "admin";
  $("stat-total").textContent = state.summary.total || 0;
  $("stat-activos").textContent = state.summary.activos || 0;
  $("stat-inactivos").textContent = state.summary.inactivos || 0;
  $("stat-key").textContent = state.sharedKey || "No definida";
}

function getFilteredOperators() {
  const q = normalizarEspacios($("search-input").value).toLowerCase();
  const status = $("status-filter").value;

  return state.operators.filter((item) => {
    const matchText = !q || String(item.nombre || "").toLowerCase().includes(q);
    const matchStatus =
      status === "all" ||
      (status === "active" && item.activo) ||
      (status === "inactive" && !item.activo);

    return matchText && matchStatus;
  });
}

function renderOperators() {
  const body = $("operators-body");
  const empty = $("empty-state");
  const rows = getFilteredOperators();

  if (!rows.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  body.innerHTML = rows.map((item) => {
    return `
      <tr>
        <td>${item.id}</td>
        <td><b>${escapeHtml(item.nombre || "")}</b></td>
        <td>
          <span class="tag ${item.activo ? "on" : "off"}">
            ${item.activo ? "Activo" : "Inactivo"}
          </span>
        </td>
        <td>${escapeHtml(formatDateTime(item.created_at))}</td>
        <td>
          <div class="actions-row">
            <button
              class="btn-mini ${item.activo ? "deactivate" : "activate"}"
              data-action="toggle"
              data-id="${item.id}"
              data-next="${item.activo ? "false" : "true"}"
            >
              ${item.activo ? "Desactivar" : "Activar"}
            </button>
            <button
              class="btn-mini delete"
              data-action="delete"
              data-id="${item.id}"
              data-name="${escapeHtml(item.nombre || "")}"
            >
              Eliminar
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadOperators() {
  const data = await api("/admin-api/operators");
  state.operators = Array.isArray(data.operators) ? data.operators : [];
  state.summary = data.summary || {
    total: 0,
    activos: 0,
    inactivos: 0
  };

  renderSummary();
  renderOperators();
}

// ==========================
// ANALYTICS
// ==========================
function setAnalyticsEmptyState(message = "Sin datos") {
  const seriesBody = $("analytics-series-body");
  const warningBody = $("analytics-warning-body");
  const operatorsBody = $("analytics-operators-body");

  if (seriesBody) {
    seriesBody.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(message)}</td></tr>`;
  }

  if (warningBody) {
    warningBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(message)}</td></tr>`;
  }

  if (operatorsBody) {
    operatorsBody.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(message)}</td></tr>`;
  }

  if (existeEl("kpi-total-requests")) $("kpi-total-requests").textContent = "-";
  if (existeEl("kpi-ia-requests")) $("kpi-ia-requests").textContent = "-";
  if (existeEl("kpi-trad-requests")) $("kpi-trad-requests").textContent = "-";
  if (existeEl("kpi-total-tokens")) $("kpi-total-tokens").textContent = "-";
  if (existeEl("kpi-total-cost")) $("kpi-total-cost").textContent = "-";
  if (existeEl("kpi-total-warnings")) $("kpi-total-warnings").textContent = "-";
}

function getAnalyticsRange() {
  const from = existeEl("analytics-from") ? $("analytics-from").value : "";
  const to = existeEl("analytics-to") ? $("analytics-to").value : "";

  return { from, to };
}

function getAnalyticsGroupMode() {
  return existeEl("analytics-group") ? $("analytics-group").value : "day";
}

function renderPricingInfo() {
  const target = $("pricing-info");
  if (!target) return;

  const pricing = state.dashboard?.pricing || {};

  target.innerHTML = `
    <b>Clave compartida extension</b><br>
    ${escapeHtml(state.sharedKey || "-")}<br><br>

    <b>Modelo sugerencias</b><br>
    ${escapeHtml(pricing.suggestions_model || "-")}<br>
    Input: ${escapeHtml(String(pricing.suggestion_input_cost_per_1m ?? "-"))} por 1M<br>
    Output: ${escapeHtml(String(pricing.suggestion_output_cost_per_1m ?? "-"))} por 1M<br><br>

    <b>Modelo traduccion</b><br>
    ${escapeHtml(pricing.translate_model || "-")}<br>
    Input: ${escapeHtml(String(pricing.translate_input_cost_per_1m ?? "-"))} por 1M<br>
    Output: ${escapeHtml(String(pricing.translate_output_cost_per_1m ?? "-"))} por 1M
  `;
}

function renderKpis() {
  const summary = state.dashboard?.summary || {};

  if (existeEl("kpi-total-requests")) {
    $("kpi-total-requests").textContent = formatNumber(summary.total_requests || 0);
  }

  if (existeEl("kpi-ia-requests")) {
    $("kpi-ia-requests").textContent = formatNumber(summary.ia_requests || 0);
  }

  if (existeEl("kpi-trad-requests")) {
    $("kpi-trad-requests").textContent = formatNumber(summary.trad_requests || 0);
  }

  if (existeEl("kpi-total-tokens")) {
    $("kpi-total-tokens").textContent = formatNumber(summary.total_tokens || 0);
  }

  if (existeEl("kpi-total-cost")) {
    $("kpi-total-cost").textContent = formatUsd(summary.estimated_cost_total || 0);
  }

  if (existeEl("kpi-total-warnings")) {
    $("kpi-total-warnings").textContent = formatNumber(summary.warnings_total || 0);
  }
}

function agruparSeries(series = [], mode = "day") {
  if (mode !== "month") {
    return series.map((row) => ({
      periodo: row.fecha || "-",
      requests_total: Number(row.requests_total || 0),
      ia_requests: Number(row.ia_requests || 0),
      trad_requests: Number(row.trad_requests || 0),
      total_tokens: Number(row.total_tokens || 0),
      estimated_cost_total: Number(row.estimated_cost_total || 0),
      warnings_total: Number(row.warnings_total || 0)
    }));
  }

  const map = new Map();

  for (const row of series) {
    const fecha = String(row.fecha || "");
    const periodo = fecha.slice(0, 7) || "-";

    if (!map.has(periodo)) {
      map.set(periodo, {
        periodo,
        requests_total: 0,
        ia_requests: 0,
        trad_requests: 0,
        total_tokens: 0,
        estimated_cost_total: 0,
        warnings_total: 0
      });
    }

    const item = map.get(periodo);
    item.requests_total += Number(row.requests_total || 0);
    item.ia_requests += Number(row.ia_requests || 0);
    item.trad_requests += Number(row.trad_requests || 0);
    item.total_tokens += Number(row.total_tokens || 0);
    item.estimated_cost_total += Number(row.estimated_cost_total || 0);
    item.warnings_total += Number(row.warnings_total || 0);
  }

  return Array.from(map.values()).sort((a, b) => a.periodo.localeCompare(b.periodo));
}

function renderSeriesTable() {
  const body = $("analytics-series-body");
  if (!body) return;

  const series = Array.isArray(state.dashboard?.series) ? state.dashboard.series : [];
  const mode = getAnalyticsGroupMode();
  const rows = agruparSeries(series, mode);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No hay datos para ese rango.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.periodo || "-")}</td>
      <td>${formatNumber(row.requests_total || 0)}</td>
      <td>${formatNumber(row.ia_requests || 0)}</td>
      <td>${formatNumber(row.trad_requests || 0)}</td>
      <td>${formatNumber(row.total_tokens || 0)}</td>
      <td>${formatUsd(row.estimated_cost_total || 0)}</td>
      <td>${formatNumber(row.warnings_total || 0)}</td>
    </tr>
  `).join("");
}

function renderWarningTable() {
  const body = $("analytics-warning-body");
  if (!body) return;

  const rows = Array.isArray(state.dashboard?.warning_top) ? state.dashboard.warning_top : [];

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">No hay warnings en este rango.</td></tr>`;
    return;
  }

  body.innerHTML = rows.slice(0, 100).map((row) => `
    <tr>
      <td><b>${escapeHtml(row.operador || "")}</b></td>
      <td>${escapeHtml(row.frase || "")}</td>
      <td>${formatNumber(row.total_count || 0)}</td>
      <td>${escapeHtml(row.last_date || "-")}</td>
    </tr>
  `).join("");
}

function renderOperatorAnalyticsTable() {
  const body = $("analytics-operators-body");
  if (!body) return;

  const rows = Array.isArray(state.dashboard?.operator_stats) ? state.dashboard.operator_stats : [];

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty">No hay consumo para ese rango.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map((row) => `
    <tr>
      <td><b>${escapeHtml(row.operador || "")}</b></td>
      <td>${formatNumber(row.requests_total || 0)}</td>
      <td>${formatNumber(row.ia_requests || 0)}</td>
      <td>${formatNumber(row.trad_requests || 0)}</td>
      <td>${formatNumber(row.prompt_tokens || 0)}</td>
      <td>${formatNumber(row.completion_tokens || 0)}</td>
      <td>${formatNumber(row.total_tokens || 0)}</td>
      <td>${formatUsd(row.estimated_cost_total || 0)}</td>
      <td>${formatNumber(row.warnings_total || 0)}</td>
      <td>${escapeHtml(formatDateTime(row.last_activity || ""))}</td>
    </tr>
  `).join("");
}

function renderDashboard() {
  renderPricingInfo();
  renderKpis();
  renderSeriesTable();
  renderWarningTable();
  renderOperatorAnalyticsTable();
}

async function loadDashboard() {
  const range = getAnalyticsRange();
  const params = new URLSearchParams();

  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);

  const data = await api(`/admin-api/dashboard?${params.toString()}`);
  state.dashboard = data || {
    generated_at: "",
    range: { from: "", to: "" },
    summary: {},
    operator_stats: [],
    warning_top: [],
    series: [],
    pricing: {}
  };

  renderDashboard();
}

// ==========================
// SESION
// ==========================
async function hydrateSession() {
  await loadHealth();
  initAnalyticsDates();

  if (!state.token) {
    setView(false);
    setAnalyticsEmptyState("Inicia sesion admin para ver datos.");
    return;
  }

  try {
    const data = await api("/admin-api/session");
    state.user = data.user || state.user || "admin";
    state.sharedKey = data.operator_shared_key || "";

    setView(true);
    renderSummary();

    const results = await Promise.allSettled([
      loadOperators(),
      loadDashboard(),
      loadHealth()
    ]);

    const dashboardError = results[1]?.status === "rejected" ? results[1].reason : null;
    if (dashboardError) {
      setAnalyticsEmptyState(dashboardError?.message || "No se pudo cargar analytics.");
      showFlash(dashboardError?.message || "No se pudo cargar analytics", "warning");
    }
  } catch (err) {
    clearSession();
    setView(false);
    setAnalyticsEmptyState("Tu sesion admin vencio.");
    showFlash(err.message || "Tu sesion admin vencio", "error");
  }
}

// ==========================
// LOGIN
// ==========================
async function onLoginSubmit(e) {
  e.preventDefault();

  const usuario = normalizarEspacios($("login-user").value);
  const password = $("login-password").value.trim();
  const btn = $("login-btn");

  if (!usuario || !password) {
    showFlash("Completa usuario y password admin", "warning");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";

  try {
    const data = await api("/admin-api/login", {
      method: "POST",
      body: JSON.stringify({ usuario, password })
    });

    setSession(data.token, data.user, data.operator_shared_key || "");
    $("login-password").value = "";

    setView(true);
    renderSummary();

    const results = await Promise.allSettled([
      loadOperators(),
      loadDashboard(),
      loadHealth()
    ]);

    const dashboardError = results[1]?.status === "rejected" ? results[1].reason : null;
    if (dashboardError) {
      setAnalyticsEmptyState(dashboardError?.message || "No se pudo cargar analytics.");
      showFlash(dashboardError?.message || "Sesion iniciada, pero fallo analytics", "warning");
      return;
    }

    showFlash("Sesion admin iniciada", "success");
  } catch (err) {
    showFlash(err.message || "No se pudo iniciar sesion", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar al panel";
  }
}

// ==========================
// CRUD ACCIONES
// ==========================
async function onCreateOperator(e) {
  e.preventDefault();

  const nombre = normalizarEspacios($("operator-name").value);
  const btn = $("create-btn");

  if (!nombre) {
    showFlash("Escribe el nombre del operador", "warning");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Guardando...";

  try {
    const data = await api("/admin-api/operators", {
      method: "POST",
      body: JSON.stringify({ nombre })
    });

    $("operator-name").value = "";

    const mapa = {
      created: "Operador creado",
      reactivated: "Operador reactivado",
      updated: "Operador actualizado",
      exists: "Ese operador ya existia"
    };

    showFlash(mapa[data.action] || "Operador guardado", "success");
    await loadOperators();
  } catch (err) {
    showFlash(err.message || "No se pudo guardar", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Crear operador";
  }
}

async function onBulkCreate(e) {
  e.preventDefault();

  const texto = $("bulk-names").value;
  const btn = $("bulk-btn");

  if (!normalizarEspacios(texto)) {
    showFlash("Pega uno o varios nombres primero", "warning");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const data = await api("/admin-api/operators/bulk", {
      method: "POST",
      body: JSON.stringify({ texto })
    });

    $("bulk-names").value = "";

    const result = data.result || {};
    const partes = [];

    if ((result.created || []).length) partes.push(`Creados: ${(result.created || []).length}`);
    if ((result.reactivated || []).length) partes.push(`Reactivados: ${(result.reactivated || []).length}`);
    if ((result.updated || []).length) partes.push(`Actualizados: ${(result.updated || []).length}`);
    if ((result.existing || []).length) partes.push(`Ya existian: ${(result.existing || []).length}`);
    if ((result.errors || []).length) partes.push(`Errores: ${(result.errors || []).length}`);

    state.operators = Array.isArray(data.operators) ? data.operators : [];
    state.summary = data.summary || state.summary;
    renderSummary();
    renderOperators();

    showFlash(
      partes.join(" · ") || "Alta masiva completada",
      (result.errors || []).length ? "warning" : "success"
    );
  } catch (err) {
    showFlash(err.message || "No se pudo procesar el alta masiva", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Procesar alta masiva";
  }
}

async function toggleOperator(id, activo) {
  await api(`/admin-api/operators/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ activo })
  });

  showFlash(
    activo ? "Operador activado" : "Operador desactivado",
    activo ? "success" : "warning"
  );

  await loadOperators();
}

async function deleteOperator(id, nombre = "") {
  await api(`/admin-api/operators/${id}`, {
    method: "DELETE"
  });

  showFlash(`Operador eliminado: ${nombre || id}`, "error");
  await loadOperators();
}

// ==========================
// ANALYTICS UI
// ==========================
async function aplicarFiltroAnalytics() {
  try {
    await loadDashboard();
    showFlash("Filtro aplicado", "success");
  } catch (err) {
    setAnalyticsEmptyState(err.message || "No se pudo cargar analytics.");
    showFlash(err.message || "No se pudo cargar analytics", "error");
  }
}

function aplicarRangoRapido(from, to) {
  if (existeEl("analytics-from")) $("analytics-from").value = from;
  if (existeEl("analytics-to")) $("analytics-to").value = to;
  void aplicarFiltroAnalytics();
}

// ==========================
// EVENTOS
// ==========================
function bindEvents() {
  $("login-form").addEventListener("submit", onLoginSubmit);
  $("create-form").addEventListener("submit", onCreateOperator);
  $("bulk-form").addEventListener("submit", onBulkCreate);

  $("logout-btn").addEventListener("click", () => {
    clearSession();
    setView(false);
    renderSummary();
    renderOperators();
    setAnalyticsEmptyState("Sesion admin cerrada.");
    showFlash("Sesion admin cerrada", "info");
  });

  $("refresh-btn").addEventListener("click", async () => {
    try {
      const results = await Promise.allSettled([
        loadHealth(),
        loadOperators(),
        loadDashboard()
      ]);

      const dashboardError = results[2]?.status === "rejected" ? results[2].reason : null;
      if (dashboardError) {
        setAnalyticsEmptyState(dashboardError?.message || "No se pudo cargar analytics.");
        showFlash(dashboardError?.message || "Panel actualizado con analytics incompleto", "warning");
        return;
      }

      showFlash("Panel actualizado", "success");
    } catch (err) {
      showFlash(err.message || "No se pudo actualizar", "error");
    }
  });

  $("search-input").addEventListener("input", renderOperators);
  $("status-filter").addEventListener("change", renderOperators);

  $("operators-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const id = Number.parseInt(btn.dataset.id, 10);
    const nombre = btn.dataset.name || "";

    if (!Number.isFinite(id) || id <= 0) {
      showFlash("ID de operador invalido", "error");
      return;
    }

    btn.disabled = true;

    try {
      if (action === "toggle") {
        const activo = btn.dataset.next === "true";
        await toggleOperator(id, activo);
      }

      if (action === "delete") {
        const ok = window.confirm(
          `Vas a eliminar a ${nombre || `ID ${id}`}. Esta accion es definitiva. ¿Continuar?`
        );

        if (!ok) return;
        await deleteOperator(id, nombre);
      }
    } catch (err) {
      showFlash(err.message || "No se pudo ejecutar la accion", "error");
    } finally {
      btn.disabled = false;
    }
  });

  if (existeEl("analytics-apply-btn")) {
    $("analytics-apply-btn").addEventListener("click", () => {
      void aplicarFiltroAnalytics();
    });
  }

  if (existeEl("analytics-group")) {
    $("analytics-group").addEventListener("change", () => {
      renderSeriesTable();
    });
  }

  if (existeEl("quick-today-btn")) {
    $("quick-today-btn").addEventListener("click", () => {
      const hoy = getTodayLocal();
      aplicarRangoRapido(hoy, hoy);
    });
  }

  if (existeEl("quick-7d-btn")) {
    $("quick-7d-btn").addEventListener("click", () => {
      aplicarRangoRapido(getStartOfLastNDays(7), getTodayLocal());
    });
  }

  if (existeEl("quick-month-btn")) {
    $("quick-month-btn").addEventListener("click", () => {
      aplicarRangoRapido(getFirstDayOfMonthLocal(), getTodayLocal());
    });
  }

  if (existeEl("quick-30d-btn")) {
    $("quick-30d-btn").addEventListener("click", () => {
      aplicarRangoRapido(getStartOfLastNDays(30), getTodayLocal());
    });
  }
}

bindEvents();
hydrateSession();
