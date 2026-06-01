import { config } from "../config.js";
import * as settings from "../settings.js";

const LOGO_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#17212B"/>
  <rect x="96" y="402" width="320" height="38" rx="19" fill="#3390EC"/>
  <g transform="rotate(-10 256 256)">
    <rect x="242" y="72" width="28" height="232" rx="14" fill="#3390EC"/>
    <rect x="148" y="288" width="216" height="88" rx="22" fill="#3390EC"/>
  </g>
</svg>`;

function renderHome(model, bypass) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gavel — AI Grader for 0xWork</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "SF Mono", "Fira Code", "Consolas", monospace;
    background: #080808;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 1.5rem;
  }

  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 480px;
    width: 100%;
  }

  .logo {
    width: 80px;
    height: 80px;
    border-radius: 18px;
    overflow: hidden;
    margin-bottom: 1.5rem;
    flex-shrink: 0;
  }
  .logo svg { width: 100%; height: 100%; display: block; }

  .title {
    font-size: 2rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
  }
  .tagline {
    font-size: 0.82rem;
    color: #555;
    letter-spacing: 0.04em;
    margin-bottom: 2.5rem;
  }

  .ctas {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 3rem;
    flex-wrap: wrap;
    justify-content: center;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 10px 20px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-decoration: none;
    text-transform: uppercase;
    transition: opacity 0.15s;
  }
  .cta:hover { opacity: 0.8; }
  .cta-primary {
    background: #3390EC;
    color: #fff;
  }
  .cta-secondary {
    background: transparent;
    color: #555;
    border: 1px solid #222;
  }
  .cta-secondary:hover { color: #aaa; border-color: #444; }

  .steps {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid #151515;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 3rem;
  }
  .step {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem 1.1rem;
    border-bottom: 1px solid #111;
    text-align: left;
  }
  .step:last-child { border-bottom: none; }
  .step-num {
    font-size: 0.65rem;
    color: #3390EC;
    font-weight: 700;
    letter-spacing: 0.1em;
    padding-top: 2px;
    flex-shrink: 0;
    width: 20px;
  }
  .step-body {}
  .step-title {
    font-size: 0.8rem;
    color: #ddd;
    font-weight: 700;
    margin-bottom: 2px;
  }
  .step-desc {
    font-size: 0.72rem;
    color: #444;
    line-height: 1.5;
  }

  .meta {
    font-size: 0.65rem;
    color: #2a2a2a;
    letter-spacing: 0.06em;
    text-align: center;
    line-height: 1.8;
  }
  .meta a { color: #333; text-decoration: none; }
  .meta a:hover { color: #555; }
</style>
</head>
<body>
<div class="hero">

  <div class="logo">${LOGO_SVG}</div>

  <div class="title">Gavel</div>
  <div class="tagline">AI grader for 0xWork submissions</div>

  <div class="ctas">
    <a class="cta cta-primary" href="/stats">→ Stats</a>
    <a class="cta cta-secondary" href="https://t.me/Oxwork_quality_bot" target="_blank">Open in Telegram ↗</a>
  </div>

  <div class="steps">
    <div class="step">
      <div class="step-num">01</div>
      <div class="step-body">
        <div class="step-title">Worker submits proof</div>
        <div class="step-desc">Poster picks a submitted task from /inbox — Gavel fetches the proof URL automatically.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">02</div>
      <div class="step-body">
        <div class="step-title">Gavel grades in ~3s</div>
        <div class="step-desc">Heuristics + ${model} return a verdict: Approve, Review, or Reject — with reasoning, strengths, and concerns.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-num">03</div>
      <div class="step-body">
        <div class="step-title">Poster approves or disputes on-chain</div>
        <div class="step-desc">One tap releases the bounty or opens a 48-hour dispute window on Base mainnet via TaskPoolV4.</div>
      </div>
    </div>
  </div>

  <div class="meta">
    Base mainnet &nbsp;·&nbsp; ${model} &nbsp;·&nbsp; ${bypass ? "payments paused" : "x402 micropayments"}<br>
    <a href="/stats">stats</a> &nbsp;·&nbsp; <a href="/healthz">healthz</a> &nbsp;·&nbsp; <a href="https://zeroxwork-quality-api.onrender.com">zeroxwork-quality-api.onrender.com</a>
  </div>

</div>
</body>
</html>`;
}

export async function homeRoute(req, res) {
  const model  = settings.get("groq_model", config.groq.model);
  const bypass = config.x402.bypass;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(renderHome(model, bypass));
}
