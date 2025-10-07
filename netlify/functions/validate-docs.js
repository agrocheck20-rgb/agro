// netlify/functions/validate-docs.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import pdfParse from "pdf-parse";
import PDFDocument from "pdfkit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

// Utilidades
async function fetchArrayBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("No se pudo descargar archivo");
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
async function extractPdfTextFromSignedUrl(signedUrl) {
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

// Schema de salida estructurada (Responses API → Structured Outputs)
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
                  reason: { type: "string" }
                },
                required: ["reason"],
                additionalProperties: false
              }
            }
          },
          required: ["doc_type", "required", "status"],
          additionalProperties: false
        }
      },
      // campos extra para “wow visual”
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
              comment: { type: "string" }
            },
            required: ["field"],
            additionalProperties: false
          }
        }
      },
      // mensajes breves para el chat lateral
      narrative: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["assistant"] },
            text: { type: "string" }
          },
          required: ["role","text"],
          additionalProperties: false
        }
      }
    },
    required: ["decision", "checklist"],
    additionalProperties: false
  }
};

// Prompt de sistema (rol de validador)
const SYSTEM_PROMPT = `
Eres un asistente de validación documental para exportaciones agroindustriales.
A partir de:
(1) requisitos por doc_type y campos obligatorios,
(2) texto extraído de documentos aportados (OCR/PDF),
(3) datos del lote (producto, país destino),
devuelve JSON ESTRICTO conforme al schema con:

- decision del lote: "aprobado" si TODOS los requeridos están presentes y sin observaciones críticas,
  "rechazado" si falta cualquiera requerido o hay campos obligatorios inválidos,
  "pendiente" si aún no están todos los requeridos.
- checklist por doc_type con status: "ok" | "faltante" | "observado", e issues (campo y motivo).
- per_doc_fields: lista de campos detectados por doc con (value, confidence, y un comment breve si aplica).
- narrative: 3-6 mensajes cortos (role=assistant) explicando en lenguaje natural el proceso y hallazgos.

Responde SOLO con JSON (sin texto extra).
`;

// Helper “stages” para el pipeline
function startStages() {
  const now = Date.now();
  const S = [];
  const push = (step, message) => {
    S.push({ step, message, at: new Date().toISOString() });
  };
  return { S, push, t0: now };
}

