# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm start              # prod: combined bot + API on $PORT (default 3001)
npm run dev            # same, with node --watch
npm run dev:api-only   # API-only on :3000 (no Telegram polling)
npm run migrate        # apply db/schema.sql to $DATABASE_URL
```

No test suite, no linter, no build step — pure ESM, Node ≥20.

Smoke-test `/check` directly (bypass mode, no payment):

```bash
curl -X POST http://localhost:3001/check -H "content-type: application/json" -d '{
  "task_type":"writing","tier":"full",
  "requirements":{"title":"...","topic_keywords":["..."]},
  "submission":"..."
}'
```

## Architecture

The default entrypoint `bot/index.js` runs **everything on one Express server**: Telegram bot (long-polling via grammy), Mini App static files at `/app/*`, session lookup at `/session/:id`, verdict delivery at `/verdict/:sessionId`, and the API (`createApiApp()` from `src/app.js` providing `/healthz` + `/check`). `src/index.js` is the API-only standalone — only used by `npm run dev:api-only`; prod doesn't run it.

Request flow for a graded task:

1. **Telegram → bot.** `/inbox` lists the poster's Submitted tasks from `api.0xwork.org`; the poster picks one, pastes the submission text, confirms the inferred rubric. Bot creates a session in an in-memory `Map` (30-min TTL, evicted by an interval timer at `bot/index.js:75`).
2. **Bot → Mini App.** Confirm callback edits the message to attach an `InlineKeyboard().webApp(url)` button pointing to `${MINIAPP_URL}?session=<id>&wcProjectId=<id>&_v=<BUILD_TOKEN>`.
3. **Mini App.** Fetches `/session/<id>`, POSTs `/check` with no payment header. If 200 (bypass mode) it skips WalletConnect entirely. If 402 it lazy-imports `@walletconnect/ethereum-provider` from esm.sh, pairs the wallet, signs an EIP-3009 `TransferWithAuthorization` via `miniapp/x402-client.js`, retries `/check` with the base64-JSON `X-PAYMENT` header.
4. **Verdict delivery.** Mini App POSTs the verdict to `/verdict/:sessionId`; the bot looks up `session.userId` and sends the rendered verdict via `bot.api.sendMessage`, then closes the WebView.

### Why `/verdict` exists (don't "fix" it back to sendData)

The Mini App is opened from an **inline keyboard button**, not a reply keyboard or Menu Button. Telegram's `tg.sendData()` only delivers `web_app_data` for the latter two — for inline-keyboard mini apps it silently no-ops. The HTTP POST to `/verdict/:sessionId` is the workaround. `bot.on("message")` still has a `web_app_data` handler for completeness but in practice it never fires.

### Grader (`src/grader/`)

`grade()` dispatches deterministic heuristics by `task_type` (`writing` / `code` / `research` / `data` / `social`) from `heuristics/`, then calls Groq (Llama 3.3 70B via `groq-sdk`) with the heuristics injected into the prompt. Returns `{ verdict: approve|review|reject, reasoning, evidence, ... }`. If Groq fails or `GROQ_API_KEY` is unset, falls back to a heuristic-only verdict (`fallback: true`). Tier `fast` always skips the LLM.

### x402 middleware

`src/middleware/x402.js` mounts `x402-express`'s `paymentMiddleware` on `POST /check`. When `X402_BYPASS=true`, replaced with a no-op shim that marks `req.x402 = { bypassed: true }` so the route handler still populates the response cleanly. **Production currently runs with `X402_BYPASS=true`** (see `render.yaml`) — flipping it off requires `X402_PAY_TO` set in the Render dashboard and the Mini App passing real payment headers.

## Non-obvious gotchas

- **WalletConnect chain config**: use `optionalChains: [84532]`, not `chains: [84532]`. MetaMask Mobile silently rejects pairings that require a chain the wallet isn't configured for.
- **Universal-link button**: `$wcOpen.onclick` calls `tg.openLink(universalLink)` — `target="_blank"` is swallowed by Telegram's WebView.
- **Mini App cache-busting**: Telegram's WebView caches HTML aggressively. The bot appends `&_v=<BUILD_TOKEN>` (random per process) to Mini App URLs; `/app/*` is served `Cache-Control: no-store`; `miniapp/index.html` versions its script as `app.js?v=N` — **bump this version when changing `miniapp/app.js`** or the WebView may serve a stale bundle.
- **0xwork `/tasks?poster_address=` filter is ignored server-side.** `src/zerox/client.js:listInReviewByPoster` pulls a wider page and filters client-side; don't trust the param.
- **Session storage is in-memory only.** Bot restart = all in-flight sessions die. The Mini App returns a specific "session not found — it expired or the bot restarted" error for 404 on `/session/:id`.
- **`DATABASE_URL` is only used by `/wallet`** (Neon Postgres, `wallet_bindings` table). The core grading flow runs without it.
- **Render free plan**: spins down after 15 min idle, ~50s cold start; cron-job.org pings `/healthz` every 14 min to keep it warm. Only one `getUpdates` poller per bot — on redeploy the new instance retries polling until the old one's TCP connection dies (handled in `bot/index.js` startup tail).
- **`tg.openLink` only exists in real Telegram** — when stubbing for tests, the click handler at `miniapp/app.js:162` falls back to default anchor behavior.
