# 0xwork-quality-api

x402-gated quality-check API for 0xWork task submissions, with a Telegram bot front-end and a Mini App for wallet payments.

## What it does

A task poster sends a submission to the Telegram bot. The bot opens a Mini App that pairs the poster's wallet (WalletConnect) and pays the API in USDC on Base via x402. The API runs deterministic heuristics, calls Groq (Llama 3.3 70B) to grade the submission against the task requirements, and returns a verdict: `approve` / `review` / `reject` with cited evidence.

## Architecture

```
   Telegram chat                  Mini App (browser)             API (Render)
   ─────────────                  ─────────────────              ─────────────
   /start                                                    
   [submission text]                                         
        │                                                   
        └──> bot stores ctx ──> open Mini App ──>  WalletConnect pair
                                                   │
                                                   sign x402 payment
                                                   │
                                                   POST /check + X-PAYMENT header ─> facilitator verifies
                                                                                    │
                                                                                    heuristics + Groq grade
                                                                                    │
                                                   verdict JSON  <─────────────────┘
                                                   │
        <── WebApp.sendData(verdict) ──┘
   verdict rendered in chat
```

## Status

Writing-task grader only. Code / research / social endpoints deferred until v2. Originality detection deferred (needs a corpus + simhash/pgvector — separate product).

## Local dev

```bash
cp .env.example .env
# fill in GROQ_API_KEY (free at console.groq.com)
# leave X402_BYPASS=true so you don't need a wallet to test

npm install
npm run dev      # API on :3000
npm run dev:bot  # Telegram bot (needs TELEGRAM_BOT_TOKEN)
```

Smoke test the API:

```bash
curl -X POST http://localhost:3000/check \
  -H "Content-Type: application/json" \
  -d '{
    "task_type": "writing",
    "tier": "full",
    "requirements": {
      "title": "Write a 500-word explainer on x402",
      "word_count": 500,
      "topic_keywords": ["x402", "payment", "HTTP"]
    },
    "submission": "x402 is an open standard for...[your text]"
  }'
```

With `X402_BYPASS=true`, the request returns a verdict without payment.
With `X402_BYPASS=false`, the request returns HTTP 402 with payment details.

## Deploying to Render

The free plan spins down after 15 min idle (~50s cold start). Mitigate with a free external pinger like cron-job.org hitting `/healthz` every 14 min.

1. Push this repo to GitHub
2. Render → New → Blueprint → point at this repo (uses `render.yaml`)
3. Fill the `sync: false` env vars in the Render dashboard:
   - `GROQ_API_KEY`
   - `X402_PAY_TO` (your Base wallet address)
   - `TELEGRAM_BOT_TOKEN`
   - `MINIAPP_URL` (Cloudflare Pages URL for `miniapp/`)
   - `API_BASE_URL` (the API service's public URL)
4. Set `X402_BYPASS=false` in production
5. Add the cron-job.org keep-alive

## Mini App hosting

Deploy `miniapp/` to Cloudflare Pages (free, no cold starts) or as a static site on Render. Set `MINIAPP_URL` to that public URL, then register it with @BotFather:

```
/setmenubutton → pick bot → label: "Grade submission" → URL: https://your-miniapp.example.com
```

## TODO before production

- [ ] Wire real `x402-express` facilitator verification (currently a stub middleware in `src/middleware/x402.js`)
- [ ] Real WalletConnect integration in `miniapp/app.js` (currently a mock flow)
- [ ] Confirm Groq's current TOS allows commercial use of the free tier — fallback is Gemini 2.0 Flash free tier
- [ ] Rate limit `/check` (currently no limits)
- [ ] Persist a submission hash to a tiny KV / sqlite for repeat-detection (deferred)
