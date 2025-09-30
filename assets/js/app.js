// ===== Estado + helpers
const state = {
  user:null, profile:null,
  currentLotId:null,
  requiredDocs:[], docTypesCache:null, countriesCache:null, productsCache:null,
  lotsCache:[]
};

function $(s){return document.querySelector(s)}
function el(h){const d=document.createElement("div"); d.innerHTML=h.trim(); return d.firstElementChild}
function toast(m,ok=true){const t=el(`<div class="fixed top-4 right-4 bg-white border ${ok?'border-emerald-300 text-emerald-700':'border-rose-300 text-rose-700'} shadow-lg px-4 py-2 rounded-xl z-[9999]">${m}</div>`); document.body.appendChild(t); setTimeout(()=>t.remove(),3500);}

// ===== Navegación
const views=["dashboard","validate","lots","account","help"];
function showView(name){
  for(const v of views){ const sec=$("#view-"+v); if(!sec) continue; sec.classList.toggle("hidden", v!==name); }
  document.querySelectorAll("[data-nav]").forEach(b=>b.classList.remove("bg-slate-100","border","border-slate-200"));
  const active = document.querySelector(`[data-nav='${name}']`); if(active) active.classList.add("bg-slate-100","border","border-slate-200");
}
document.querySelectorAll("[data-nav]").forEach(b=>b.addEventListener("click", ()=>showView(b.getAttribute("data-nav"))));
$("#btnMobileMenu").addEventListener("click", ()=>{ $("#sidebar").classList.toggle("hidden"); });

// ===== Supabase
const sb = window.sb;

function setUsageBadges(){
  const badge=$("#usageBadge"), top=$("#topUsage");
  if(!state.profile){ badge?.classList.add("hidden"); top?.classList.add("hidden"); return; }
  const t=`IA: ${state.profile.ia_used}/${state.profile.ia_quota}`;
  if(badge){ badge.textContent=t; badge.classList.remove("hidden"); }
  if(top){ top.textContent=t; top.classList.remove("hidden"); }
}

async function refreshSession(){
  const { data:{session} } = await sb.auth.getSession();
  state.user = session?.user ?? null;
  if(state.user){
    await loadProfile();
    $("#authCard").classList.add("hidden");
    $("#sidebar").classList.remove("hidden");
    setUsageBadges();
    await bootstrapLookups();
    await loadLots();
    await renderDashboard();
    showView("dashboard");
  }else{
    $("#authCard").classList.remove("hidden");
    $("#sidebar").classList.add("hidden");
  }
}

async function loadProfile(){
  const { data, error } = await sb.from("profiles").select("*").eq("id", state.user.id).single();
  if(error){ toast("No se pudo cargar el perfil", false); return; }
  state.profile=data;

  // Mi cuenta
  $("#accName").textContent=data.full_name||"—";
  $("#accEmail").textContent=data.email||"—";
  $("#accPlan").textContent=data.plan || "—";
  const expires = data.plan_expires_at ? new Date(data.plan_expires_at) : null;
  if(expires){
    const days = Math.max(0, Math.ceil((expires - new Date())/86400000));
    $("#accExpiry").textContent = expires.toLocaleDateString() + ` (${days} días restantes)`;
  } else { $("#accExpiry").textContent = "—"; }
  $("#accUsage").textContent = `${data.ia_used} / ${data.ia_quota}`;
}

sb.auth.onAuthStateChange((ev,session)=>{ state.user=session?.user??null; refreshSession(); });

// Diagnóstico simple
(async()=>{
  const diag=$("#authDiag");
  try{
    const ping=await sb.from("products").select("*").limit(1);
    diag.textContent="[Diagnóstico] "+(ping.error?("error: "+ping.error.message):"Conexión OK");
  }catch(e){ diag.textContent="[Diagnóstico] error general"; }
})();

// ===== Login
$("#loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email=$("#loginEmail").value.trim();
  const password=$("#loginPassword").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if(error) return toast("Error al iniciar: "+error.message, false);
  toast("Inicio correcto"); await refreshSession();
});
$("#btnLogout").addEventListener("click", async ()=>{ await sb.auth.signOut(); toast("Sesión cerrada"); await refreshSession(); });

// ===== Lookups
async function bootstrapLookups(){
  if(!state.productsCache){ const {data}=await sb.from("products").select("*").order("name"); state.productsCache=data||[]; $("#lotProduct").innerHTML=state.productsCache.map(p=>`<option value="${p.name}">${p.name}</option>`).join(""); }
  if(!state.countriesCache){ const {data}=await sb.from("countries").select("*").order("name"); state.countriesCache=data||[]; $("#lotCountry").innerHTML=`<option value="">Selecciona</option>`+state.countriesCache.map(c=>`<option value="${c.code}">${c.name}</option>`).join(""); }
  if(!state.docTypesCache){ const {data}=await sb.from("required_docs").select("*").order("doc_type"); state.docTypesCache=data||[]; }
}

