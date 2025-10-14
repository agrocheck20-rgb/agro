// netlify/functions/validate-docs.js
// CJS (CommonJS) con imports ESM dinámicos cuando hace falta

// ---------- Helpers de respuesta ----------
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

async function fetchArrayBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("No se pudo descargar archivo");
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// intenta extraer texto embebido de PDF — si pdf-parse no está instalado, no rompe
async function extractPdfTextFromSignedUrl(signedUrl) {
  try {
    const { default: pdfParse } = await import("pdf-parse");
    const buf = await fetchArrayBuffer(signedUrl);
    const res = await pdfParse(buf);
    return res?.text || "";
  } catch {
    return ""; // sin OCR extra, seguimos igual
  }
}

// ---------- Schema (Structured Outputs) ----------
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
                // CERT_ORIGEN
                hs_code:            { type: ["string","null"] },
                origin_country:     { type: ["string","null"] },
                invoice_number:     { type: ["string","null"] },
                goods_description:  { type: ["string","null"] },
                // FACTURA
                consignee_name:      { type: ["string","null"] },
                total_invoice_value: { type: ["number","string","null"] },
                items_found:         { type: ["number","null"] },
                // PACKING_LIST
                packing_number:   { type: ["string","null"] },
                packing_date:     { type: ["string","null"] },
                packages_count:   { type: ["number","string","null"] },
                net_weight_total: { type: ["number","string","null"] }
              },
              // marcamos todos como requeridos para que el modelo siempre intente devolverlos
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

// ---------- Prompt ----------
const SYSTEM_PROMPT = `
Eres un verificador de documentación de exportación. Responde SIEMPRE en español.
Lee los documentos adjuntos (PDF o imágenes) con OCR si hace falta y EXTRAe SOLO los campos solicitados por documento.
Normaliza antes de validar:

- HS: elimina todo lo que no sea dígito y usa los primeros 6-8 dígitos (p.ej. "0804.40.00" => "080440").
- País de origen Perú: acepta "PE", "Peru", "Perú", "PE (Perú)" => "PE".
- Fechas: acepta dd/mm/aaaa o similares; devuelve en el mismo formato que encuentres.
- Montos: extrae dígitos con separadores; devuelve número o string numérico.

Para cada documento devuélveme un objeto "extracted" con EXACTAMENTE estos campos:

CERT_ORIGEN:
  - hs_code (string, 6+ dígitos tras normalización)
  - origin_country (string, esperable "PE")
  - invoice_number (string)
  - goods_description (string)

FACTURA:
  - invoice_number (string)
  - consignee_name (string)
  - total_invoice_value (number o string numérico)
  - items_found (integer; cantidad de renglones de ítems detectados)

PACKING_LIST:
  - packing_number (string)
  - packing_date (string fecha)
  - packages_count (number o string numérico)
  - net_weight_total (number o string numérico, preferible en kg)

Si un valor no existe en el documento, deja el campo vacío o null. NO inventes datos.
Devuelve SOLO JSON según el schema.`;

