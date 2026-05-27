"use strict";

const TOKEN_KEY = "ia_chat_admin_token_v33";
const USER_KEY = "ia_chat_admin_user_v33";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: localStorage.getItem(USER_KEY) || "",
  operators: [],
  dashboard: null,
  operatorFilter: "all",
  range: {
    from: "",
    to: ""
  }
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char];
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

function formatDateTime(value = "") {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString("es-ES", {
    dateStyle: "short",
    timeStyle: "medium"
  });
}

function formatDateInputLocal(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function getTodayLocal() {
  return formatDateInputLocal(new Date());
}

function getFirstDayOfMonthLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function getStartOfLastNDays(days = 7) {
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return formatDateInputLocal(date);
}

function showFlash(text = "") {
  const flash = $("flash");

  if (!flash) return;

  flash.textContent = text;
  flash.classList.add("show");

  setTimeout(() => {
    flash.classList.remove("show");
  }, 3000);
}

function setSession(token = "", user = "") {
  state.token = token || "";
  state.user = user || "";

  if (state.token) {
    localStorage.setItem(TOKEN_KEY, state.token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }

  if (state.user) {
    localStorage.setItem(USER_KEY, state.user);
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

function setView(logged) {
  $("login-view").classList.toggle("hidden", logged);
  $("app-view").classList.toggle("hidden", !logged);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  let data = null;

  try {
    data = await response.json();
  } catch (_error) {
    data = {
      ok: false,
      error: "Respuesta inválida del servidor"
    };
  }

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Error HTTP ${response.status}`);
  }

  return data;
}

async function login() {
  try {
    $("loginMsg").textContent = "Validando...";

    const username = $("adminUser").value.trim();
    const password = $("adminPass").value;

    const data = await api("/admin-api/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        password
      })
    });

    setSession(data.token, data.user);
    setView(true);

    $("sessionInfo").textContent = `Admin: ${data.user}`;
    $("loginMsg").textContent = "";

    initializeDefaultDates();
    ensureOperatorFilterUI();
    await loadAll();
  } catch (error) {
    $("loginMsg").textContent = error.message || "Credenciales inválidas.";
  }
}

function logout() {
  setSession("", "");
  state.operators = [];
  state.dashboard = null;
  state.operatorFilter = "all";
  setView(false);
}

async function checkSession() {
  if (!state.token) {
    setView(false);
    initializeDefaultDates();
    return;
  }

  try {
    const data = await api("/admin-api/session");

    setView(true);
    $("sessionInfo").textContent = `Admin: ${data.user}`;

    initializeDefaultDates();
    ensureOperatorFilterUI();
    await loadAll();
  } catch (_error) {
    logout();
  }
}

function initializeDefaultDates() {
  if (!$("dateFrom") || !$("dateTo")) return;

  if (!$("dateFrom").value) {
    $("dateFrom").value = getFirstDayOfMonthLocal();
  }

  if (!$("dateTo").value) {
    $("dateTo").value = getTodayLocal();
  }

  syncRangeFromInputs();
}

function syncRangeFromInputs() {
  state.range.from = $("dateFrom")?.value || getFirstDayOfMonthLocal();
  state.range.to = $("dateTo")?.value || getTodayLocal();
}

function ensureOperatorFilterUI() {
  if ($("operatorFilter")) return;

  const filterRow = document.querySelector(".filter-row");

  if (!filterRow) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <label for="operatorFilter">Operador</label>
    <select id="operatorFilter">
      <option value="all">Todos los operadores</option>
    </select>
  `;

  filterRow.insertBefore(wrapper, filterRow.children[2] || null);

  $("operatorFilter").addEventListener("change", () => {
    state.operatorFilter = $("operatorFilter").value || "all";

    if (state.dashboard) {
      renderDashboard(state.dashboard);
    }
  });
}

function updateOperatorFilterOptions() {
  ensureOperatorFilterUI();

  const select = $("operatorFilter");

  if (!select) return;

  const currentValue = state.operatorFilter || "all";
  const options = new Map();

  options.set("all", {
    value: "all",
    label: "Todos los operadores"
  });

  for (const operator of state.operators || []) {
    options.set(String(operator.id), {
      value: String(operator.id),
      label: `${operator.display_name || operator.username} (${operator.username})`
    });
  }

  for (const item of state.dashboard?.operator_stats || []) {
    const value = String(item.operator_id || item.operator_username || "");

    if (!value || options.has(value)) continue;

    options.set(value, {
      value,
      label: `${item.operator_label || value} (${item.operator_username || "legacy"})`
    });
  }

  select.innerHTML = Array.from(options.values()).map((item) => {
    return `
      <option value="${escapeHtml(item.value)}">
        ${escapeHtml(item.label)}
      </option>
    `;
  }).join("");

  if (options.has(currentValue)) {
    select.value = currentValue;
    state.operatorFilter = currentValue;
  } else {
    select.value = "all";
    state.operatorFilter = "all";
  }
}

function setTodayRange() {
  const today = getTodayLocal();

  $("dateFrom").value = today;
  $("dateTo").value = today;

  syncRangeFromInputs();
  loadDashboard().catch((error) => showFlash(error.message));
}

function setLast7Range() {
  $("dateFrom").value = getStartOfLastNDays(7);
  $("dateTo").value = getTodayLocal();

  syncRangeFromInputs();
  loadDashboard().catch((error) => showFlash(error.message));
}

function setThisMonthRange() {
  $("dateFrom").value = getFirstDayOfMonthLocal();
  $("dateTo").value = getTodayLocal();

  syncRangeFromInputs();
  loadDashboard().catch((error) => showFlash(error.message));
}

async function applyRange() {
  syncRangeFromInputs();
  await loadDashboard();
}

async function loadAll() {
  await Promise.all([
    loadOperators(),
    loadDashboard()
  ]);

  updateOperatorFilterOptions();

  if (state.dashboard) {
    renderDashboard(state.dashboard);
  }
}

async function loadOperators() {
  const data = await api("/admin-api/operators");

  state.operators = data.operators || [];

  renderOperators(data.summary || {});
  updateOperatorFilterOptions();
}

async function loadDashboard() {
  syncRangeFromInputs();

  const params = new URLSearchParams({
    from: state.range.from,
    to: state.range.to
  });

  const data = await api(`/admin-api/dashboard?${params.toString()}`);

  state.dashboard = data;

  updateOperatorFilterOptions();
  renderDashboard(data);
}

function findOperatorByFilter(value) {
  return (state.operators || []).find((operator) => {
    return (
      String(operator.id) === String(value) ||
      String(operator.username) === String(value) ||
      String(operator.display_name) === String(value)
    );
  });
}

function getFilteredOperatorStats(items = []) {
  if (state.operatorFilter === "all") return items;

  return items.filter((item) => {
    const operatorId = String(item.operator_id || "");
    const username = String(item.operator_username || item.username || "");
    const label = String(item.operator_label || item.display_name || "");

    return (
      operatorId === state.operatorFilter ||
      username === state.operatorFilter ||
      label === state.operatorFilter
    );
  });
}

function getFilteredWarnings(items = []) {
  if (state.operatorFilter === "all") return items;

  const selectedOperator = findOperatorByFilter(state.operatorFilter);

  return items.filter((item) => {
    const operatorId = String(item.operator_id || "");
    const username = String(item.operator_username || "");
    const label = String(item.operator_label || "");

    if (operatorId === state.operatorFilter) return true;
    if (username === state.operatorFilter) return true;
    if (label === state.operatorFilter) return true;

    if (selectedOperator) {
      if (username === selectedOperator.username) return true;
      if (label === selectedOperator.display_name) return true;
      if (operatorId === selectedOperator.id) return true;
    }

    return false;
  });
}

function getFilteredDailyOperatorSeries(items = []) {
  if (state.operatorFilter === "all") return items;

  const selectedOperator = findOperatorByFilter(state.operatorFilter);

  return items.filter((item) => {
    const operatorId = String(item.operator_id || "");
    const username = String(item.operator_username || "");
    const label = String(item.operator_label || "");

    if (operatorId === state.operatorFilter) return true;
    if (username === state.operatorFilter) return true;
    if (label === state.operatorFilter) return true;

    if (selectedOperator) {
      if (operatorId === selectedOperator.id) return true;
      if (username === selectedOperator.username) return true;
      if (label === selectedOperator.display_name) return true;
    }

    return false;
  });
}

function buildFilteredSummary(baseSummary, filteredStats, filteredWarnings) {
  if (state.operatorFilter === "all") return baseSummary;

  const summary = {
    requests_total: 0,
    correction_total: 0,
    translation_total: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    warnings_total: 0
  };

  for (const item of filteredStats) {
    summary.requests_total += Number(item.requests || 0);
    summary.correction_total += Number(item.corrections || 0);
    summary.translation_total += Number(item.translations || 0);
    summary.prompt_tokens += Number(item.prompt_tokens || 0);
    summary.completion_tokens += Number(item.completion_tokens || 0);
    summary.total_tokens += Number(item.total_tokens || 0);
    summary.estimated_cost_usd += Number(item.estimated_cost_usd || 0);
  }

  for (const item of filteredWarnings) {
    summary.warnings_total += Number(item.total || 0);
  }

  summary.estimated_cost_usd = Number(summary.estimated_cost_usd.toFixed(6));

  return summary;
}

function renderOperators(summary = {}) {
  const body = $("operatorsBody");

  if (!body) return;

  const operators = state.operators || [];

  if (!operators.length) {
    body.innerHTML = `
      <tr>
        <td colspan="5" class="muted">
          No hay operadores creados todavía.
        </td>
      </tr>
    `;
  } else {
    body.innerHTML = operators.map((operator) => {
      return `
        <tr>
          <td>
            <b>${escapeHtml(operator.username)}</b>
          </td>
          <td>${escapeHtml(operator.display_name || operator.username)}</td>
          <td>
            <span class="pill ${operator.status === "active" ? "ok" : "bad"}">
              ${escapeHtml(operator.status)}
            </span>
          </td>
          <td>${escapeHtml(formatDateTime(operator.last_login_at))}</td>
          <td>
            <button class="green" onclick="setStatus('${operator.id}', 'active')">Activar</button>
            <button class="yellow" onclick="setStatus('${operator.id}', 'inactive')">Inactivar</button>
            <button class="red" onclick="setStatus('${operator.id}', 'blocked')">Bloquear</button>
            <button class="gray" onclick="changePassword('${operator.id}')">Clave</button>
            <button class="red" onclick="deleteOperator('${operator.id}')">Eliminar</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  const summaryElement = $("operatorsSummary");

  if (summaryElement) {
    summaryElement.textContent = `Total: ${summary.total || operators.length} · Activos: ${summary.activos || 0} · Inactivos/bloqueados: ${summary.inactivos || 0}`;
  }
}

function renderDashboard(data) {
  const baseSummary = data.summary || {};
  const range = data.range || {};

  const filteredStats = getFilteredOperatorStats(data.operator_stats || []);
  const filteredWarnings = getFilteredWarnings(data.warning_top || []);
  const filteredDaily = getFilteredDailyOperatorSeries(data.daily_operator_series || []);

  const summary = buildFilteredSummary(baseSummary, filteredStats, filteredWarnings);

  $("rangeInfo").textContent = `Rango actual: ${range.from || "-"} → ${range.to || "-"} · Operador: ${getCurrentOperatorFilterLabel()}`;

  $("statRequests").textContent = formatNumber(summary.requests_total || 0);
  $("statCorrections").textContent = formatNumber(summary.correction_total || 0);
  $("statTranslations").textContent = formatNumber(summary.translation_total || 0);
  $("statWarnings").textContent = formatNumber(summary.warnings_total || 0);
  $("statCost").textContent = formatUsd(summary.estimated_cost_usd || 0);

  $("statInputTokens").textContent = formatNumber(summary.prompt_tokens || 0);
  $("statOutputTokens").textContent = formatNumber(summary.completion_tokens || 0);
  $("statTotalTokens").textContent = formatNumber(summary.total_tokens || 0);

  const pricing = data.pricing || {};

  $("statCostSub").textContent = `${pricing.model || "Gemini"} · input $${pricing.input_per_1m || 0}/1M · output $${pricing.output_per_1m || 0}/1M`;

  renderUsageTable(filteredStats);
  renderWarningsTable(filteredWarnings);
  renderDailyTable(state.operatorFilter === "all" ? data.daily_series || [] : filteredDaily);
}

function getCurrentOperatorFilterLabel() {
  if (state.operatorFilter === "all") return "Todos";

  const operator = findOperatorByFilter(state.operatorFilter);

  if (operator) {
    return `${operator.display_name || operator.username} (${operator.username})`;
  }

  const dashboardItem = (state.dashboard?.operator_stats || []).find((item) => {
    return String(item.operator_id || "") === String(state.operatorFilter);
  });

  if (dashboardItem) {
    return dashboardItem.operator_label || dashboardItem.operator_username || state.operatorFilter;
  }

  return state.operatorFilter;
}

function renderUsageTable(items = []) {
  const body = $("usageBody");

  if (!body) return;

  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="9" class="muted">
          No hay consumo para este operador en este rango.
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = items.map((item) => {
    const legacyClass = item.is_legacy ? "legacy" : "";

    return `
      <tr>
        <td>
          <b class="${legacyClass}">
            ${escapeHtml(item.operator_label || item.display_name || item.operator_id || "-")}
          </b>
          ${item.is_legacy ? `<div class="muted">Registro anterior al login real</div>` : ""}
        </td>
        <td>${escapeHtml(item.operator_username || item.username || "-")}</td>
        <td class="right">${formatNumber(item.requests || 0)}</td>
        <td class="right">${formatNumber(item.corrections || 0)}</td>
        <td class="right">${formatNumber(item.translations || 0)}</td>
        <td class="right">${formatNumber(item.prompt_tokens || 0)}</td>
        <td class="right">${formatNumber(item.completion_tokens || 0)}</td>
        <td class="right">${formatNumber(item.total_tokens || 0)}</td>
        <td class="right money">${formatUsd(item.estimated_cost_usd || 0)}</td>
      </tr>
    `;
  }).join("");
}

function renderWarningsTable(items = []) {
  const body = $("warningsBody");

  if (!body) return;

  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="4" class="muted">
          No hay warnings para este operador en este rango.
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = items.map((item) => {
    return `
      <tr>
        <td>
          <b>${escapeHtml(item.operator_label || "-")}</b>
        </td>
        <td>${escapeHtml(item.operator_username || "-")}</td>
        <td>${escapeHtml(item.phrase || item.warning_type || "-")}</td>
        <td class="right">${formatNumber(item.total || 0)}</td>
      </tr>
    `;
  }).join("");
}

function renderDailyTable(items = []) {
  const body = $("dailyBody");

  if (!body) return;

  if (!items.length) {
    body.innerHTML = `
      <tr>
        <td colspan="6" class="muted">
          No hay consumo diario en este rango.
        </td>
      </tr>
    `;
    return;
  }

  body.innerHTML = items.map((item) => {
    const operatorLabel =
      state.operatorFilter === "all"
        ? ""
        : `<div class="muted">${escapeHtml(item.operator_label || item.operator_username || "")}</div>`;

    return `
      <tr>
        <td>
          ${escapeHtml(item.day || "-")}
          ${operatorLabel}
        </td>
        <td class="right">${formatNumber(item.requests || 0)}</td>
        <td class="right">${formatNumber(item.corrections || 0)}</td>
        <td class="right">${formatNumber(item.translations || 0)}</td>
        <td class="right">${formatNumber(item.total_tokens || 0)}</td>
        <td class="right money">${formatUsd(item.estimated_cost_usd || 0)}</td>
      </tr>
    `;
  }).join("");
}

async function createOperator() {
  try {
    const username = $("opUsername").value.trim();
    const displayName = $("opDisplay").value.trim();
    const password = $("opPassword").value.trim();

    await api("/admin-api/operators", {
      method: "POST",
      body: JSON.stringify({
        username,
        display_name: displayName,
        password
      })
    });

    $("opUsername").value = "";
    $("opDisplay").value = "";
    $("opPassword").value = "";

    showFlash("Operador creado.");
    await loadOperators();
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "No se pudo crear operador.");
  }
}

async function bulkOperators() {
  try {
    const text = $("bulkText").value;
    const password = $("bulkPassword").value.trim();

    const data = await api("/admin-api/operators/bulk", {
      method: "POST",
      body: JSON.stringify({
        text,
        password
      })
    });

    showFlash(`Operadores procesados: ${data.created || 0}.`);
    await loadOperators();
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "No se pudieron crear operadores.");
  }
}

async function setStatus(id, status) {
  try {
    await api(`/admin-api/operators/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({
        status
      })
    });

    showFlash("Estado actualizado.");
    await loadOperators();
  } catch (error) {
    showFlash(error.message || "No se pudo actualizar estado.");
  }
}

async function changePassword(id) {
  const password = prompt("Nueva clave del operador:");

  if (!password) return;

  try {
    await api(`/admin-api/operators/${id}/password`, {
      method: "PATCH",
      body: JSON.stringify({
        password
      })
    });

    showFlash("Clave actualizada.");
  } catch (error) {
    showFlash(error.message || "No se pudo cambiar clave.");
  }
}

async function deleteOperator(id) {
  if (!confirm("¿Eliminar operador? Esta acción no elimina el historial de consumo.")) return;

  try {
    await api(`/admin-api/operators/${id}`, {
      method: "DELETE"
    });

    showFlash("Operador eliminado.");
    await loadOperators();
    await loadDashboard();
  } catch (error) {
    showFlash(error.message || "No se pudo eliminar operador.");
  }
}

function bindEvents() {
  $("btnAdminLogin").addEventListener("click", login);
  $("btnLogout").addEventListener("click", logout);
  $("btnRefresh").addEventListener("click", loadAll);

  $("btnCreateOperator").addEventListener("click", createOperator);
  $("btnBulk").addEventListener("click", bulkOperators);

  $("btnToday").addEventListener("click", setTodayRange);
  $("btnLast7").addEventListener("click", setLast7Range);
  $("btnThisMonth").addEventListener("click", setThisMonthRange);
  $("btnApplyRange").addEventListener("click", () => {
    applyRange().catch((error) => showFlash(error.message));
  });

  $("adminPass").addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });

  $("adminUser").addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
}

bindEvents();
checkSession();

window.setStatus = setStatus;
window.changePassword = changePassword;
window.deleteOperator = deleteOperator;
