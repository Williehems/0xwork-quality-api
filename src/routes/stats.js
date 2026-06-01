import { getGradeStats } from "../../db/index.js";
import { config } from "../config.js";
import * as settings from "../settings.js";

const LOGO_SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style="width:22px;height:22px;border-radius:5px;overflow:hidden;vertical-align:middle;flex-shrink:0"><rect width="512" height="512" fill="#17212B"/><rect x="96" y="402" width="320" height="38" rx="19" fill="#3390EC"/><g transform="rotate(-10 256 256)"><rect x="242" y="72" width="28" height="232" rx="14" fill="#3390EC"/><rect x="148" y="288" width="216" height="88" rx="22" fill="#3390EC"/></g></svg>`;

function pct(n, total) {
  if (!total) return "0";
  return ((n / total) * 100).toFixed(1);
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function renderHtml(stats, price, payTo, bypass) {
  const { total, approved, review, rejected, usdc_collected, by_type, last_graded_at, first_graded_at } = stats;
  const approvalRate = pct(approved, total);

  const typeRows = (by_type ?? []).map(({ task_type, count }) => `
    <tr>
      <td>${task_type}</td>
      <td class="num">${count}</td>
      <td class="num dim">${pct(count, total)}%</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gavel Stats</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "SF Mono", "Fira Code", "Consolas", monospace;
    background: #080808;
    color: #e0e0e0;
    min-height: 100vh;
    padding: 2.5rem 1.5rem;
    border-top: 2px solid #3390EC;
  }
  .wrap { max-width: 640px; margin: 0 auto; }

  .header { margin-bottom: 2.5rem; }
  .header-eyebrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.68rem;
    color: #3390EC;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-bottom: 0.5rem;
    text-decoration: none;
  }
  .header-eyebrow:hover { opacity: 0.75; }
  .header-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .header-sub {
    margin-top: 0.4rem;
    font-size: 0.78rem;
    color: #555;
  }
  .header-sub a { color: #555; text-decoration: none; }
  .header-sub a:hover { color: #888; }

  /* big numbers */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: #1a1a1a;
    border: 1px solid #1a1a1a;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 1.75rem;
    box-shadow: 0 4px 32px rgba(51,144,236,0.06);
  }
  .kpi {
    background: #0f0f0f;
    padding: 1.4rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .kpi-label {
    font-size: 0.62rem;
    color: #555;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .kpi-value {
    font-size: 2.4rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .kpi-value.green {
    color: #00ff88;
    text-shadow: 0 0 28px rgba(0,255,136,0.3);
  }
  .kpi-sub {
    font-size: 0.7rem;
    color: #555;
    margin-top: 3px;
  }

  /* verdict breakdown */
  .section { margin-bottom: 2rem; }
  .section-title {
    font-size: 0.62rem;
    color: #555;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 0.9rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #1a1a1a;
  }

  .verdict-bars { display: flex; flex-direction: column; gap: 0.75rem; }
  .verdict-bar-row { display: flex; align-items: center; gap: 0.75rem; }
  .verdict-bar-label {
    font-size: 0.72rem;
    color: #888;
    width: 60px;
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .verdict-bar-track {
    flex: 1;
    height: 8px;
    background: #161616;
    border-radius: 4px;
    overflow: hidden;
  }
  .verdict-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.7s ease;
  }
  .fill-approve { background: #00c854; box-shadow: 0 0 10px rgba(0,200,84,0.5); }
  .fill-review  { background: #e6a700; box-shadow: 0 0 10px rgba(230,167,0,0.45); }
  .fill-reject  { background: #e63030; box-shadow: 0 0 10px rgba(230,48,48,0.45); }
  .verdict-bar-count {
    font-size: 0.75rem;
    color: #666;
    width: 36px;
    text-align: right;
    flex-shrink: 0;
  }
  .verdict-bar-pct {
    font-size: 0.7rem;
    color: #444;
    width: 42px;
    text-align: right;
    flex-shrink: 0;
  }

  /* tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  td, th {
    padding: 0.55rem 0.6rem;
    text-align: left;
    border-bottom: 1px solid #131313;
  }
  th {
    font-size: 0.62rem;
    color: #555;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    border-bottom-color: #1a1a1a;
  }
  td { color: #bbb; }
  td.num { text-align: right; color: #999; }
  td.dim { color: #444; }
  tr:last-child td { border-bottom: none; }

  /* config meta */
  .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: #1a1a1a;
    border: 1px solid #1a1a1a;
    border-radius: 6px;
    overflow: hidden;
  }
  .meta-cell {
    background: #0d0d0d;
    padding: 0.9rem 1.1rem;
  }
  .meta-key {
    font-size: 0.6rem;
    color: #555;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.35rem;
  }
  .meta-val {
    font-size: 0.82rem;
    color: #ccc;
    word-break: break-all;
  }
  .meta-val.green { color: #00ff88; }
  .meta-val.warn  { color: #e6a700; }

  .footer {
    margin-top: 2.5rem;
    font-size: 0.68rem;
    color: #333;
  }
  .footer a { color: #444; text-decoration: none; }
  .footer a:hover { color: #666; }

  @media (max-width: 480px) {
    .kpi-row { grid-template-columns: 1fr 1fr; }
    .meta-grid { grid-template-columns: 1fr; }
    .kpi-value { font-size: 2rem; }
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="header">
    <a href="/" class="header-eyebrow">${LOGO_SVG} Gavel</a>
    <div class="header-title">Grading Stats</div>
    <div class="header-sub">Live data · <a href="/stats.json">JSON</a></div>
  </div>

  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-label">Grades run</div>
      <div class="kpi-value">${total ?? 0}</div>
      <div class="kpi-sub">since ${fmtDate(first_graded_at)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Approval rate</div>
      <div class="kpi-value green">${approvalRate}%</div>
      <div class="kpi-sub">${approved ?? 0} approved</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">USDC collected</div>
      <div class="kpi-value">${Number(usdc_collected ?? 0).toFixed(2)}</div>
      <div class="kpi-sub">${bypass ? "payments paused" : `$${price}/grade`}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Verdict breakdown</div>
    <div class="verdict-bars">
      <div class="verdict-bar-row">
        <span class="verdict-bar-label">Approve</span>
        <div class="verdict-bar-track"><div class="verdict-bar-fill fill-approve" style="width:${pct(approved, total)}%"></div></div>
        <span class="verdict-bar-count">${approved ?? 0}</span>
        <span class="verdict-bar-pct">${pct(approved, total)}%</span>
      </div>
      <div class="verdict-bar-row">
        <span class="verdict-bar-label">Review</span>
        <div class="verdict-bar-track"><div class="verdict-bar-fill fill-review" style="width:${pct(review, total)}%"></div></div>
        <span class="verdict-bar-count">${review ?? 0}</span>
        <span class="verdict-bar-pct">${pct(review, total)}%</span>
      </div>
      <div class="verdict-bar-row">
        <span class="verdict-bar-label">Reject</span>
        <div class="verdict-bar-track"><div class="verdict-bar-fill fill-reject" style="width:${pct(rejected, total)}%"></div></div>
        <span class="verdict-bar-count">${rejected ?? 0}</span>
        <span class="verdict-bar-pct">${pct(rejected, total)}%</span>
      </div>
    </div>
  </div>

  ${typeRows ? `<div class="section">
    <div class="section-title">By task type</div>
    <table>
      <thead><tr><th>Type</th><th style="text-align:right">Grades</th><th style="text-align:right">Share</th></tr></thead>
      <tbody>${typeRows}</tbody>
    </table>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Config</div>
    <div class="meta-grid">
      <div class="meta-cell">
        <div class="meta-key">Pay-to wallet</div>
        <div class="meta-val">${payTo || "—"}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-key">Price per grade</div>
        <div class="meta-val ${bypass ? "warn" : "green"}">${bypass ? "free (bypass on)" : `$${price} USDC`}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-key">Network</div>
        <div class="meta-val">${config.x402.network}</div>
      </div>
      <div class="meta-cell">
        <div class="meta-key">Last graded</div>
        <div class="meta-val">${fmtDate(last_graded_at)}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <a href="/">home</a> &nbsp;·&nbsp;
    <a href="/stats.json">json</a> &nbsp;·&nbsp;
    <a href="/healthz">healthz</a> &nbsp;·&nbsp;
    <a href="https://t.me/Oxwork_quality_bot" target="_blank">telegram</a>
  </div>

</div>
</body>
</html>`;
}

export async function statsRoute(req, res, next) {
  try {
    const json = req.path.endsWith(".json") || req.headers.accept?.includes("application/json");
    const bypass = config.x402.bypass;
    const price  = settings.get("price", config.pricing.full);
    const payTo  = config.x402.payTo;

    const stats = await getGradeStats();

    if (json) {
      return res.json({
        total:          stats.total ?? 0,
        approved:       stats.approved ?? 0,
        review:         stats.review ?? 0,
        rejected:       stats.rejected ?? 0,
        approval_rate:  stats.total ? Number(pct(stats.approved, stats.total)) : 0,
        usdc_collected: Number(stats.usdc_collected ?? 0),
        by_type:        stats.by_type ?? [],
        pay_to:         payTo,
        price_usdc:     parseFloat(price),
        payments_live:  !bypass,
        last_graded_at: stats.last_graded_at ?? null,
        first_graded_at: stats.first_graded_at ?? null,
      });
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.send(renderHtml(stats, price, payTo, bypass));
  } catch (err) {
    next(err);
  }
}