// ===== Lotes
async function loadLots(){
  const wrap=$("#lotsTable");
  const { data, error } = await sb.from("lots").select("*").order("created_at",{ascending:false});
  if(error){ wrap.textContent="Error cargando lotes"; return; }
  state.lotsCache = data || [];
  // cargar selector para Validación IA
  const sel = $("#selectLotPicker");
  if (sel){
    sel.innerHTML = '<option value="">— Elegir lote existente —</option>' +
      state.lotsCache.map(l=>`<option value="${l.id}">${l.lot_code || l.id} — ${l.product} → ${l.destination_country||'-'} (${l.status||'pendiente'})</option>`).join("");
  }
  renderLotsTable();
}

function renderLotsTable(){
  const wrap=$("#lotsTable");
  const q=$("#filterText")?.value.trim().toLowerCase() || "";
  const st=$("#filterState")?.value || "";

  let rows = state.lotsCache || [];
  if(st) rows = rows.filter(l => (l.status||"pendiente") === st);
  if(q) rows = rows.filter(l => (l.lot_code||"").toLowerCase().includes(q) || (l.variety||"").toLowerCase().includes(q));

  if(rows.length===0){ wrap.textContent="Sin lotes (o filtro sin resultados)"; return; }
  wrap.innerHTML = `<table class="min-w-full">
    <thead class="text-left bg-slate-50">
      <tr>
        <th class="px-3 py-2">Fecha</th>
        <th class="px-3 py-2">Producto</th>
        <th class="px-3 py-2">Lote</th>
        <th class="px-3 py-2">Destino</th>
        <th class="px-3 py-2">Estado</th>
        <th class="px-3 py-2">Acciones</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(l=>`<tr>
        <td class="px-3 py-2">${new Date(l.created_at).toLocaleString()}</td>
        <td class="px-3 py-2">${l.product} ${l.variety?("("+l.variety+")"):""}</td>
        <td class="px-3 py-2">${l.lot_code||"-"}</td>
        <td class="px-3 py-2">${l.destination_country||"-"}</td>
        <td class="px-3 py-2">${l.status||"pendiente"}</td>
        <td class="px-3 py-2 flex gap-2">
          <button class="px-2 py-1 border rounded-lg text-xs" data-open="${l.id}">Validación IA</button>
          <button class="px-2 py-1 border rounded-lg text-xs" data-pdf="${l.id}" ${l.certificate_path? "" : "disabled"}>Descargar PDF</button>
        </td>
      </tr>`).join("")}
    </tbody>
  </table>`;

  wrap.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click", async (e)=>{
    state.currentLotId=e.target.getAttribute("data-open");
    await loadLotIntoForm(state.currentLotId);
    showView("validate");
    window.scrollTo({top:0,behavior:"smooth"});
  }));

  wrap.querySelectorAll("[data-pdf]").forEach(b=>b.addEventListener("click", async (e)=>{
    const lotId=e.target.getAttribute("data-pdf");
    const lot = state.lotsCache.find(x=>x.id===lotId);
    if(!lot || !lot.certificate_path) return;
    await downloadCertificateFromStorage(lot.certificate_path);
  }));
}
$("#btnReloadLots")?.addEventListener("click", loadLots);
$("#filterText")?.addEventListener("input", renderLotsTable);
$("#filterState")?.addEventListener("change", renderLotsTable);

// Buscar global por código en topbar
$("#globalSearch")?.addEventListener("keydown", async (e)=>{
  if(e.key!=="Enter") return;
  const code = e.target.value.trim();
  if(!code) return;
  const hit = state.lotsCache.find(l => (l.lot_code||"").toLowerCase() === code.toLowerCase());
  if(hit){
    state.currentLotId = hit.id;
    await loadLotIntoForm(hit.id);
    showView("validate");
  }else{
    toast("No se encontró el lote", false);
  }
});

// Cargar un lote en el formulario de Validación IA
async function loadLotIntoForm(lotId){
  const { data: l, error } = await sb.from("lots").select("*").eq("id", lotId).single();
  if(error || !l) return;
  $("#lotProduct").value=l.product;
  $("#lotVariety").value=l.variety||"";
  $("#lotCode").value=l.lot_code||"";
  $("#lotRegion").value=l.origin_region||"";
  $("#lotProvince").value=l.origin_province||"";
  $("#lotCountry").value=l.destination_country||"";
  $("#lotApproved").value= l.approved==null? "" : (l.approved? "true":"false");
  $("#lotObs").value=l.observations||"";
  $("#btnPDF").classList.toggle("hidden", !l.certificate_path);
  await renderRequirements();
}

// ===== Validación IA

