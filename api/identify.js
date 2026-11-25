import Anthropic from "@anthropic-ai/sdk";

// Provider: Gemini (free tier) when GEMINI_API_KEY is set, otherwise Claude (ANTHROPIC_API_KEY).
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
let anthropic;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64_CHARS = 6_000_000; // ~4.5 MB of image data (Vercel body limit is 4.5 MB)

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "common_name", "scientific_name", "other_names", "confidence", "summary", "facts", "note"],
  properties: {
    found: { type: "boolean", description: "true if at least one fish is visible" },
    common_name: { type: "string" },
    scientific_name: { type: "string" },
    other_names: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string", description: "One or two sentences, like a friendly guide." },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "text"],
        properties: {
          label: { type: "string", enum: ["Appearance", "Habitat", "Behavior", "Diet", "Size", "Safety"] },
          text: { type: "string" },
        },
      },
    },
    note: { type: "string", description: "Optional caveat (e.g. similar look-alike species), or empty string." },
  },
};

const PROMPT = `You are a marine biologist helping a diver or snorkeler identify fish in their photo.
Identify the fish species shown. If there are several species, describe the most prominent one and mention the others in "note".
Write "summary" in one or two short sentences. Give 3-5 "facts" (Appearance, Habitat, Behavior, Diet, and Size or Safety when relevant), each one short sentence, and tie a fact to what is visible in the photo when you can (e.g. "swimming in pairs, as in your photo").
If you are not sure, give your best guess with confidence "low" and name likely look-alikes in "note".
If no fish is visible, set found=false, leave the name fields empty, and explain briefly in "summary".`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const { image, mediaType } = req.body ?? {};
  if (typeof image !== "string" || !image || !ALLOWED_TYPES.has(mediaType)) {
    return res.status(400).json({ error: "Send { image: <base64>, mediaType: 'image/jpeg' }" });
  }
  if (image.length > MAX_BASE64_CHARS) {
    return res.status(413).json({ error: "Image too large" });
  }

  try {
    const result = process.env.GEMINI_API_KEY
      ? await askGemini(image, mediaType)
      : await askClaude(image, mediaType);
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Too many requests, try again in a moment." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return res.status(502).json({ error: "The fish expert is unavailable right now." });
    }
    if (err instanceof ProviderError) {
      console.error(err.message);
      return res.status(err.status).json({ error: err.userMessage });
    }
    console.error(err);
    return res.status(500).json({ error: "Something went wrong." });
  }
}

class ProviderError extends Error {
  constructor(status, userMessage, detail) {
    super(detail || userMessage);
    this.status = status;
    this.userMessage = userMessage;
  }
}

async function askClaude(image, mediaType) {
  anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { status: 422, body: { error: "Sorry, this photo couldn't be analyzed." } };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return { status: 502, body: { error: "No answer from the model" } };
  return { status: 200, body: JSON.parse(text) };
}

async function askGemini(image, mediaType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: PROMPT }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
      },
    }),
  });

  if (r.status === 429) {
    throw new ProviderError(429, "Free daily limit reached. Try again later.", "Gemini rate limit (429)");
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new ProviderError(502, "The fish expert is unavailable right now.", `Gemini error ${r.status}: ${detail.slice(0, 500)}`);
  }

  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) {
    return { status: 422, body: { error: "Sorry, this photo couldn't be analyzed." } };
  }
  return { status: 200, body: JSON.parse(text) };
}
