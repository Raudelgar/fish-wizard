# 🐠 Fish Wizard

Snap or upload a photo of a fish and get a quick ID card: common name, scientific name, and a few key facts (appearance, habitat, behavior, diet).

- `public/index.html`: mobile-first page. It resizes the photo in the browser (which also converts iPhone HEIC to JPEG) and shows the result as a card.
- `api/identify.js`: Vercel serverless function that sends the image to Claude and returns structured JSON.

## Deploy (Vercel, about 2 minutes)

1. Get an API key at <https://console.anthropic.com>.
2. On <https://vercel.com/new>, import this GitHub repo. No build settings are needed.
3. Under **Environment Variables**, add `ANTHROPIC_API_KEY`.
4. Click **Deploy** and open the URL on your phone. In Safari, tap Share → **Add to Home Screen** to get an app-like icon.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npx vercel dev
```

## Roadmap

- v1: photos ✅
- v2: video (sample a few frames and send them as images)
- v3: iOS Share Sheet / Shortcut, so you can tap Share in Photos and get the answer as a bubble
