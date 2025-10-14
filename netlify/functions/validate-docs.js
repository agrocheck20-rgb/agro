// netlify/functions/validate-docs.js
// Versión exprés anti-timeout (Netlify). Procesa 1 archivo por tipo y no genera PDF en el server.

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

async function fetchArrayBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo descargar archivo (${r.status})`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- Schema para Structured Outputs ----------
const validationSchema = {
  name: "DocMinExtract",
  schema: {
    type: "object",
    properties: {
      per_doc: {
        type: "array",
        items: {
          type: "object",
          properties: {
            doc_type: { type: "string", enum: ["CERT_ORIGEN", "FACTURA", "PACKING_LIST"] },
            extracted: {
              type: "object",
              properties: {
                hs_code:            { type: ["string","null"] },
                origin_country:     { type: ["string","null"] },
                invoice_number:     { type: ["string","null"] },
                goods_description:  { type: ["string","null"] },
                consignee_name:      { type: ["string","null"] },
                total_invoice_value: { type: ["number","string","null"] },
                items_found:         { type: ["number","null"] },
                packing_number:   { type: ["string","null"] },
                packing_date:     { type: ["string","null"] },
                packages_count:   { type: ["number","string","null"] },
                net_weight_total: { type: ["number","string","null"] }
              },
              required: [
                "hs_code","origin_country","invoice_number","goods_description",
                "consignee_name","total_invoice_value","items_found",
                "packing_number","packing_date","packages_count","net_weight_total"
              ],
              additionalProperties: false
            }
          },
          required: ["doc_type","extracted"],
          additionalProperties: false
        }
      }
    },
    required: ["per_doc"],
    additionalProperties: false
  }
};

const SYSTEM_PROMPT = `
Eres un verificador de documentación de exportación. Responde SIEMPRE en español.
Lee los documentos adjuntos (PDF o imágenes) y EXTRAe SOLO estos campos por documento:

CERT_ORIGEN:
  - hs_code (6+ dígitos limpios, ej: 080440)
  - origin_country (esperado "PE")
  - invoice_number
  - goods_description

FACTURA:
  - invoice_number
  - consignee_name
  - total_invoice_value (número o string numérico)
  - items_found (entero: cantidad de renglones de ítems)

PACKING_LIST:
  - packing_number
  - packing_date
  - packages_count (número/string numérico)
  - net_weight_total (número/string numérico)

