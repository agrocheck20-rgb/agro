// Estado
const state = { user:null, profile:null, currentLotId:null, requiredDocs:[], docTypesCache:null, countriesCache:null, productsCache:null };

// Errores globales como toast
window.addEventListener("error", (e) => {
  console.error("Global error:", e.error || e.message);
  try { toast("Error JS: " + (e.error?.message || e.message), false); } catch {}
});

const PLANS = { BASICO:{quota:30}, PRO:{quota:200}, EMPRESA:{quota:1000} };

function $(s){return document.querySelector(s)}
function el(html){const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstElementChild}
function toast(msg, ok=true){ const t=el(`<div class="fixed top-4 right-4 bg-white border ${ok?'border-emerald-300 text-emerald-700':'border-rose-300 text-rose-700'} shadow-lg px-4 py-2 rounded-xl z-[9999]">${msg}</div>`); document.body.appendChild(t); setTimeout(()=>t.remove(), 3500); }
function setUsageBadge(){ const b=$("#usageBadge"); if(!state.profile){b.classList.add("hidden");return;} b.textContent=`IA: ${state.profile.ia_used}/${state.profile.ia_quota}`; b.classList.remove("hidden"); }

async function refreshSession(){
  const { data:{session}, error } = await sb.auth.getSession();
  if (error) console.warn("getSession error:", error);
  state.user = session?.user ?? null;
  if(state.user){
    await loadProfile();
    $("#authCard").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    $("#btnLogout").classList.remove("hidden");
    $("#btnLogin").classList.add("hidden");
    setUsageBadge();
    await bootstrapLookups();
    await loadLots();
  }else{
    $("#authCard").classList.remove("hidden");
    $("#dashboard").classList.add("hidden");
    $("#btnLogout").classList.add("hidden");
    $("#btnLogin").classList.remove("hidden");
  }
}

async function loadProfile(){
  const { data, error } = await sb.from("profiles").select("*").eq("id", state.user.id).single();
  if(error){ console.warn(error); toast("No se pudo cargar el perfil", false); return; }
  state.profile = data;
}

sb.auth.onAuthStateChange((event, session)=>{
  console.log("[Auth] onAuthStateChange:", event, session);
  state.user = session?.user ?? null;
  refreshSession();
});

// Diagnóstico simple de auth
(async ()=>{
  try{
    const diag = $("#authDiag");
    const ping = await sb.from("products").select("*").limit(1);
    diag.textContent = "[Diagnóstico] Conexión OK. products count test status: " + (ping.error ? ("error: "+ping.error.message) : "success");
  }catch(e){
    console.error(e);
  }
})();

// LOGIN
$("#loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error){ toast("Error al iniciar: " + error.message, false); return; }
  toast("Inicio correcto"); await refreshSession();
});

// SIGNUP (si no lo usas aún, lo dejamos funcional por si lo habilitas)
$("#signupForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const full_name = $("#signupName").value.trim();
  const email = $("#signupEmail").value.trim();
  const password = $("#signupPassword").value;
  const plan = document.querySelector("input[name='plan']:checked")?.value || "BASICO";
  const quota = PLANS[plan].quota;

  const { data, error } = await sb.auth.signUp({
    email, password, options:{ emailRedirectTo: window.location.origin }
  });
  if(error){ toast("Error al registrarte: " + error.message, false); return; }

  const { data: sessionData } = await sb.auth.getSession();
  if(!sessionData?.session){
    toast("Registro creado. Confirma tu correo o desactiva verificación en Supabase → Auth.", false);
    return;
  }
  const { data: u } = await sb.auth.getUser();
  if(u?.user){
    await sb.from("profiles").update({ full_name, plan, ia_quota: quota }).eq("id", u.user.id);
  }
  toast("Cuenta creada y perfil guardado"); await refreshSession();
});

$("#btnLogout").addEventListener("click", async ()=>{
  await sb.auth.signOut(); toast("Sesión cerrada"); await refreshSession();
});

