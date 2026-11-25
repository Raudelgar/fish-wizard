# 🐠 Fish Wizard

Snap or upload a photo of a fish and get a quick ID card: common name, scientific name, and a few key facts (appearance, habitat, behavior, diet).

- `public/index.html`: mobile-first page. It resizes the photo in the browser (which also converts iPhone HEIC to JPEG) and shows the result as a card.
- `api/identify.js`: Vercel serverless function that sends the image to an AI model and returns structured JSON. It uses **Gemini** when `GEMINI_API_KEY` is set, otherwise **Claude**.

## Deploy for free (Vercel + Gemini free tier, about 2 minutes)

1. Get a free Gemini API key at <https://aistudio.google.com/apikey> (sign in with Google; no credit card).
2. On <https://vercel.com/new>, sign in with GitHub (Hobby plan is free) and import this repo. No build settings are needed.
3. Under **Environment Variables**, add `GEMINI_API_KEY`.
4. Click **Deploy** and open the URL on your phone. In Safari, tap Share → **Add to Home Screen** to get an app-like icon.

Notes on the free tier: it has daily request limits (plenty for personal use), and Google may use free-tier inputs to improve its products. If a model is busy or out of free quota, the app automatically tries the next one (`gemini-flash-latest`, then `gemini-flash-lite-latest`, then `gemini-3.1-flash-lite`). Optional: override the list with `GEMINI_MODELS` (comma-separated).

### Using Claude instead

Set `ANTHROPIC_API_KEY` (from <https://console.anthropic.com>) and leave `GEMINI_API_KEY` unset. This is paid per use, roughly a cent or less per photo.

## Run locally

```bash
npm install
GEMINI_API_KEY=... npx vercel dev   # or ANTHROPIC_API_KEY=...
```

## Roadmap

- v1: photos ✅
- v2: video (sample a few frames and send them as images)
- v3: iOS Share Sheet / Shortcut, so you can tap Share in Photos and get the answer as a bubble
