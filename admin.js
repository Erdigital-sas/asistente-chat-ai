"use strict";

const TOKEN_KEY = "ia_chat_admin_token_v3";
const USER_KEY = "ia_chat_admin_user_v3";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: localStorage.getItem(USER_KEY) || ""
};

function $(id){return document.getElementById(id)}
function escapeHtml(v=""){return String(v).replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function n(v){return new Intl.NumberFormat("es-ES").format(Number(v||0))}
function dt(v){if(!v)return "-"; const d=new Date(v); return Number.isNaN(d.getTime())?v:d.toLocaleString("es-ES")}
function showFlash(text){const f=$("flash"); f.textContent=text; f.classList.add("show"); setTimeout(()=>f.classList.remove("show"),2600)}

function setSession(token,user){
  state.token=token||"";
  state.user=user||"";
  if(token)localStorage.setItem(TOKEN_KEY,token); else localStorage.removeItem(TOKEN_KEY);
  if(user)localStorage.setItem(USER_KEY,user); else localStorage.removeItem(USER_KEY);
}

function setView(logged){
  $("login-view").classList.toggle("hidden",logged);
  $("app-view").classList.toggle("hidden",!logged);
}

async function api(path, options={}){
  const headers={...(options.headers||{})};
  if(options.body && !headers["Content-Type"])headers["Content-Type"]="application/json";
  if(state.token)headers.Authorization=`Bearer ${state.token}`;

  const res=await fetch(path,{...options,headers});
  const data=await res.json().catch(()=>({ok:false,error:"Respuesta invalida"}));
  if(!res.ok || !data.ok)throw new Error(data.error||"Error servidor");
  return data;
}

async function login(){
  try{
    $("loginMsg").textContent="Validando...";
    const username=$("adminUser").value.trim();
    const password=$("adminPass").value;
    const data=await api("/admin-api/login",{method:"POST",body:JSON.stringify({username,password})});
    setSession(data.token,data.user);
    setView(true);
    $("sessionInfo").textContent=`Admin: ${data.user}`;
    await loadAll();
  }catch(e){
    $("loginMsg").textContent=e.message;
  }
}

function logout(){
  setSession("","");
  setView(false);
}

async function checkSession(){
  if(!state.token){
    setView(false);
    return;
  }
  try{
    const data=await api("/admin-api/session");
    setView(true);
    $("sessionInfo").textContent=`Admin: ${data.user}`;
    await loadAll();
  }catch(_e){
    logout();
  }
}

async function loadAll(){
  await Promise.all([loadOperators(),loadDashboard()]);
}

async function loadOperators(){
  const data=await api("/admin-api/operators");
  const rows=data.operators||[];
  $("operatorsBody").innerHTML=rows.map((op)=>`
    <tr>
      <td>${escapeHtml(op.username)}</td>
      <td>${escapeHtml(op.display_name)}</td>
      <td><span class="pill ${op.status==="active"?"ok":"bad"}">${escapeHtml(op.status)}</span></td>
      <td>${escapeHtml(dt(op.last_login_at))}</td>
      <td>
        <button onclick="setStatus('${op.id}','active')" class="green">Activar</button>
        <button onclick="setStatus('${op.id}','inactive')" class="yellow">Inactivar</button>
        <button onclick="setStatus('${op.id}','blocked')" class="red">Bloquear</button>
        <button onclick="changePassword('${op.id}')" class="gray">Clave</button>
        <button onclick="deleteOperator('${op.id}')" class="red">Eliminar</button>
      </td>
    </tr>
  `).join("");
}

async function loadDashboard(){
  const data=await api("/admin-api/dashboard");
  const s=data.summary||{};
  $("statRequests").textContent=n(s.requests_total);
  $("statCorrections").textContent=n(s.correction_total);
  $("statTranslations").textContent=n(s.translation_total);
  $("statWarnings").textContent=n(s.warnings_total);

  $("usageBody").innerHTML=(data.operator_stats||[]).map((x)=>`
    <tr>
      <td>${escapeHtml(x.operator_id)}</td>
      <td>${n(x.requests)}</td>
      <td>${n(x.corrections)}</td>
      <td>${n(x.translations)}</td>
      <td>${n(x.total_tokens)}</td>
    </tr>
  `).join("");

  $("warningsBody").innerHTML=(data.warning_top||[]).map((x)=>`
    <tr>
      <td>${escapeHtml(x.operator_username)}</td>
      <td>${escapeHtml(x.phrase)}</td>
      <td>${n(x.total)}</td>
    </tr>
  `).join("");
}

async function createOperator(){
  try{
    const username=$("opUsername").value.trim();
    const display_name=$("opDisplay").value.trim();
    const password=$("opPassword").value.trim();
    await api("/admin-api/operators",{method:"POST",body:JSON.stringify({username,display_name,password})});
    $("opUsername").value="";
    $("opDisplay").value="";
    $("opPassword").value="";
    showFlash("Operador creado");
    await loadOperators();
  }catch(e){showFlash(e.message)}
}

async function bulkOperators(){
  try{
    const text=$("bulkText").value;
    const password=$("bulkPassword").value.trim();
    const data=await api("/admin-api/operators/bulk",{method:"POST",body:JSON.stringify({text,password})});
    showFlash(`Operadores procesados: ${data.created}`);
    await loadOperators();
  }catch(e){showFlash(e.message)}
}

async function setStatus(id,status){
  try{
    await api(`/admin-api/operators/${id}/status`,{method:"PATCH",body:JSON.stringify({status})});
    showFlash("Estado actualizado");
    await loadOperators();
  }catch(e){showFlash(e.message)}
}

async function changePassword(id){
  const password=prompt("Nueva clave del operador:");
  if(!password)return;
  try{
    await api(`/admin-api/operators/${id}/password`,{method:"PATCH",body:JSON.stringify({password})});
    showFlash("Clave actualizada");
  }catch(e){showFlash(e.message)}
}

async function deleteOperator(id){
  if(!confirm("Eliminar operador?"))return;
  try{
    await api(`/admin-api/operators/${id}`,{method:"DELETE"});
    showFlash("Operador eliminado");
    await loadOperators();
  }catch(e){showFlash(e.message)}
}

$("btnAdminLogin").addEventListener("click",login);
$("btnLogout").addEventListener("click",logout);
$("btnRefresh").addEventListener("click",loadAll);
$("btnCreateOperator").addEventListener("click",createOperator);
$("btnBulk").addEventListener("click",bulkOperators);

checkSession();