// Lookups
async function bootstrapLookups(){
  if(!state.productsCache){ const {data}=await sb.from("products").select("*").order("name"); state.productsCache=data||[]; $("#lotProduct").innerHTML=state.productsCache.map(p=>`<option value="${p.name}">${p.name}</option>`).join(""); }
  if(!state.countriesCache){ const {data}=await sb.from("countries").select("*").order("name"); state.countriesCache=data||[]; $("#lotCountry").innerHTML=`<option value="">Selecciona</option>`+state.countriesCache.map(c=>`<option value="${c.code}">${c.name}</option>`).join(""); }
  if(!state.docTypesCache){ const {data}=await sb.from("required_docs").select("*").order("doc_type"); state.docTypesCache=data||[]; }
}

// Guardar lote
$("#lotForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!state.user) return toast("Inicia sesión", false);
  const product=$("#lotProduct").value, variety=$("#lotVariety").value.trim(), lot_code=$("#lotCode").value.trim();
  const origin_region=$("#lotRegion").value.trim(), origin_province=$("#lotProvince").value.trim(), destination_country=$("#lotCountry").value;
  const { data, error } = await sb.from("lots").insert({ user_id: state.user.id, product, variety, lot_code, origin_region, origin_province, destination_country }).select().single();
  if(error){ toast(error.message, false); return; }
  state.currentLotId = data.id; toast("Lote guardado"); await renderRequirements(); await loadLots();
});

$("#btnRefreshReqs").addEventListener("click", renderRequirements);

async function getRequiredDocs(product, country){
  let { data } = await sb.from("doc_requirements").select("doc_type, required").eq("product", product).eq("country_code", country);
  if(!data || data.length===0){
    const { data: def } = await sb.from("required_docs").select("*").eq("default_required", true);
    return (def||[]).map(d=>({doc_type:d.doc_type, required:true}));
  }
  return data;
}
async function renderRequirements(){
  const product=$("#lotProduct").value, country=$("#lotCountry").value;
  if(!product||!country){ toast("Completa producto y país", false); return; }
  const reqs = await getRequiredDocs(product, country); state.requiredDocs=reqs;
  const cont=$("#reqList"); cont.innerHTML="";
  for(const r of reqs){
    const rd=state.docTypesCache.find(d=>d.doc_type===r.doc_type); const label=rd?.label||r.doc_type;
    const card=el(`<div class="p-4 border rounded-xl">
      <p class="font-semibold">${label} ${r.required?'<span class="text-rose-600">*</span>':''}</p>
      <input type="file" class="mt-2 w-full" data-doc="${r.doc_type}" accept=".pdf,.jpg,.jpeg,.png" />
      <div class="text-xs text-slate-500 mt-2">Formatos: PDF/JPG/PNG</div>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-xs">Estado:</span>
        <select class="text-sm border rounded-lg px-2 py-1" data-doc-status="${r.doc_type}">
          <option value="pendiente">Pendiente</option>
          <option value="aprobado">Aprobado</option>
          <option value="observado">Observado</option>
        </select>
      </div>
    </div>`);
    cont.appendChild(card);
  }
  cont.querySelectorAll("input[type='file'][data-doc]").forEach(inp=>{
    inp.addEventListener("change", async (e)=>{
      const file=e.target.files?.[0]; if(!file) return;
      if(!state.currentLotId) return toast("Primero guarda el lote", false);
      const docType=e.target.getAttribute("data-doc");
      const path=`${state.user.id}/${state.currentLotId}/${docType}_${Date.now()}_${file.name}`;
      const { error } = await sb.storage.from("docs").upload(path, file, { upsert:true });
      if(error) return toast("Error subiendo documento: "+error.message, false);
      await sb.from("documents").insert({ user_id: state.user.id, lot_id: state.currentLotId, doc_type: docType, is_required: true, file_path: path });
      toast(`Documento ${docType} cargado`);
    });
  });
  $("#lotPhotos").addEventListener("change", async (e)=>{
    const files=Array.from(e.target.files||[]);
    if(!state.currentLotId) return toast("Primero guarda el lote", false);
    for(const f of files){
      const path=`${state.user.id}/${state.currentLotId}/photo_${Date.now()}_${f.name}`;
      const { error } = await sb.storage.from("photos").upload(path, f, { upsert:true });
      if(!error){ await sb.from("lot_photos").insert({ user_id: state.user.id, lot_id: state.currentLotId, file_path: path }); }
    }
    toast("Fotos cargadas");
  });
}

