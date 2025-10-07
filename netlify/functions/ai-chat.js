// netlify/functions/ai-chat.js
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj),
  };
}

const SYSTEM = `
Eres el asistente IA de AgroCheck. Explicas lo que haces, respondes dudas
y sugieres cómo corregir documentos. Sé breve, claro y específico.
`;

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

    // ESM dinámicos
    const { default: OpenAI } = await import("openai");
    const { createClient } = await import("@supabase/supabase-js");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

    const body = JSON.parse(event.body || "{}");
    const { lot_id, message } = body;
    if (!lot_id || !message) return json(400, { error: "Falta lot_id o message" });

    const { data: lot } = await supa.from("lots").select("*").eq("id", lot_id).single();
    let { data: reqs } = await supa.from("doc_requirements").select("doc_type, required")
      .eq("product", lot.product).eq("country_code", lot.destination_country);
    if (!reqs || reqs.length === 0) {
      const { data: def } = await supa.from("required_docs").select("doc_type").eq("default_required", true);
      reqs = (def || []).map((d) => ({ doc_type: d.doc_type, required: true }));
    }

    const contextPayload = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        destination_country: lot.destination_country,
      },
      requirements: reqs,
    };

    const r = await openai.responses.create({
  model: "gpt-4o-mini",
  input: [
    { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
    {
      role: "user",
      content: [{
        type: "input_text",
        text: `Contexto: ${JSON.stringify(contextPayload)}\n\nPregunta: ${message}`
      }]
    }
  ]
});


    const text = r.output?.[0]?.content?.[0]?.text || "No tengo respuesta en este momento.";
    return json(200, { ok: true, text });
  } catch (e) {
    console.error("ai-chat error:", e);
    return json(500, { error: "Fallo chat IA" });
  }
};

