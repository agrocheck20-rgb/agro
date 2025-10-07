// netlify/functions/validate-docs.js
const PDFDocument = require("pdfkit"); // CJS puro

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

// Utils
async function fetchArrayBuffer(url) {
  const r = await fetch(url); // fetch nativo Node 18
  if (!r.ok) throw new Error("No se pudo descargar archivo");
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
async function extractPdfTextFromSignedUrl(signedUrl) {
  const { default: pdfParse } = await import("pdf-parse");
  const buf = await fetchArrayBuffer(signedUrl);
  const res = await pdfParse(buf);
  return res?.text || "";
}
async function generateCertificatePDF(payload) {
  return await new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).font("Times-Bold").text(
      "Constancia de Aprobación de Calidad y Documentación",
      { align: "center" }
    );
    doc.moveDown();
    doc.fontSize(12).font("Times-Roman");
    const line = (label, value) => {
      doc.font("Times-Bold").text(label, { continued: true })
         .font("Times-Roman").text(" " + (value ?? "-"));
    };
    doc.moveDown();
    line("Certificado Nº:", payload.certificate_number ?? "—");
    line("Empresa:", payload.empresa);
    line("RUC:", payload.ruc ?? "—");
    line("Producto:", payload.producto);
    line("Variedad:", payload.variedad ?? "—");
    line("Lote:", payload.lote);
    line("Origen:", payload.origen ?? "—");
    line("Destino:", payload.destino);
    line("Fecha de emisión:", payload.fecha);
    line("Estado:", "APROBADO");

    doc.moveDown().font("Times-Bold").text("Observaciones:");
    doc.font("Times-Roman").text(payload.observaciones || "Sin observaciones");
    doc.moveDown().font("Times-Italic").fontSize(10)
       .text("Documento generado por AgroCheck.");
    doc.end();
  });
}