export default async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lotId = url.searchParams.get("lot_id");
    if (!lotId) return res.status(400).json({ error: "Falta lot_id" });

    const { S, push } = startStages();

    // 1) Cargar lote y perfil
    push("lectura", "Cargando datos del lote y perfil");
    const { data: lot, error: eLot } = await supa.from("lots").select("*").eq("id", lotId).single();
    if (eLot || !lot) return res.status(404).json({ error: "Lote no encontrado" });
    const { data: profile } = await supa.from("profiles").select("*").eq("id", lot.user_id).single();

    // 2) Requisitos (específicos o por defecto)
    push("lectura", "Cargando requisitos por producto y país");
    let { data: reqs } = await supa.from("doc_requirements")
      .select("doc_type, required")
      .eq("product", lot.product).eq("country_code", lot.destination_country);
    if (!reqs || reqs.length === 0) {
      const { data: def } = await supa.from("required_docs").select("doc_type").eq("default_required", true);
      reqs = (def || []).map(d => ({ doc_type: d.doc_type, required: true }));
    }

    // 3) Documentos del lote
    push("lectura", "Listando documentos cargados por el usuario");
    const { data: docs } = await supa.from("documents").select("*").eq("lot_id", lotId);
    const byType = {};
    for (const d of (docs || [])) (byType[d.doc_type] ||= []).push(d);

    // 4) Plantillas (campos obligatorios)
    push("lectura", "Consultando plantillas de validación");
    const { data: templates } = await supa.from("doc_templates").select("*");
    const tmplByType = Object.fromEntries((templates || []).map(t => [t.doc_type, t]));

    // 5) Evidencias por documento (texto de PDFs)
    push("extraccion", "Extrayendo texto de PDFs");
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
          try { fullText += `\n[${row.file_path}]\n${await extractPdfTextFromSignedUrl(signed.signedUrl)}\n`; }
          catch { fullText += `\n[${row.file_path}] (no fue posible extraer texto)\n`; }
        }
      }
      perDocEvidence[t] = { files, text: fullText.trim() };
    }

    // 6) Construir contexto para el modelo
    push("validacion", "Construyendo contexto para IA");
    const context = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        origin_region: lot.origin_region, origin_province: lot.origin_province,
        destination_country: lot.destination_country
      },
      requirements: reqs,
      templates: (templates || []).map(t => ({
        doc_type: t.doc_type,
        required_fields: t.required_fields,
        rules: t.rules || {}
      })),
      evidence: perDocEvidence
    };

    // 7) Llamada a OpenAI (Structured Outputs / JSON Schema)
    push("validacion", "Enviando a IA (análisis y comparación)");
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [{ type: "text", text: JSON.stringify(context) }] }
      ],
      response_format: { type: "json_schema", json_schema: validationSchema }
    });
    // (Responses API con json_schema: salida JSON conforme al schema) :contentReference[oaicite:1]{index=1}

    let parsed = {};
    try {
      const raw = response.output?.[0]?.content?.[0]?.text || "{}";
      parsed = JSON.parse(raw);
    } catch {
      parsed = { decision: "pendiente", checklist: [], narrative: [{role:"assistant", text:"No se pudo parsear la respuesta JSON"}] };
    }

    // 8) Decisión y actualización del lote / certificado
    push("decision", "Determinando decisión y actualizando lote");
    const approved = parsed.decision === "aprobado";
    const status = parsed.decision;

    const observations = (parsed.checklist || [])
      .filter(i => (i.issues || []).length > 0)
      .map(i => `${i.doc_type}: ${i.issues.map(x => (x.field ? `${x.field} - ${x.reason}` : x.reason)).join("; ")}`)
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
        observaciones: observations || ""
      };
      const pdfBuffer = await generateCertificatePDF(certPayload);
      const path = `${lot.user_id}/${lot.id}/cert_${Date.now()}.pdf`;
      const { error: upErr } = await supa.storage.from("certs").upload(path, pdfBuffer, { contentType: "application/pdf", upsert: true });
      if (!upErr) certificate_path = path;
    }

    const patch = { approved, status, observations };
    if (certificate_path) {
      patch.certificate_path = certificate_path;
      patch.validated_at = new Date().toISOString();
      patch.reviewed_by = lot.user_id;
    }
    await supa.from("lots").update(patch).eq("id", lotId);
    push("resultado", "Guardando eventos y uso de IA");

    await supa.from("profiles").update({ ia_used: (profile?.ia_used || 0) + 1 }).eq("id", lot.user_id);
    await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "ai_checked", data: { result: parsed } });
    if (approved && certificate_path) {
      await supa.from("lot_events").insert({ user_id: lot.user_id, lot_id: lotId, event_type: "pdf_generated", data: { certificate_path } });
    }

    // 9) Pipeline (stages) para el Workbench
    const stages = [
      { step: "lectura",     label: "Lectura de documentos",        status: "done" },
      { step: "extraccion",  label: "Extracción de campos",         status: "done" },
      { step: "validacion",  label: "Validación de reglas",         status: "done" },
      { step: "decision",    label: "Decisión del lote",            status: "done" },
      { step: "resultado",   label: "Preparando resultado final",   status: "done" }
    ];

    return res.status(200).json({
      ok: true,
      decision: parsed.decision,
      checklist: parsed.checklist || [],
      per_doc_fields: parsed.per_doc_fields || {},
      narrative: parsed.narrative || [],
      stages,
      observations,
      certificate_path
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error en validación IA", details: String(err) });
  }
};
