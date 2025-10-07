// netlify/functions/ai-chat.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

const SYSTEM = `
Eres el asistente IA de AgroCheck. Explicas lo que estás haciendo, respondes dudas del exportador,
y sugieres cómo corregir documentos. Sé breve, claro y específico para agroexportaciones.
`;

export default async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    const body = await new Promise((resolve) => {
      let data = ""; req.on("data", (c)=> data += c);
      req.on("end", ()=> resolve(JSON.parse(data||"{}")));
    });
    const { lot_id, message } = body;
    if (!lot_id || !message) return res.status(400).json({ error:"Falta lot_id o message" });

    const { data: lot } = await supa.from("lots").select("*").eq("id", lot_id).single();
    let { data: reqs } = await supa.from("doc_requirements").select("doc_type, required")
      .eq("product", lot.product).eq("country_code", lot.destination_country);
    if (!reqs || reqs.length===0) {
      const { data: def } = await supa.from("required_docs").select("doc_type").eq("default_required", true);
      reqs = (def||[]).map(d=>({ doc_type: d.doc_type, required: true }));
    }

    const context = {
      lote: {
        product: lot.product, variety: lot.variety, lot_code: lot.lot_code,
        destination_country: lot.destination_country
      },
      requirements: reqs
    };

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: [{ type:"text", text: `Contexto: ${JSON.stringify(context)}\n\nPregunta: ${message}` }] }
      ]
    });
    const text = r.output?.[0]?.content?.[0]?.text || "No tengo respuesta en este momento.";
    return res.status(200).json({ ok:true, text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error:"Fallo chat IA" });
  }
};