// Schema para Structured Outputs (Responses API)
const validationSchema = {
  name: "ValidationResult",
  schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["aprobado", "rechazado", "pendiente"] },
      checklist: {
        type: "array",
        items: {
          type: "object",
          properties: {
            doc_type: { type: "string" },
            required: { type: "boolean" },
            status: { type: "string", enum: ["ok", "faltante", "observado"] },
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["reason"],
                additionalProperties: false,
              },
            },
          },
          required: ["doc_type", "required", "status"],
          additionalProperties: false,
        },
      },
      per_doc_fields: {
        type: "object",
        additionalProperties: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: { type: "string" },
              confidence: { type: "number" },
              comment: { type: "string" },
            },
            required: ["field"],
            additionalProperties: false,
          },
        },
      },
      narrative: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["assistant"] },
            text: { type: "string" },
          },
          required: ["role", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["decision", "checklist"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `
Eres un asistente de validación documental para exportaciones agroindustriales.
Devuelve SOLO JSON conforme al schema:
- decision del lote ("aprobado"|"rechazado"|"pendiente"),
- checklist por doc_type (ok/faltante/observado + issues),
- per_doc_fields: campos detectados con valor/confianza/comentario,
- narrative: 3–6 mensajes breves explicando el proceso.
`;

// ===== Netlify Function (CommonJS) =====
exports.handler = async (event, context) => {
  try {
    // Cargar ESM dentro del handler
    const { default: OpenAI } = await import("openai");
    const { createClient } = await import("@supabase/supabase-js");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    const qs = event.queryStringParameters || {};
    const lotId =
      qs.lot_id ||
      (event.httpMethod === "POST" ? JSON.parse(event.body || "{}").lot_id : null);
    if (!lotId) return json(400, { error: "Falta lot_id" });

    // 1) Lote y perfil
    const { data: lot, error: eLot } = await supa.from("lots").select("*").eq("id", lotId).single();
    if (eLot || !lot) return json(404, { error: "Lote no encontrado" });
    const { data: profile } = await supa.from("profiles").select("*").eq("id", lot.user_id).single();

    // 2) Requisitos
    let { data: reqs, error: reqErr } = await supa.from("doc_requirements")
  .select("doc_type, required")
  .eq("product", lot.product).eq("country_code", lot.destination_country);

if (!Array.isArray(reqs) || reqs.length === 0) {
  let def = [];
  try {
    const r = await supa.from("required_docs").select("doc_type").eq("default_required", true);
    def = r.data || [];
  } catch {}
  reqs = (def.length ? def.map(d => ({ doc_type: d.doc_type, required: true })) : [
    { doc_type: "FITO", required: true },
    { doc_type: "REG_SAN", required: true },
    { doc_type: "FORM_EXP", required: true },
  ]);
}


    // 3) Documentos
    const { data: docs } = await supa.from("documents").select("*").eq("lot_id", lotId);
    const byType = {};
    for (const d of docs || []) (byType[d.doc_type] ||= []).push(d);

    // 4) Plantillas
    let { data: templates } = await supa.from("doc_templates").select("*");
if (!Array.isArray(templates) || templates.length === 0) {
  templates = [
    { doc_type: "FITO", required_fields: ["exporter_name","exporter_ruc","product","variety","lot_code","origin_region","destination_country","issue_date","signature"], rules: {} },
    { doc_type: "REG_SAN", required_fields: ["holder_name","ruc","product","batch","valid_until","signature"], rules: {} },
    { doc_type: "FORM_EXP", required_fields: ["exporter_name","ruc","product","hs_code","quantity","unit","destination_country","port","incoterm","invoice_number","date","signature"], rules: {} },
  ];
}


    // 5) Evidencias (texto PDFs)
    const perDocEvidence = {};
    for (const r of reqs) {
      const t = r.doc_type;
      const rows = byType[t] || [];
      if (rows.length === 0) { perDocEvidence[t] = { files: [], text: "" }; continue; }

      const files = [];
      let fullText = "";
      for (const row of rows) {
        const { data: signed } = await supa.storage.from("docs").createSignedUrl(row.file_path, 60);
        if (!signed?.signedUrl) continue;
        files.push({ path: row.file_path, url: signed.signedUrl });
        if (row.file_path.toLowerCase().endsWith(".pdf")) {
          try {
            fullText += `\n[${row.file_path}]\n${await extractPdfTextFromSignedUrl(signed.signedUrl)}\n`;
          } catch {
            fullText += `\n[${row.file_path}] (no fue posible extraer texto)\n`;
          }
        }
      }
      perDocEvidence[t] = { files, text: fullText.trim() };
    }

    // 6) Contexto para IA
    const contextPayload = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        origin_region: lot.origin_region, origin_province: lot.origin_province,
        destination_country: lot.destination_country,
      },
      requirements: reqs,
      templates: (templates || []).map((t) => ({
        doc_type: t.doc_type,
        required_fields: t.required_fields,
        rules: t.rules || {},
      })),
      evidence: perDocEvidence,
    };

    // 7) OpenAI (Structured Outputs)
    const response = await openai.responses.create({
  model: "gpt-4o-mini",
  input: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text", text: JSON.stringify(contextPayload) }] }
  ],
  text: {
    format: {
      type: "json_schema",
      json_schema: {
        name: validationSchema.name,
        schema: validationSchema.schema,
        strict: true
      }
    }
  }
});


    let parsed = {};
try {
  const raw = response.output_text ?? (response.output?.[0]?.content?.[0]?.text) ?? "{}";
  parsed = JSON.parse(raw);
} catch (e) {
  parsed = { decision: "pendiente", checklist: [], narrative: [{ role:"assistant", text:"No se pudo parsear la respuesta JSON" }] };
}


    // 8) Actualizar lote / certificado
    const approved = parsed.decision === "aprobado";
    const status = parsed.decision;

    const observations = (parsed.checklist || [])
      .filter((i) => (i.issues || []).length > 0)
      .map((i) => `${i.doc_type}: ${i.issues.map((x) => (x.field ? `${x.field} - ${x.reason}` : x.reason)).join("; ")}`)
      .join(" | ");

    let certificate_path = null;
    if (approved) {
      const certPayload = {
        empresa: profile?.full_name || profile?.email || "Exportador",
        ruc: "—",
        producto: lot.product,
        variedad: lot.variety,
        lote: lot.lot_code,
        origen: `${lot.origin_region || "-"}, ${lot.origin_province || "-"}`,
        destino: lot.destination_country,
        fecha: new Date().toLocaleDateString(),
        observaciones: observations || "",
      };
      const pdfBuffer = await generateCertificatePDF(certPayload);
      const path = `${lot.user_id}/${lot.id}/cert_${Date.now()}.pdf`;
      const { error: upErr } = await supa.storage.from("certs").upload(path, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (!upErr) certificate_path = path;
    }

    const patch = { approved, status, observations };
    if (certificate_path) {
      patch.certificate_path = certificate_path;
      patch.validated_at = new Date().toISOString();
      patch.reviewed_by = lot.user_id;
    }
    await supa.from("lots").update(patch).eq("id", lotId);
    await supa.from("profiles").update({ ia_used: (profile?.ia_used || 0) + 1 }).eq("id", lot.user_id);
    await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "ai_checked", data: { result: parsed } });
    if (approved && certificate_path) {
      await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "pdf_generated", data: { certificate_path } });
    }

    // 9) Stages para UI
    const stages = [
      { step: "lectura", label: "Lectura de documentos", status: "done" },
      { step: "extraccion", label: "Extracción de campos", status: "done" },
      { step: "validacion", label: "Validación de reglas", status: "done" },
      { step: "decision", label: "Decisión del lote", status: "done" },
      { step: "resultado", label: "Preparando resultado final", status: "done" },
    ];

    return json(200, {
      ok: true,
      decision: parsed.decision,
      checklist: parsed.checklist || [],
      per_doc_fields: parsed.per_doc_fields || {},
      narrative: parsed.narrative || [],
      stages,
      observations,
      certificate_path,
    });
  } catch (err) {
    console.error("validate-docs error:", err);
    return json(500, { error: "Error en validación IA", details: String(err) });
  }
};

