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

   // Lote + fotos (acepta lot_id o lot_code) + modo debug
const urlObj = new URL(event.rawUrl || "http://x/");
const q  = event.queryStringParameters || {};
const lot_id   = q.lot_id || null;
const lot_code = q.lot_code || null;
const debug    = q.debug === "1";

let lot = null;

// 1) intenta por lot_id
if (lot_id) {
  const q1 = await supa.from("lots").select("*").eq("id", lot_id).single();
  lot = q1.data || null;
}

// 2) si no, intenta por lot_code
if (!lot && lot_code) {
  const q2 = await supa.from("lots").select("*").eq("lot_code", lot_code).single();
  lot = q2.data || null;
}

if (!lot) return json(404, { error: "Lote no encontrado", hint: "Pasa ?lot_id=<uuid> o ?lot_code=<codigo>" });

// fotos del lote
const { data: photos, error: photosErr } = await supa
  .from("lot_photos")
  .select("file_path, created_at")
  .eq("lot_id", lot.id)
  .order("created_at", { ascending: true });

if (photosErr) return json(500, { error: "No se pudo listar fotos", details: photosErr.message });
if (!photos || photos.length === 0) return json(200, { ok: true, per_photo: [], summary: "No hay fotos en este lote." });

// modo debug: devuelve info sin llamar IA
if (debug) {
  return json(200, {
    ok: true,
    debug: {
      lot: { id: lot.id, code: lot.lot_code, product: lot.product },
      photos: photos.map(p => p.file_path),
      env: {
        hasOPENAI: !!process.env.OPENAI_API_KEY,
        hasSERVICE_ROLE: !!process.env.SUPABASE_SERVICE_ROLE,
        urlOK: !!process.env.SUPABASE_URL
      }
    }
  });
}

  // Subir fotos como input_file con manejo de errores visibles
async function uploadPhotoToOpenAI(path) {
  const { data: signed, error: signErr } = await supa.storage.from("photos").createSignedUrl(path, 60);
  if (signErr || !signed?.signedUrl) throw new Error("No se pudo firmar URL: " + (signErr?.message || "sin detalle"));

  const resp = await fetch(signed.signedUrl);
  if (!resp.ok) throw new Error("No se pudo descargar la foto (" + resp.status + ")");

  const buf = await resp.arrayBuffer();
  const { toFile } = await import("openai/uploads");
  const { default: OpenAI } = await import("openai");
  const openaiLocal = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const filename = path.split("/").pop() || "photo.jpg";
  const file = await toFile(Buffer.from(buf), filename, { type: "image/jpeg" });
  const up = await openaiLocal.files.create({ file, purpose: "vision" });
  return up.id;
}

const uploads = [];
for (const p of photos) {
  try {
    const fid = await uploadPhotoToOpenAI(p.file_path);
    uploads.push({ file_id: fid, path: p.file_path });
  } catch (e) {
    return json(500, { error: "Fallo preparando foto: " + String(e), path: p.file_path });
  }
}
if (uploads.length === 0) return json(200, { ok: true, per_photo: [], summary: "No se pudieron preparar las fotos." });

// Prompt + schema
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

// Construye input
const expected = (lot.product || "").toLowerCase();
const userContent = [{
  type: "input_text",
  text:
`Lote: ${lot.lot_code || lot.id}
Producto esperado: ${lot.product || "-"}
Para cada imagen, devuelve campos solicitados.`
}];
for (const up of uploads) userContent.push({ type: "input_file", file_id: up.file_id });

// Llamada a OpenAI (con errores visibles)
let resp;
try {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
      { role: "user",   content: userContent }
    ],
    text: {
      format: { type: "json_schema", name: schema.name, schema: schema.schema, strict: true }
    }
  });
} catch (e) {
  return json(500, { error: "OpenAI fallo: " + String(e) });
}

let parsed = {};
try {
  const raw = resp.output_text ?? (resp.output?.[0]?.content?.[0]?.text) ?? "{}";
  parsed = JSON.parse(raw);
} catch {
  return json(500, { error: "No pude parsear la salida de IA", raw: resp });
}

// Guardar
const rows = [];
for (let i=0; i<parsed.per_photo.length; i++) {
  const r = parsed.per_photo[i];
  const origin = uploads[i];
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


function json(code, body){ return { statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