// Resultado + cuota IA
$("#btnSaveResult").addEventListener("click", async ()=>{
  if(!state.currentLotId) return toast("Guarda primero el lote", false);
  const val=$("#lotApproved").value; if(val==="") return toast("Indica si está aprobado", false);
  const approved=(val==="true"); const observations=$("#lotObs").value.trim();
  if((state.profile.ia_used+1)>state.profile.ia_quota) return toast("No te quedan usos de IA este mes", false);
  const status=approved?"aprobado":"rechazado";
  const { error:e1 } = await sb.from("lots").update({ approved, status, observations }).eq("id", state.currentLotId);
  if(e1) return toast("No se pudo guardar el resultado", false);
  const { error:e2 } = await sb.from("profiles").update({ ia_used: state.profile.ia_used+1 }).eq("id", state.user.id);
  if(e2) console.warn(e2);
  await loadProfile(); setUsageBadge();
  $("#btnPDF").classList.toggle("hidden", !approved);
  toast("Resultado guardado y uso de IA contabilizado"); await loadLots();
});

$("#btnPDF").addEventListener("click", async ()=>{
  const p=state.profile; const { data: lot } = await sb.from("lots").select("*").eq("id", state.currentLotId).single();
  if(!lot) return;
  const cert={ empresa:p?.full_name||p?.email||"Exportador", ruc:"—", producto: lot.product, variedad:lot.variety, lote:lot.lot_code, origen:`${lot.origin_region||"-"}, ${lot.origin_province||"-"}`, destino: lot.destination_country, fecha:new Date().toLocaleDateString(), estado:!!lot.approved, observaciones: lot.observations||"" };
  await window.generateCertificate(cert);
});

async function loadLots(){
  const wrap=$("#lotsTable"); const {data,error}=await sb.from("lots").select("*").order("created_at",{ascending:false});
  if(error){ wrap.textContent="Error cargando lotes"; return; }
  if(!data||data.length===0){ wrap.textContent="Sin lotes registrados"; return; }
  wrap.innerHTML = `<table class="min-w-full"><thead class="text-left bg-slate-50"><tr><th class="px-3 py-2">Fecha</th><th class="px-3 py-2">Producto</th><th class="px-3 py-2">Lote</th><th class="px-3 py-2">Destino</th><th class="px-3 py-2">Estado</th><th class="px-3 py-2"></th></tr></thead><tbody>${
    data.map(l=>`<tr><td class="px-3 py-2">${new Date(l.created_at).toLocaleString()}</td><td class="px-3 py-2">${l.product} ${l.variety?("("+l.variety+")"):""}</td><td class="px-3 py-2">${l.lot_code||"-"}</td><td class="px-3 py-2">${l.destination_country||"-"}</td><td class="px-3 py-2">${l.status}</td><td class="px-3 py-2"><button class="text-emerald-700 underline" data-open="${l.id}">Abrir</button></td></tr>`).join("")
  }</tbody></table>`;
  wrap.querySelectorAll("[data-open]").forEach(btn=>{
    btn.addEventListener("click", async (e)=>{
      state.currentLotId=e.target.getAttribute("data-open");
      const { data: l } = await sb.from("lots").select("*").eq("id", state.currentLotId).single();
      if(!l) return;
      $("#lotProduct").value=l.product; $("#lotVariety").value=l.variety||""; $("#lotCode").value=l.lot_code||""; $("#lotRegion").value=l.origin_region||""; $("#lotProvince").value=l.origin_province||""; $("#lotCountry").value=l.destination_country||"";
      $("#lotApproved").value= l.approved==null? "" : (l.approved? "true":"false"); $("#lotObs").value=l.observations||"";
      $("#btnPDF").classList.toggle("hidden", !l.approved);
      await renderRequirements(); window.scrollTo({top:0,behavior:"smooth"}); toast("Lote cargado");
    });
  });
}
$("#btnReloadLots").addEventListener("click", loadLots);

// Año
$("#year").textContent = new Date().getFullYear();
// Botón header
$("#btnLogin").addEventListener("click", ()=>{ document.getElementById("authCard").scrollIntoView({behavior:"smooth"}); });
// Start
refreshSession();
