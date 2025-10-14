// netlify/functions/inspect-photos.js
exports.handler = async (event) => {
  try {
    const isPost = event.httpMethod === "POST";
    const q = event.queryStringParameters || {};
    const body = isPost && event.body ? JSON.parse(event.body) : {};

    // 1) Identificadores de lote
    const lotId   = body.lot_id || q.lot_id || null;   // UUID
    const lotCode = q.lot_code || null;                // opcional por GET
    const debug   = q.debug === "1";

    // 2) Imports + clientes
    const { default: OpenAI } = await import("openai");
    const { createClient } = await import("@supabase/supabase-js");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supa   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    // 3) Buscar lote (por id o por code)
    let lot = null;
    if (lotId) {
      const { data } = await supa.from("lots").select("*").eq("id", lotId).single();
      lot = data || null;
    }
    if (!lot && lotCode) {
      const { data } = await supa.from("lots").select("*").eq("lot_code", lotCode).single();
      lot = data || null;
    }
    if (!lot) return json(404, { error: "Lote no encontrado", hint: "Pasa lot_id (POST/GET) o lot_code (GET)" });

    // 4) Determinar qué fotos analizar
    let photoPaths = Array.isArray(body.paths) && body.paths.length ? body.paths : null;

    if (!photoPaths) {
      // Fallback: usa todas las fotos del lote
      const { data: photos, error: photosErr } = await supa
        .from("lot_photos")
        .select("file_path, created_at")
        .eq("lot_id", lot.id)
        .order("created_at", { ascending: true });

      if (photosErr) return json(500, { error: "No se pudo listar fotos", details: photosErr.message });
      photoPaths = (photos || []).map(p => p.file_path);
    }

    if (!photoPaths || photoPaths.length === 0) {
      return json(200, { ok: true, per_photo: [], summary: "No hay fotos para analizar." });
    }

    // 5) Firmar URLs (usaremos input_image con image_url STRING)
    const images = [];
    for (const path of photoPaths) {
      const { data: signed, error: signErr } = await supa.storage.from("photos").createSignedUrl(path, 300);
      if (signErr || !signed?.signedUrl) {
        return json(500, { error: "No se pudo firmar URL de foto", path, details: signErr?.message });
      }
      images.push({ url: signed.signedUrl, path });
    }

    // Debug temprano
    if (q.debug === "1") {
      return json(200, {
        ok: true,
        debug: {
          lot: { id: lot.id, code: lot.lot_code, product: lot.product },
          photos: images.map(i => i.path)
        }
      });
    }

    // 6) Prompt + schema (ESPAÑOL)
    const SYSTEM = `Eres un inspector de calidad para frutas frescas de exportación.
Responde SIEMPRE en español.
- Identifica la fruta, evalúa la madurez, detecta defectos visibles (golpes, moho, cortes, decoloración, arrugas, enfoque/iluminación) y decide si es apta para exportar.
- Si la evidencia es insuficiente, marca export_ready=false y explica brevemente en "notes".
Devuelve JSON EXACTO según el schema. "notes" y "summary" van en español.`;

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

    // 7) Construir input para la IA
    const expected = (lot.product || "").toLowerCase();
    const userContent = [{
      type: "input_text",
      text:
`Lote: ${lot.lot_code || lot.id}
Producto esperado: ${lot.product || "-"}
Para cada imagen, devuelve: product_detected, confidence (0..1), ripeness (unripe|ripe|overripe|unknown),
issues (array), export_ready (true/false) y notes (breve en español).`
    }];

    for (const img of images) {
      userContent.push({ type: "input_image", image_url: img.url }); // image_url debe ser STRING
    }

    // 8) Llamar a OpenAI (Structured Outputs)
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

    // 9) Parsear salida
    let parsed = {};
    try {
      const raw = resp.output_text ?? (resp.output?.[0]?.content?.[0]?.text) ?? "{}";
      parsed = JSON.parse(raw);
    } catch {
      return json(500, { error: "No pude parsear la salida de IA", raw: resp });
    }

    // 10) Guardar resultados en DB
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