// ---------- Validaciones mínimas ----------
function hasText(v){ return v!=null && String(v).trim().length>0; }
function toNum(v){
  if (v==null) return null;
  const t = String(v).replace(/[^\d.,-]/g,"");
  // intenta coma decimal
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

// ============== HANDLER ==============
exports.handler = async (event) => {
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

    // 2) Requisitos (nuestros 3 docs por defecto)
    let { data: reqs } = await supa
      .from("doc_requirements")
      .select("doc_type, required")
      .eq("product", lot.product)
      .eq("country_code", lot.destination_country);

    const FALLBACK_REQS = [
      { doc_type: "CERT_ORIGEN", required: true },
      { doc_type: "FACTURA", required: true },
      { doc_type: "PACKING_LIST", required: true }
    ];
    if (!Array.isArray(reqs) || reqs.length === 0) reqs = FALLBACK_REQS;

    // 3) Documentos del lote
    const { data: docs } = await supa.from("documents").select("*").eq("lot_id", lotId);
    const byType = {};
    for (const d of docs || []) (byType[d.doc_type] ||= []).push(d);
    // ordena descendente por fecha de creación para quedarte con el más reciente
    for (const t of Object.keys(byType)) {
      byType[t].sort((a,b)=>(new Date(b.created_at||0))-(new Date(a.created_at||0)));
      byType[t] = byType[t].slice(0,1); // toma solo 1 archivo por tipo
    }

    // 4) Preparar inputs (PDF -> input_file (purpose: vision) | imagen -> input_image)
    const perDocInputs = [];   // [{ doc_type, inputs:[{type, image_url|file_id}] }]
    const perDocText   = {};   // texto PDF embebido opcional

    for (const r of reqs) {
      const t = r.doc_type;
      if (!["CERT_ORIGEN","FACTURA","PACKING_LIST"].includes(t)) continue;

      const rows = byType[t] || [];
      if (rows.length === 0) { perDocInputs.push({ doc_type:t, inputs:[] }); continue; }

      const inputs = [];
      let concatText = "";

      for (const row of rows) {
        const ext = (row.file_path || "").toLowerCase().split(".").pop();
        const { data: signed } = await supa.storage.from("docs").createSignedUrl(row.file_path, 300);
        if (!signed?.signedUrl) continue;

        if (["jpg","jpeg","png","webp","gif"].includes(ext)) {
          inputs.push({ type: "input_image", image_url: signed.signedUrl });
        } else if (ext === "pdf") {
          const buf = await fetchArrayBuffer(signed.signedUrl);
          const file = await toFile(
            buf,
            row.file_path.split("/").pop() || "doc.pdf",
            { type: "application/pdf" }
          );
          // OJO: purpose 'vision' para que la Responses API lo use como input_file OCR
          const up = await openai.files.create({ file, purpose: "vision" });
          inputs.push({ type: "input_file", file_id: up.id });

          // (opcional) intenta extraer texto embebido
          try { concatText += `\n[${row.file_path}]\n${await extractPdfTextFromSignedUrl(signed.signedUrl)}\n`; }
          catch {}
        } else {
          // otros formatos -> intentar como imagen por URL (si es renderizable)
          inputs.push({ type: "input_image", image_url: signed.signedUrl });
        }
      }

      perDocInputs.push({ doc_type:t, inputs });
      if (concatText) perDocText[t] = concatText;
    }

    // 5) Construir input para la IA
    const context = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        origin_region: lot.origin_region, origin_province: lot.origin_province,
        destination_country: lot.destination_country,
      },
      requirements: reqs
    };

    const userContent = [{
      type: "input_text",
      text:
`Valida SOLO cuatro campos por documento (según SYSTEM_PROMPT) para el lote ${lot.lot_code || lot.id}.
Contexto:
${JSON.stringify(context, null, 2)}`
    }];

    for (const block of perDocInputs) {
      if (!block.inputs.length) continue;
      userContent.push({ type: "input_text", text: `Documento: ${block.doc_type}`});
      for (const inp of block.inputs) userContent.push(inp);
      if (perDocText[block.doc_type]) {
        userContent.push({ type: "input_text", text: `Texto OCR (si ayuda):\n${perDocText[block.doc_type].slice(0, 6000)}` });
      }
    }

    // 6) OpenAI (Structured Outputs)
    const { default: OpenAIClient } = await import("openai"); // (no imprescindible, pero mantiene consistencia ESM)
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
        { role: "user",   content: userContent }
      ],
      text: {
        format: {
          type: "json_schema",
          name: validationSchema.name,
          schema: validationSchema.schema,
          strict: true
        }
      }
    });

    let parsed = {};
    try {
      const raw = response.output_text ?? (response.output?.[0]?.content?.[0]?.text) ?? "{}";
      parsed = JSON.parse(raw);
    } catch {
      parsed = { per_doc: [] };
    }

    // 7) Validación mínima en servidor => checklist
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

    // 8) Actualizar lote (ya no generamos PDF aquí)
    const patch = { approved: !anyObs, status: decision, observations };
    await supa.from("lots").update(patch).eq("id", lotId);

    // contar uso IA
    await supa.from("profiles").update({ ia_used: (profile?.ia_used || 0) + 1 }).eq("id", lot.user_id);

    // eventos
    await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "ai_checked", data: { per_doc: parsed.per_doc || [] } });

    const stages = [
      { step: "lectura",    label: "Lectura de documentos",       status: "done" },
      { step: "extraccion", label: "Extracción de campos",        status: "done" },
      { step: "validacion", label: "Validación de reglas",        status: "done" },
      { step: "decision",   label: "Decisión del lote",           status: "done" },
      { step: "resultado",  label: "Preparando resultado final",  status: "done" },
    ];

    return json(200, {
      ok: true,
      decision,
      checklist,
      stages,
      observations,
      certificate_path: null // el PDF lo genera el front con jsPDF
    });

  } catch (err) {
    // MÁS detalle para que el front vea el error real
    console.error("validate-docs error:", err);
    return json(500, { error: "Error en validación IA", details: (err?.message || String(err)), stack: err?.stack });
  }
};

