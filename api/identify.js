import Anthropic from "@anthropic-ai/sdk";

// Provider: Gemini (free tier) when GEMINI_API_KEY is set, otherwise Claude (ANTHROPIC_API_KEY).
// Fast models are asked at the same time; the first good answer wins and the others are cancelled.
// (The free "gemini-flash-latest" often hangs under load, so it is not in the default list.)
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3-flash-preview")
  .split(",").map((m) => m.trim()).filter(Boolean);
const GEMINI_ATTEMPT_TIMEOUT_MS = 15_000;
const GEMINI_DEADLINE_MS = 40_000;
let anthropic;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64_CHARS = 6_000_000; // ~4.5 MB of image data (Vercel body limit is 4.5 MB)

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "english_name", "scientific_name", "common_name", "other_names", "confidence", "summary", "facts", "note"],
  properties: {
    found: { type: "boolean", description: "true if at least one fish is visible" },
    english_name: { type: "string", description: "Decide the species first: its English common name." },
    scientific_name: { type: "string" },
    common_name: { type: "string", description: "Common name in the reply language." },
    other_names: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string", description: "One or two sentences, like a friendly guide." },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "text", "short"],
        properties: {
          label: { type: "string", enum: ["Appearance", "Habitat", "Behavior", "Diet", "Size", "Safety"] },
          text: { type: "string" },
          short: { type: "string", description: "The same fact in 2-5 words, for a small card (e.g. 'Red Sea reefs, 1-20 m')." },
        },
      },
    },
    note: { type: "string", description: "Optional caveat (e.g. similar look-alike species), or empty string." },
  },
};

const PROMPT = `You are a marine biologist helping a diver or snorkeler identify fish in their photo.
Identify the fish species shown. Decide the species first (english_name and scientific_name), based on the visible markings, before writing anything else. If there are several species, describe the most prominent one and mention the others in "note".
Write "summary" in one or two short sentences. Give 3-5 "facts" (Appearance, Habitat, Behavior, Diet, and Size or Safety when relevant), each one short sentence, and tie a fact to what is visible in the photo when you can (e.g. "swimming in pairs, as in your photo").
If you are not sure, give your best guess with confidence "low" and name likely look-alikes in "note".
If no fish is visible, set found=false, leave the name fields empty, and explain briefly in "summary".`;

const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/;

// Turns a phone locale like "es-MX" into an instruction such as "Spanish (Mexico)".
function languageInstruction(lang) {
  if (typeof lang !== "string" || !LANG_RE.test(lang) || /^en\b/i.test(lang)) return "";
  let name = lang;
  try {
    const [base, region] = lang.split("-");
    const langName = new Intl.DisplayNames(["en"], { type: "language" }).of(base);
    const regionName = region && region.length === 2 ? new Intl.DisplayNames(["en"], { type: "region" }).of(region.toUpperCase()) : "";
    name = regionName ? `${langName} (${regionName})` : langName;
  } catch {}
  return `\nReply language: ${name} [${lang}]. Write summary, facts[].text, facts[].short, note and other_names in ${name}.
For common_name only: use the ${name} name if you are sure it is the established name for this exact species; if not, use the English name there (never invent a name). Even then, every other text field stays in ${name}.
Keep scientific_name in Latin, and keep the "label" and "confidence" values exactly as the English enum values.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const { image, mediaType, lang } = req.body ?? {};
  const prompt = PROMPT + languageInstruction(lang);
  if (typeof image !== "string" || !image || !ALLOWED_TYPES.has(mediaType)) {
    return res.status(400).json({ error: "Send { image: <base64>, mediaType: 'image/jpeg' }" });
  }
  if (image.length > MAX_BASE64_CHARS) {
    return res.status(413).json({ error: "Image too large" });
  }

  try {
    const result = process.env.GEMINI_API_KEY
      ? await askGemini(image, mediaType, prompt)
      : await askClaude(image, mediaType, prompt);
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

async function askClaude(image, mediaType, prompt) {
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
          { type: "text", text: prompt },
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

async function askGemini(image, mediaType, prompt) {
  const started = Date.now();
  let statuses = [];

  // Up to two rounds: if every model is busy, wait a moment and race them again.
  for (let round = 0; round < 2; round++) {
    const left = GEMINI_DEADLINE_MS - (Date.now() - started);
    if (left < 3000) break;
    const stop = new AbortController();
    const attempts = GEMINI_MODELS.map(async (model) => {
      const r = await callGemini(model, image, mediaType, prompt, Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, left), stop.signal);
      if (!r.ok) {
        if (r.detail !== "cancelled") console.warn(`Gemini ${model} failed (${r.status}): ${r.detail}`);
        throw r;
      }
      console.log(`Gemini ${model} answered in ${Date.now() - started} ms`);
      return r.result;
    });
    try {
      const result = await Promise.any(attempts);
      stop.abort(); // cancel the slower requests
      return result;
    } catch (err) {
      const errors = err instanceof AggregateError ? err.errors : [err];
      const fatal = errors.find((e) => e instanceof ProviderError);
      if (fatal) throw fatal;
      statuses = errors.map((e) => e.status);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  if (statuses.length && statuses.every((s) => s === 429)) {
    throw new ProviderError(429, "Free daily limit reached. Try again later.");
  }
  throw new ProviderError(503, "The fish expert is busy right now. Please try again in a minute.");
}

async function callGemini(model, image, mediaType, prompt, timeoutMs, cancel) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      signal: AbortSignal.any([cancel, AbortSignal.timeout(Math.max(timeoutMs, 1000))]),
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA,
        },
      }),
    });
  } catch (err) {
    return { ok: false, status: 0, detail: err.name === "TimeoutError" ? "timeout" : err.name === "AbortError" ? "cancelled" : err.message };
  }

  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    if (r.status === 400 || r.status === 403) {
      // Bad key or bad request: switching models won't help.
      throw new ProviderError(502, "The fish expert is unavailable right now.", `Gemini ${r.status}: ${detail}`);
    }
    return { ok: false, status: r.status, detail };
  }

  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) {
    return { ok: true, result: { status: 422, body: { error: "Sorry, this photo couldn't be analyzed." } } };
  }
  return { ok: true, result: { status: 200, body: JSON.parse(text) } };
}
