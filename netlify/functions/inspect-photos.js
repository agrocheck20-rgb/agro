// netlify/functions/inspect-photos.js
exports.handler = async (event) => {
  try {
    // ---- Query params ----
    const q = event.queryStringParameters || {};
    const lotId   = q.lot_id   || null;   // UUID
    const lotCode = q.lot_code || null;   // código humano (p.ej., Lote-001)
    const debug   = q.debug === "1";

    // ---- Imports ----
    const { default: OpenAI } = await import("openai");
    const { createClient } = await import("@supabase/supabase-js");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supa   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    // ---- Buscar el lote ----
    let lot = null;
    if (lotId) {
      const { data } = await supa.from("lots").select("*").eq("id", lotId).single();
      lot = data || null;
    }
    if (!lot && lotCode) {
      const { data } = await supa.from("lots").select("*").eq("lot_code", lotCode).single();
      lot = data || null;
    }
    if (!lot) return json(404, { error: "Lote no encontrado", hint: "Pasa ?lot_id=<uuid> o ?lot_code=<codigo>" });

    // ---- Traer fotos del lote ----
    const { data: photos, error: photosErr } = await supa
      .from("lot_photos")
      .select("file_path, created_at")
      .eq("lot_id", lot.id)
      .order("created_at", { ascending: true });

    if (photosErr) return json(500, { error: "No se pudo listar fotos", details: photosErr.message });
    if (!photos || photos.length === 0) {
      return json(200, { ok: true, per_photo: [], summary: "No hay fotos en este lote." });
    }

    // ---- Crear URLs firmadas (las usaremos como input_image) ----
    const images = [];
    for (const p of photos) {
      const { data: signed, error: signErr } = await supa.storage.from("photos").createSignedUrl(p.file_path, 300);
      if (signErr || !signed?.signedUrl) {
        return json(500, { error: "No se pudo firmar URL de foto", path: p.file_path, details: signErr?.message });
      }
      images.push({ url: signed.signedUrl, path: p.file_path });
    }

    // ---- Modo debug: ver lote, fotos y env ----
    if (debug) {
      return json(200, {
        ok: true,
        debug: {
          lot: { id: lot.id, code: lot.lot_code, product: lot.product },
          photos: images.map(i => i.path),
          env: {
            hasOPENAI: !!process.env.OPENAI_API_KEY,
            hasSERVICE_ROLE: !!process.env.SUPABASE_SERVICE_ROLE,
            urlOK: !!process.env.SUPABASE_URL
          }
        }
      });
    }

    // ---- Prompt + schema ----
    const SYSTEM = `Eres un inspector de calidad para frutas frescas de exportación.
- Identifica la fruta, evalúa madurez, detecta defectos (golpes, moho, cortes, decoloración, arrugas, desenfoque/iluminación) y decide si es apta para exportar.
- Si hay duda (imagen borrosa/oscura), marca export_ready=false y explica.
Devuelve JSON EXACTO según el schema.`;

    const schema = {
      name: "VisionInspection",
      schema: {
        type: "object",
        properties: {
          per_photo: {
            type: "array",
            items: {
              type: "object",
              properties: {
                photo_path: { type: "string" },
                product_expected: { type: "string" },
                product_detected: { type: "string" },
                confidence: { type: "number" },
                ripeness: { type: "string", enum: ["unripe","ripe","overripe","unknown"] },
                issues: { type: "array", items: { type: "string" } },
                export_ready: { type: "boolean" },
                notes: { type: "string" }
              },
              required: ["photo_path","product_expected","product_detected","confidence","ripeness","issues","export_ready","notes"],
              additionalProperties: false
            }
          },
          summary: { type: "string" }
        },
        required: ["per_photo","summary"],
        additionalProperties: false
      }
    };

    // ---- Construir input para la IA ----
    const expected = (lot.product || "").toLowerCase();
    const userContent = [{
      type: "input_text",
      text:
`Lote: ${lot.lot_code || lot.id}
Producto esperado: ${lot.product || "-"}
Para cada imagen, devuelve: product_detected, confidence (0..1), ripeness (unripe|ripe|overripe|unknown),
issues (array), export_ready (true/false) y notes (breve).`
    }];

    // AÑADIR IMÁGENES como input_image (NO input_file)
    for (const img of images) {
  userContent.push({ type: "input_image", image_url: img.url }); // <- debe ser STRING, no objeto
}


    // ---- Llamar a OpenAI (Responses API con Structured Outputs) ----
    let resp;
    try {
      resp = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
          { role: "user",   content: userContent }
        ],
        text: { format: { type: "json_schema", name: schema.name, schema: schema.schema, strict: true } }
      });
    } catch (e) {
      return json(500, { error: "OpenAI fallo: " + String(e) });
    }

    // ---- Parsear salida ----
    let parsed = {};
    try {
      const raw = resp.output_text ?? (resp.output?.[0]?.content?.[0]?.text) ?? "{}";
      parsed = JSON.parse(raw);
    } catch {
      return json(500, { error: "No pude parsear la salida de IA", raw: resp });
    }

    // ---- Guardar en DB (lot_photo_reviews) ----
    const rows = [];
    for (let i = 0; i < parsed.per_photo.length; i++) {
      const r = parsed.per_photo[i];
      const origin = images[i];
      if (!origin) continue;
      rows.push({
        lot_id: lot.id,
        photo_path: origin.path,
        product_expected: expected,
        product_detected: r.product_detected || null,
        confidence: r.confidence ?? null,
        ripeness: r.ripeness || null,
        export_ready: !!r.export_ready,
        issues: r.issues || [],
        notes: r.notes || ""
      });
    }

    if (rows.length) {
      const { error: insErr } = await supa.from("lot_photo_reviews").insert(rows);
      if (insErr) return json(500, { error: "No se pudo guardar resultados", details: insErr.message });
    }

    return json(200, { ok: true, per_photo: rows, summary: parsed.summary, usage: resp.usage || null });

  } catch (e) {
    console.error(e);
    return json(500, { error: String(e) });
  }
};

function json(code, body) {
  return { statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
