// netlify/functions/inspect-photos.js (CommonJS)
exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl || "http://x/"+(event.rawUrl||""));
    const lot_id = url.searchParams.get("lot_id") || (event.queryStringParameters && event.queryStringParameters.lot_id);
    if (!lot_id) return json(400, { error: "Falta lot_id" });

    const { default: OpenAI } = await import("openai");
    const { toFile } = await import("openai/uploads");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const { createClient } = await import("@supabase/supabase-js");
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    // Lote + fotos (acepta lot_id o lot_code)
let lot = null;

// 1) intenta por lot_id
if (event.queryStringParameters?.lot_id) {
  const { data } = await supa.from("lots").select("*").eq("id", event.queryStringParameters.lot_id).single();
  lot = data || null;
}

// 2) si no, intenta por lot_code
if (!lot && event.queryStringParameters?.lot_code) {
  const { data } = await supa.from("lots").select("*").eq("lot_code", event.queryStringParameters.lot_code).single();
  lot = data || null;
}

if (!lot) return json(404, { error: "Lote no encontrado" });

const { data: photos } = await supa
  .from("lot_photos")
  .select("file_path")
  .eq("lot_id", lot.id)
  .order("created_at", { ascending: true });

if (!photos || photos.length === 0) {
  return json(200, { ok: true, per_photo: [], summary: "No hay fotos en este lote." });
}


    // Subir fotos como input_file
    async function fileId(path) {
      const { data: signed } = await supa.storage.from("photos").createSignedUrl(path, 60);
      const resp = await fetch(signed.signedUrl);
      const buf = await resp.arrayBuffer();
      const f = await toFile(Buffer.from(buf), path.split("/").pop() || "photo.jpg", { type: "image/jpeg" });
      const up = await openai.files.create({ file: f, purpose: "vision" });
      return { file_id: up.id, path };
    }
    const uploads = [];
    for (const p of photos) {
      try { uploads.push(await fileId(p.file_path)); } catch(e) { console.error("photo upload fail", e); }
    }
    if (!uploads.length) return json(200, { ok: true, per_photo: [], summary: "No se pudieron preparar las fotos." });

    const SYSTEM = `Eres un inspector de calidad para frutas frescas de exportación.
- Tareas: identificar la fruta, evaluar madurez, detectar defectos visibles, decidir si está lista para exportación.
- Reglas base por fruta (pueden variar por variedad):
  MANGO: madurez adecuada (color/tono), sin golpes/moho/cortes, no sobremaduro.
  UVA: racimos firmes, sin moho ni bayas aplastadas.
  ARANDANO: bayas firmes, sin moho ni arrugas severas.
  FRESA: rojo uniforme, sin moho ni magulladuras.
Si evidencia insuficiente: 'unknown' y export_ready=false si hay dudas.
Devuelve JSON EXACTO por foto.`;

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

    const expected = (lot.product || "").toLowerCase();
    const userContent = [{
      type: "input_text",
      text:
`Lote: ${lot.lot_code || lot.id}
Producto esperado: ${lot.product || "-"}
País destino: ${lot.destination_country || "-"}
Para cada imagen adjunta, devuelve:
- product_detected (mango/uva/arandano/fresa/otro),
- confidence (0..1),
- ripeness (unripe|ripe|overripe|unknown),
- issues (array),
- export_ready (true/false),
- notes (breve).`
    }];
    for (const up of uploads) userContent.push({ type: "input_file", file_id: up.file_id });

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
        { role: "user",   content: userContent }
      ],
      text: { format: { type: "json_schema", name: schema.name, schema: schema.schema, strict: true } }
    });

    let parsed = {};
    try {
      const raw = resp.output_text ?? (resp.output?.[0]?.content?.[0]?.text) ?? "{}";
      parsed = JSON.parse(raw);
    } catch {
      parsed = { per_photo: [], summary: "No se pudo parsear salida de IA." };
    }

    // Guardar
    const rows = [];
    for (let i=0; i<parsed.per_photo.length; i++) {
      const r = parsed.per_photo[i];
      const origin = uploads[i];
      if (!origin) continue;
      rows.push({
        lot_id,
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
    if (rows.length) await supa.from("lot_photo_reviews").insert(rows);

    return json(200, { ok:true, per_photo: rows, summary: parsed.summary, usage: resp.usage || null });
  } catch (e) {
    console.error(e);
    return json(500, { error: String(e) });
  }
};

function json(code, body){ return { statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
