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
  flashTimer: null
};

function $(id) {
  return document.getElementById(id);
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

function formatDate(value = "") {
  if (!value) return "-";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  return d.toLocaleString("es-ES", {
    dateStyle: "short",
    timeStyle: "short"
  });
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
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_USER_KEY);
}

function setView(logged) {
  $("login-view").classList.toggle("hidden", logged);
  $("app-view").classList.toggle("hidden", !logged);
}

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
        <td>${escapeHtml(formatDate(item.created_at))}</td>
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

async function hydrateSession() {
  await loadHealth();

  if (!state.token) {
    setView(false);
    return;
  }

  try {
    const data = await api("/admin-api/session");
    state.user = data.user || state.user || "admin";
    state.sharedKey = data.operator_shared_key || "";

    setView(true);
    renderSummary();
    await loadOperators();
  } catch (err) {
    clearSession();
    setView(false);
    showFlash(err.message || "Tu sesion admin vencio", "error");
  }
}

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
    await loadOperators();
    await loadHealth();
    showFlash("Sesion admin iniciada", "success");
  } catch (err) {
    showFlash(err.message || "No se pudo iniciar sesion", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar al panel";
  }
}

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

function bindEvents() {
  $("login-form").addEventListener("submit", onLoginSubmit);
  $("create-form").addEventListener("submit", onCreateOperator);
  $("bulk-form").addEventListener("submit", onBulkCreate);

  $("logout-btn").addEventListener("click", () => {
    clearSession();
    state.operators = [];
    state.summary = { total: 0, activos: 0, inactivos: 0 };
    setView(false);
    renderSummary();
    renderOperators();
    showFlash("Sesion admin cerrada", "info");
  });

  $("refresh-btn").addEventListener("click", async () => {
    try {
      await loadHealth();
      await loadOperators();
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
}

bindEvents();
hydrateSession();