Si un valor no existe en el documento, pon null. NO inventes.
Devuelve SOLO JSON conforme al schema.`;

// ---------- Validaciones mínimas ----------
function hasText(v){ return v!=null && String(v).trim().length>0; }
function toNum(v){
  if (v==null) return null;
  const t = String(v).replace(/[^\d.,-]/g,"");
  const n1 = Number(t.replace(/\./g,"").replace(",","."));
  if (!Number.isNaN(n1)) return n1;
  const n2 = Number(t.replace(/,/g,""));
  return Number.isNaN(n2) ? null : n2;
}
function normHS(s){
  if(!s) return "";
  const d = String(s).replace(/\D/g,"");
  return d.length>=6 ? d.slice(0,8) : d;
}
function normPE(s){
  if(!s) return "";
  const v = String(s).toLowerCase();
  if (v.includes("peru") || v.includes("perú") || v==="pe" || v.includes("pe (")) return "PE";
  return String(s).toUpperCase();
}

exports.handler = async (event) => {
  const start = Date.now();
  try {
    // ESM dinámicos
    const { default: OpenAI } = await import("openai");
    const { createClient } = await import("@supabase/supabase-js");
    const { toFile } = await import("openai/uploads");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supa   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    const qs = event.queryStringParameters || {};
    const body = event.httpMethod === "POST" && event.body ? JSON.parse(event.body) : {};
    const lotId = qs.lot_id || body.lot_id || null;
    if (!lotId) return json(400, { error: "Falta lot_id" });

    // 1) Lote + perfil
    const { data: lot, error: eLot } = await supa.from("lots").select("*").eq("id", lotId).single();
    if (eLot || !lot) return json(404, { error: "Lote no encontrado" });

    const { data: profile } = await supa.from("profiles").select("*").eq("id", lot.user_id).single();

    // 2) Requisitos (solo 3 tipos)
    let reqs = [
      { doc_type: "CERT_ORIGEN", required: true },
      { doc_type: "FACTURA", required: true },
      { doc_type: "PACKING_LIST", required: true }
    ];

    // 3) Documentos del lote (solo 1 archivo por tipo para evitar timeout)
    const { data: docs } = await supa.from("documents").select("*").eq("lot_id", lotId);
    const byType = {};
    for (const d of (docs || [])) {
      if (!byType[d.doc_type]) byType[d.doc_type] = [];
      byType[d.doc_type].push(d);
    }

    // 4) Evidencias: 1 archivo por tipo (imagen => input_image, PDF => input_file purpose:"vision")
    const perDocInputs = [];
    for (const r of reqs) {
      const t = r.doc_type;
      const list = (byType[t] || []).slice(0,1); // <- SOLO 1
      const inputs = [];
      for (const row of list) {
        const ext = (row.file_path || "").toLowerCase().split(".").pop();
        const { data: signed } = await supa.storage.from("docs").createSignedUrl(row.file_path, 300);
        if (!signed?.signedUrl) continue;

        if (["jpg","jpeg","png","webp","gif"].includes(ext)) {
          inputs.push({ type: "input_image", image_url: signed.signedUrl });
        } else {
          // PDF u otros -> input_file con purpose:"vision"
          const buf  = await fetchArrayBuffer(signed.signedUrl);
          const name = row.file_path.split("/").pop() || "doc.bin";
          const mime = (ext === "pdf") ? "application/pdf" : "application/octet-stream";
          const file = await toFile(buf, name, { type: mime });
          const up   = await openai.files.create({ file, purpose: "vision" });
          inputs.push({ type: "input_file", file_id: up.id });
        }
      }
      perDocInputs.push({ doc_type: t, inputs });
    }

    // 5) Build input para OpenAI (ligero)
    const context = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        destination_country: lot.destination_country
      },
      // pasamos solo los nombres de archivo para ayudar al LLM a saber qué recibió
      files: perDocInputs.map(b => ({
        doc_type: b.doc_type,
        count: b.inputs.length
      }))
    };

    const userContent = [{
      type: "input_text",
      text: `Contexto:\n${JSON.stringify(context)}\nAhora extrae los 4 campos por documento según el SYSTEM_PROMPT.`
    }];
    for (const block of perDocInputs) {
      if (!block.inputs.length) continue;
      userContent.push({ type: "input_text", text: `Documento: ${block.doc_type}`});
      for (const inp of block.inputs) userContent.push(inp);
    }

    // 6) Llamada a OpenAI con timeout suave (22s) para esquivar 504
    const callLLM = openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
        { role: "user",   content: userContent }
      ],
      text: { format: { type: "json_schema", name: validationSchema.name, schema: validationSchema.schema, strict: true } }
    });

    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Tiempo de extracción excedido (intenta con archivos más livianos o 1 archivo por tipo).")), 22000)
    );

    let parsed = { per_doc: [] };
    const response = await Promise.race([callLLM, timeout]);
    const raw = response.output_text ?? (response.output?.[0]?.content?.[0]?.text) ?? "{}";
    try { parsed = JSON.parse(raw); } catch { parsed = { per_doc: [] }; }

    // 7) Checklist mínima
    const checklist = [];
    for (const item of (parsed.per_doc || [])) {
      const t = item.doc_type;
      const e = item.extracted || {};
      const issues = [];

      if (t === "CERT_ORIGEN") {
        const hs = normHS(e.hs_code);
        const pe = normPE(e.origin_country);
        if (!hasText(hs) || hs.length < 6) issues.push({ field:"hs_code", reason:"HS inválido o ausente (esperado 6+ dígitos)." });
        if (pe !== "PE") issues.push({ field:"origin_country", reason:"País de origen distinto de 'PE'." });
        if (!hasText(e.invoice_number)) issues.push({ field:"invoice_number", reason:"Falta número de factura." });
        if (!hasText(e.goods_description)) issues.push({ field:"goods_description", reason:"Falta descripción de la mercancía." });
      }

      if (t === "FACTURA") {
        const total = toNum(e.total_invoice_value);
        const itemsOK = (e.items_found!=null && Number(e.items_found)>=1);
        if (!hasText(e.invoice_number)) issues.push({ field:"invoice_number", reason:"Falta número de factura." });
        if (!hasText(e.consignee_name)) issues.push({ field:"consignee_name", reason:"Falta nombre del consignatario." });
        if (total==null || total<=0) issues.push({ field:"total_invoice_value", reason:"Total de factura inválido." });
        if (!itemsOK) issues.push({ field:"items_found", reason:"No se detectaron ítems." });
      }

      if (t === "PACKING_LIST") {
        const pkgs = toNum(e.packages_count);
        const net  = toNum(e.net_weight_total);
        if (!hasText(e.packing_number)) issues.push({ field:"packing_number", reason:"Falta número de packing." });
        if (!hasText(e.packing_date)) issues.push({ field:"packing_date", reason:"Falta fecha de packing." });
        if (pkgs==null || pkgs<=0) issues.push({ field:"packages_count", reason:"Número de paquetes inválido." });
        if (net==null  || net<=0)  issues.push({ field:"net_weight_total", reason:"Peso neto total inválido." });
      }

      checklist.push({
        doc_type: t,
        required: true,
        status: issues.length ? "observado" : "ok",
        issues
      });
    }

    const anyObs = checklist.some(c => c.status !== "ok");
    const decision = anyObs ? "pendiente" : "aprobado";
    const observations = anyObs ? "Faltan campos en uno o más documentos." : "Documentación mínima OK.";

    // 8) Persistencia rápida (sin generar PDF aquí)
    const patch = { approved: !anyObs, status: decision, observations };
    await supa.from("lots").update(patch).eq("id", lotId);
    await supa.from("profiles").update({ ia_used: (profile?.ia_used || 0) + 1 }).eq("id", lot.user_id);
    await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "ai_checked", data: { per_doc: parsed.per_doc || [] } });

    return json(200, {
      ok: true,
      decision,
      checklist,
      stages: [
        { step: "lectura",    label: "Lectura de documentos",       status: "done" },
        { step: "extraccion", label: "Extracción de campos",        status: "done" },
        { step: "validacion", label: "Validación de reglas",        status: "done" },
        { step: "decision",   label: "Decisión del lote",           status: "done" },
        { step: "resultado",  label: "Preparando resultado final",  status: "done" },
      ],
      observations,
      certificate_path: null // se genera en el front con jsPDF
    });

  } catch (err) {
    console.error("validate-docs error:", err?.response?.data || err?.message || err);
    return json(500, { error: "Error en validación IA", details: err?.response?.data || err?.message || String(err) });
  } finally {
    const ms = Date.now() - start;
    console.log("[validate-docs] tiempo total:", ms, "ms");
  }
};