// Elegir lote existente desde el selector
$("#btnPickLot")?.addEventListener("click", async ()=>{
  const lotId = $("#selectLotPicker").value;
  if(!lotId) return toast("Elige un lote de la lista", false);
  state.currentLotId = lotId;
  await loadLotIntoForm(lotId);
  toast("Lote cargado");
});

// Guardar / crear lote (si no existe aún)
$("#lotForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!state.user) return toast("Inicia sesión", false);
  const product=$("#lotProduct").value, variety=$("#lotVariety").value.trim(), lot_code=$("#lotCode").value.trim();
  const origin_region=$("#lotRegion").value.trim(), origin_province=$("#lotProvince").value.trim(), destination_country=$("#lotCountry").value;

  if(state.currentLotId){
    const { error } = await sb.from("lots").update(
      { product, variety, lot_code, origin_region, origin_province, destination_country }
    ).eq("id", state.currentLotId);
    if(error) return toast("No se pudo actualizar el lote", false);
    toast("Lote actualizado");
  }else{
    const { data, error } = await sb.from("lots").insert({
      user_id: state.user.id, product, variety, lot_code, origin_region, origin_province, destination_country
    }).select().single();
    if(error) return toast(error.message, false);
    state.currentLotId=data.id;
    toast("Lote creado");
  }
  await renderRequirements(); await loadLots();
});

$("#btnRefreshReqs").addEventListener("click", renderRequirements);

async function getRequiredDocs(product, country){
  let { data } = await sb.from("doc_requirements").select("doc_type, required").eq("product", product).eq("country_code", country);
  if(!data || data.length===0){
    const { data: def } = await sb.from("required_docs").select("*").eq("default_required", true);
    return (def||[]).map(d=>({ doc_type:d.doc_type, required:true }));
  }
  return data;
}

