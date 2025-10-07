// netlify/functions/ping-openai.js (CommonJS)
exports.handler = async () => {
  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const r = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: "Devuelve SOLO la palabra OK en mayúsculas." }] }
      ]
    });

    const text = r.output_text ?? (r.output?.[0]?.content?.[0]?.text) ?? "";
    const usage = r.usage || null;
    console.log("PÌNG usage:", usage);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, text, usage, model: r.model })
    };
  } catch (e) {
    console.error("ping-openai error:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