async function renderRequirements(){
  const product=$("#lotProduct").value, country=$("#lotCountry").value;
  if(!product||!country) return; // espera a que esté completo
  const reqs=await getRequiredDocs(product, country); state.requiredDocs=reqs;
  const cont=$("#reqList"); cont.innerHTML="";
  for(const r of reqs){
    const rd=state.docTypesCache.find(d=>d.doc_type===r.doc_type); const label=rd?.label||r.doc_type;
    const card=el(`<div class="p-4 border rounded-xl bg-white">
      <p class="font-semibold">${label} ${r.required?'<span class="text-rose-600">*</span>':''}</p>
      <input type="file" class="mt-2 w-full" data-doc="${r.doc_type}" accept=".pdf,.jpg,.jpeg,.png" />
      <div class="text-xs text-slate-500 mt-2">Formatos: PDF/JPG/PNG</div>
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
      await sb.from("documents").insert({ user_id: state.user.id, lot_id: state.currentLotId, doc_type: docType, is_required:true, file_path:path });
      await sb.from("lot_events").insert({ user_id: state.user.id, lot_id: state.currentLotId, event_type:'doc_uploaded', data: {doc_type: docType, path} });
      toast(`Documento ${docType} cargado`);
    });
  });

  $("#lotPhotos").addEventListener("change", async (e)=>{
    const files=Array.from(e.target.files||[]);
    if(!state.currentLotId) return toast("Primero guarda el lote", false);
    for(const f of files){
      const path=`${state.user.id}/${state.currentLotId}/photo_${Date.now()}_${f.name}`;
      const { error } = await sb.storage.from("photos").upload(path, f, { upsert:true });
      if(!error){
        await sb.from("lot_photos").insert({ user_id: state.user.id, lot_id: state.currentLotId, file_path: path });
      }
    }
    toast("Fotos cargadas");
  });
}

// Guardar resultado + generar y subir PDF si aprobado
$("#btnSaveResult").addEventListener("click", async ()=>{
  if(!state.currentLotId) return toast("Guarda primero el lote", false);
  const val=$("#lotApproved").value; if(val==="") return toast("Indica si está aprobado", false);
  const approved=(val==="true"); const observations=$("#lotObs").value.trim();

  // Verifica cuota IA: sólo si marcamos AI usada (aquí siempre cuenta 1)
  if((state.profile.ia_used + 1) > state.profile.ia_quota) return toast("No te quedan usos de IA este mes", false);

  const status=approved?"aprobado":"rechazado";
  let certificate_path = null;
  let certificate_number = null;

  // Si aprobado => generar PDF, subir a Storage, y obtener número
  if(approved){
    // Buscar el lote para obtener info actual (y certificate_number si ya existe)
    let { data: lot } = await sb.from("lots").select("*").eq("id", state.currentLotId).single();
    // Armar datos del certificado
    const cert = {
      certificate_number: lot?.certificate_number || "—",
      empresa: state.profile?.full_name || state.profile?.email || "Exportador",
      ruc: "—",
      producto: $("#lotProduct").value,
      variedad: $("#lotVariety").value,
      lote: $("#lotCode").value,
      origen: `${$("#lotRegion").value || "-"}, ${$("#lotProvince").value || "-"}`,
      destino: $("#lotCountry").value,
      fecha: new Date().toLocaleDateString(),
      estado: true,
      observaciones: observations || ""
    };
    // Generar blob con jsPDF
    const blob = await window.generateCertificateBlob(cert);
    const path = `${state.user.id}/${state.currentLotId}/cert_${Date.now()}.pdf`;
    const { error: upErr } = await sb.storage.from("certs").upload(path, blob, { upsert:true, contentType:"application/pdf" });
    if(upErr) return toast("No se pudo subir el certificado: "+upErr.message, false);
    certificate_path = path;
  }

  // Actualizar lote (incluye certificate_path si existe)
  const patch = { approved, status, observations };
  if (certificate_path) {
    patch.certificate_path = certificate_path;
    patch.validated_at = new Date().toISOString();
    patch.reviewed_by = state.user.id;
  }
  const { error: e1, data: updated } = await sb.from("lots").update(patch).eq("id", state.currentLotId).select().single();
  if(e1) return toast("No se pudo guardar el resultado", false);

  // Si recién aprobaste y el lote aún no tenía certificate_number, ya lo tendrá (por bigserial), refrescamos para el PDF inline
  certificate_number = updated?.certificate_number;

  // Contar uso IA
  const { error: e2 } = await sb.from("profiles").update({ ia_used: state.profile.ia_used + 1 }).eq("id", state.user.id);
  if(e2) console.warn(e2);

  // Eventos
  await sb.from("lot_events").insert({ user_id: state.user.id, lot_id: state.currentLotId, event_type: approved?'approved':'rejected', data:{observations} });
  if (certificate_path) {
    await sb.from("lot_events").insert({ user_id: state.user.id, lot_id: state.currentLotId, event_type:'pdf_generated', data:{certificate_path} });
  }

  await loadProfile();
  setUsageBadges();
  $("#btnPDF").classList.toggle("hidden", !certificate_path);
  toast(approved ? "Aprobado, certificado generado" : "Resultado guardado");
  await loadLots();
  await renderDashboard();
});

// Botón PDF inline en Validación IA
$("#btnPDF").addEventListener("click", async ()=>{
  // Descarga el PDF almacenado si existe
  const { data: lot } = await sb.from("lots").select("*").eq("id", state.currentLotId).single();
  if(!lot?.certificate_path) return toast("No hay certificado aún", false);
  await downloadCertificateFromStorage(lot.certificate_path);
});

// Descarga del PDF desde Storage (signed URL)
async function downloadCertificateFromStorage(path){
  const { data, error } = await sb.storage.from("certs").createSignedUrl(path, 60); // 60s
  if(error) return toast("No se pudo obtener el enlace del certificado", false);
  window.open(data.signedUrl, "_blank");
}

// ===== Dashboard
async function renderDashboard(){
  const lots = state.lotsCache?.length ? state.lotsCache : (await sb.from("lots").select("*")).data || [];
  const total = lots.length;
  const approved = lots.filter(l=>l.status==='aprobado').length;
  const pending = lots.filter(l=>l.status==='pendiente' || (!l.status)).length;
  const rejected = lots.filter(l=>l.status==='rechazado').length;
  $("#statTotal").textContent=total; $("#statApproved").textContent=approved; $("#statPending").textContent=pending; $("#statRejected").textContent=rejected;

  const ctx=document.getElementById("chartStatus");
  if(ctx){
    if(window._statusChart) window._statusChart.destroy();
    window._statusChart=new Chart(ctx,{ type:"doughnut", data:{ labels:["Aprobados","Pendientes","Rechazados"], datasets:[{ data:[approved,pending,rejected] }] }, options:{ plugins:{legend:{position:"bottom"}} } });
  }
  const used=state.profile?.ia_used||0, quota=state.profile?.ia_quota||0; const pct = quota? Math.min(100, Math.round(used*100/quota)):0;
  $("#usageBar").style.width=pct+"%"; $("#usageText").textContent = `${used} / ${quota} (${pct}%)`;
}

// ===== Mi cuenta
$("#btnUpdateProfile").addEventListener("click", async ()=>{
  const newName = prompt("Nombre/Empresa", state.profile?.full_name||"");
  if(newName==null) return;
  const { error } = await sb.from("profiles").update({ full_name:newName }).eq("id", state.user.id);
  if(error) return toast("No se pudo actualizar", false);
  await loadProfile(); toast("Perfil actualizado");
});

// ===== Filtros/acciones menores
$("#btnLogin").addEventListener("click", ()=>{ document.getElementById("authCard").scrollIntoView({behavior:"smooth"}); });

// Start
refreshSession();
