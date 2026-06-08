/**
 * gavel-widget.js — embeddable AI quality review widget for 0xwork
 *
 * Usage:
 *   <div id="gavel-root"></div>
 *   <script src="gavel-widget.js"></script>
 *   <script>
 *     GavelWidget.init({
 *       container: '#gavel-root',
 *       apiUrl: 'https://zeroxwork-quality-api.onrender.com',
 *       wallet: { address: '0xe330…', provider: window.ethereum },
 *       task: {
 *         type: 'research',           // writing|code|research|data|social
 *         title: 'Task title',
 *         description: 'What was asked',
 *         requirements: { topic_keywords: ['...'], notes: '...' },
 *         submission: 'Worker submission text',
 *         proofUrl: 'https://...',    // optional
 *       },
 *       onVerdict: (verdict) => {},   // { verdict, confidence, reasoning, strengths, concerns }
 *       onError:   (err)     => {},   // optional
 *     });
 *   </script>
 */

(function (global) {
  'use strict';

  // ─────────────────────────────────────────────
  // Styles (injected once)
  // ─────────────────────────────────────────────
  const CSS = `
.gv-widget {
  font-family: "SF Mono","Fira Code",monospace;
  border: 1px solid #ddd;
  border-radius: 5px;
  overflow: hidden;
  transition: border-color 0.25s;
}
.gv-widget--active { border-color: #3390EC; }

/* ── Header ── */
.gv-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 7px 12px;
  background: #f8f8f8;
  border-bottom: 1px solid #eee;
}
.gv-head-icon {
  width: 20px; height: 20px;
  border-radius: 4px;
  background: #17212B;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.gv-head-icon svg { width: 13px; height: 13px; }
.gv-head-name {
  font-size: 0.63rem;
  font-weight: 700;
  color: #888;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.gv-head-meta {
  margin-left: auto;
  font-size: 0.62rem;
  color: #bbb;
}
.gv-head-meta a { color: #3390EC; text-decoration: none; }

/* ── Idle ── */
.gv-idle {
  padding: 18px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.gv-idle-icon {
  width: 44px; height: 44px;
  border-radius: 8px;
  background: linear-gradient(135deg,#17212B 0%,#2a3a4f 100%);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.gv-idle-icon svg { width: 24px; height: 24px; }
.gv-idle-text { flex: 1; min-width: 0; }
.gv-idle-title {
  font-size: 0.92rem;
  font-weight: 800;
  color: #111;
  letter-spacing: -0.01em;
  margin-bottom: 2px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-idle-sub {
  font-size: 0.74rem;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gv-idle-sub .gv-wallet { color: #00a832; font-weight: 700; }
.gv-btn-grade {
  background: #00d4e0;
  color: #000;
  font-size: 0.82rem;
  font-weight: 700;
  padding: 9px 18px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  letter-spacing: 0.02em;
  flex-shrink: 0;
  transition: background 0.15s, transform 0.1s;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-btn-grade:hover { background: #00bcc7; }
.gv-btn-grade:active { transform: scale(0.97); }
.gv-btn-grade:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

/* ── Signing ── */
.gv-signing {
  padding: 20px 16px;
  text-align: center;
  background: #fffef5;
}
.gv-signing-spinner {
  width: 28px; height: 28px;
  border: 3px solid #f0e0a0;
  border-top-color: #d4a200;
  border-radius: 50%;
  animation: gv-spin 0.9s linear infinite;
  margin: 0 auto 10px;
}
.gv-signing-title {
  font-size: 0.85rem;
  font-weight: 800;
  color: #5a4a00;
  margin-bottom: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-signing-sub { font-size: 0.72rem; color: #888; }

/* ── Grading ── */
.gv-grading {
  padding: 20px 16px;
  text-align: center;
  background: #f8f8ff;
}
.gv-grading-bar {
  height: 4px;
  background: #e0e0ff;
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 10px;
}
.gv-grading-fill {
  height: 100%;
  width: 30%;
  background: linear-gradient(90deg, #3390EC, #00d4e0);
  animation: gv-grading-slide 1.4s ease-in-out infinite;
}
.gv-grading-title {
  font-size: 0.85rem;
  font-weight: 800;
  color: #1a4a8a;
  margin-bottom: 2px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-grading-sub { font-size: 0.72rem; color: #888; }

/* ── Verdict ── */
.gv-verdict-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 14px;
  border-bottom: 1px solid #eee;
}
.gv-verdict-row--approve { background: #f3fff6; border-bottom-color: #e0f5e6; }
.gv-verdict-row--review  { background: #fffbf0; border-bottom-color: #f5edcc; }
.gv-verdict-row--reject  { background: #fff5f5; border-bottom-color: #fde0e0; }

.gv-verdict-chip {
  width: 32px; height: 32px;
  border-radius: 5px;
  color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.95rem;
  font-weight: 800;
  flex-shrink: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-verdict-chip--approve { background: #00c836; }
.gv-verdict-chip--review  { background: #e09000; }
.gv-verdict-chip--reject  { background: #e60000; }

.gv-verdict-text { flex: 1; }
.gv-verdict-main {
  font-size: 0.96rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  text-transform: uppercase;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-verdict-main--approve { color: #007222; }
.gv-verdict-main--review  { color: #7a5000; }
.gv-verdict-main--reject  { color: #900; }
.gv-verdict-conf { font-size: 0.7rem; color: #888; margin-top: 1px; }
.gv-verdict-model { font-size: 0.62rem; color: #aaa; text-align: right; line-height: 1.5; }
.gv-verdict-model a { color: #3390EC; text-decoration: none; }

.gv-body { padding: 12px 14px; }
.gv-conf-bar {
  height: 5px;
  background: #ebebeb;
  border-radius: 3px;
  margin-bottom: 12px;
  overflow: hidden;
}
.gv-conf-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.7s ease;
}
.gv-conf-fill--approve { background: #00c836; }
.gv-conf-fill--review  { background: #e09000; }
.gv-conf-fill--reject  { background: #e60000; }

.gv-reasoning {
  font-size: 0.79rem;
  color: #333;
  line-height: 1.6;
  margin-bottom: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-bullets { margin-bottom: 8px; }
.gv-bullets-title {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.gv-bullets--strengths .gv-bullets-title { color: #007222; }
.gv-bullets--concerns  .gv-bullets-title { color: #b30000; }
.gv-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 3px; }
.gv-list li {
  font-size: 0.79rem;
  color: #444;
  display: flex;
  gap: 5px;
  line-height: 1.45;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-list li .gv-blt { flex-shrink: 0; font-weight: 700; }
.gv-bullets--strengths .gv-blt { color: #00c836; }
.gv-bullets--concerns  .gv-blt { color: #e60000; }

.gv-actions {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid #eee;
  background: #fafafa;
}
.gv-btn-action {
  flex: 1;
  padding: 9px 14px;
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  letter-spacing: 0.02em;
  border: none;
  transition: background 0.15s, transform 0.1s;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-btn-action:active { transform: scale(0.97); }
.gv-btn-approve { background: #00c836; color: #fff; }
.gv-btn-approve:hover { background: #00a82e; }
.gv-btn-dispute { background: #fff; color: #b30000; border: 1.5px solid #e60000; }
.gv-btn-dispute:hover { background: #fff5f5; }

/* ── Error ── */
.gv-error {
  padding: 16px;
  background: #fff5f5;
  border-top: 2px solid #e60000;
  font-size: 0.78rem;
  color: #900;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-error-msg { flex: 1; }
.gv-btn-retry {
  background: #fff;
  color: #900;
  border: 1.5px solid #e60000;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 5px 12px;
  cursor: pointer;
  flex-shrink: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.gv-btn-retry:hover { background: #fff5f5; }

@keyframes gv-spin { to { transform: rotate(360deg); } }
@keyframes gv-grading-slide {
  0%   { transform: translateX(-100%); width: 30%; }
  50%  { transform: translateX(150%);  width: 30%; }
  100% { transform: translateX(330%);  width: 30%; }
}
`;

  // ─────────────────────────────────────────────
  // x402 helpers (ported from miniapp/x402-client.js)
  // ─────────────────────────────────────────────
  function randomNonce32() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let hex = '0x';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  async function signX402Authorization(provider, address, reqSpec) {
    const CHAIN_IDS = { 'base-sepolia': 84532, 'base': 8453 };
    const chainId = CHAIN_IDS[reqSpec.network];
    if (!chainId) throw new Error('Unknown x402 network: ' + reqSpec.network);

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: address,
      to: reqSpec.payTo,
      value: String(reqSpec.maxAmountRequired),
      validAfter: '0',
      validBefore: String(now + 600),
      nonce: randomNonce32(),
    };

    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      domain: {
        name: reqSpec.extra?.name ?? 'USDC',
        version: reqSpec.extra?.version ?? '2',
        chainId,
        verifyingContract: reqSpec.asset,
      },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    };

    const signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(typedData)],
    });

    return btoa(JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: reqSpec.network,
      payload: { signature, authorization },
    }));
  }

  // ─────────────────────────────────────────────
  // HTML templates
  // ─────────────────────────────────────────────
  const HAMMER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#3390EC" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 4 4 14 M16 6 18 4 M18 8 22 4 M10 12 14 16 M20 10 14 16"/>
  </svg>`;

  function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  function tplHeader(apiUrl) {
    return `
<div class="gv-head">
  <div class="gv-head-icon">${HAMMER_SVG}</div>
  <span class="gv-head-name">AI Quality Review</span>
  <span class="gv-head-meta">powered by <a href="${apiUrl}" target="_blank" rel="noopener">gavel</a></span>
</div>`;
  }

  function tplIdle(address, price) {
    return `
<div class="gv-idle">
  <div class="gv-idle-icon">${HAMMER_SVG}</div>
  <div class="gv-idle-text">
    <div class="gv-idle-title">Grade this submission with Gavel</div>
    <div class="gv-idle-sub">$${price} USDC · signed by <span class="gv-wallet">${shortAddr(address)}</span></div>
  </div>
  <button class="gv-btn-grade" data-gv="grade">Grade with Gavel</button>
</div>`;
  }

  function tplSigning(price) {
    return `
<div class="gv-signing">
  <div class="gv-signing-spinner"></div>
  <div class="gv-signing-title">Waiting for your wallet signature…</div>
  <div class="gv-signing-sub">EIP-3009 TransferWithAuthorization · ${price} USDC</div>
</div>`;
  }

  function tplGrading() {
    return `
<div class="gv-grading">
  <div class="gv-grading-bar"><div class="gv-grading-fill"></div></div>
  <div class="gv-grading-title">Grading submission…</div>
  <div class="gv-grading-sub">heuristics · llama 3.3 70B · proof fetch</div>
</div>`;
  }

  function tplVerdict(result, elapsed) {
    const v = result.verdict;
    const conf = Math.round((result.confidence ?? 0.7) * 100);
    const chipIcon = v === 'approve' ? '✓' : v === 'reject' ? '✕' : '~';
    const chipLabel = v.toUpperCase();

    const strengths = (result.strengths ?? []).map(s =>
      `<li><span class="gv-blt">+</span><span>${esc(s)}</span></li>`).join('');
    const concerns = (result.concerns ?? []).map(c =>
      `<li><span class="gv-blt">!</span><span>${esc(c)}</span></li>`).join('');

    const txLink = result.x402?.tx
      ? `<a href="https://basescan.org/tx/${result.x402.tx}" target="_blank" rel="noopener">tx: ${result.x402.tx.slice(0, 6)}…</a>`
      : '';

    return `
<div class="gv-verdict-row gv-verdict-row--${v}">
  <div class="gv-verdict-chip gv-verdict-chip--${v}">${chipIcon}</div>
  <div class="gv-verdict-text">
    <div class="gv-verdict-main gv-verdict-main--${v}">${chipLabel}</div>
    <div class="gv-verdict-conf">confidence ${conf}% · graded in ${elapsed}s</div>
  </div>
  <div class="gv-verdict-model">llama-3.3-70b<br>${txLink}</div>
</div>
<div class="gv-body">
  <div class="gv-conf-bar"><div class="gv-conf-fill gv-conf-fill--${v}" style="width:${conf}%"></div></div>
  <div class="gv-reasoning">${esc(result.reasoning ?? '')}</div>
  ${strengths ? `<div class="gv-bullets gv-bullets--strengths">
    <div class="gv-bullets-title">Strengths</div>
    <ul class="gv-list">${strengths}</ul>
  </div>` : ''}
  ${concerns ? `<div class="gv-bullets gv-bullets--concerns">
    <div class="gv-bullets-title">Concerns</div>
    <ul class="gv-list">${concerns}</ul>
  </div>` : ''}
</div>
<div class="gv-actions">
  <button class="gv-btn-action gv-btn-approve" data-gv="approve">✓ Approve bounty (on-chain)</button>
  <button class="gv-btn-action gv-btn-dispute" data-gv="dispute">⚠ Dispute</button>
</div>`;
  }

  function tplError(msg) {
    return `
<div class="gv-error">
  <span class="gv-error-msg">⚠ ${esc(msg)}</span>
  <button class="gv-btn-retry" data-gv="retry">Retry</button>
</div>`;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─────────────────────────────────────────────
  // Widget instance
  // ─────────────────────────────────────────────
  function createWidget(opts) {
    const {
      container,
      apiUrl,
      wallet,
      task,
      onVerdict = () => {},
      onError = () => {},
    } = opts;

    const root = typeof container === 'string'
      ? document.querySelector(container)
      : container;
    if (!root) throw new Error('GavelWidget: container not found');

    const price = opts.price ?? '0.05';
    let lastResult = null;
    let gradeStart = 0;

    root.innerHTML = tplHeader(apiUrl) + '<div class="gv-body-slot"></div>';
    root.classList.add('gv-widget');
    const slot = root.querySelector('.gv-body-slot');

    function render(html) { slot.innerHTML = html; }

    function showIdle() {
      root.classList.remove('gv-widget--active');
      render(tplIdle(wallet.address, price));
    }

    function showSigning() {
      root.classList.add('gv-widget--active');
      render(tplSigning(price));
    }

    function showGrading() {
      render(tplGrading());
    }

    function showVerdict(result) {
      const elapsed = ((Date.now() - gradeStart) / 1000).toFixed(1);
      render(tplVerdict(result, elapsed));
    }

    function showError(msg) {
      root.classList.remove('gv-widget--active');
      render(tplError(msg));
    }

    async function doGrade() {
      showSigning();

      let paymentHeader = null;

      if (wallet.provider) {
        // Real x402 flow: probe for 402, sign, retry
        try {
          const probe = await fetch(apiUrl + '/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload()),
          });

          if (probe.status === 402) {
            const x402 = await probe.json();
            const reqSpec = x402.accepts?.[0];
            if (!reqSpec) throw new Error('No accepted payment scheme from server');
            paymentHeader = await signX402Authorization(wallet.provider, wallet.address, reqSpec);
          }
        } catch (err) {
          if (err.code === 4001 || err.message?.includes('rejected')) {
            showIdle();
            return;
          }
          showError(err.message ?? 'Wallet signing failed');
          onError(err);
          return;
        }
      }

      showGrading();
      gradeStart = Date.now();

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;

        const res = await fetch(apiUrl + '/check', {
          method: 'POST',
          headers,
          body: JSON.stringify(buildPayload()),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `API error ${res.status}`);
        }

        const result = await res.json();
        lastResult = result;
        showVerdict(result);
        onVerdict(result);
      } catch (err) {
        showError(err.message ?? 'Grading failed');
        onError(err);
      }
    }

    function buildPayload() {
      return {
        task_type: task.type ?? 'research',
        tier: opts.tier ?? 'full',
        requirements: {
          title: task.title ?? '',
          topic_keywords: task.requirements?.topic_keywords ?? [],
          notes: task.requirements?.notes ?? task.description ?? '',
          ...task.requirements,
        },
        submission: task.submission ?? '',
        ...(task.proofUrl ? { meta: { proof_url: task.proofUrl } } : {}),
      };
    }

    // Event delegation
    root.addEventListener('click', (e) => {
      const action = e.target.closest('[data-gv]')?.dataset?.gv;
      if (!action) return;
      if (action === 'grade') doGrade();
      if (action === 'retry') doGrade();
      if (action === 'approve') opts.onApprove?.(lastResult);
      if (action === 'dispute') opts.onDispute?.(lastResult);
    });

    showIdle();

    return {
      reset: showIdle,
      getLastVerdict: () => lastResult,
    };
  }

  // ─────────────────────────────────────────────
  // Inject CSS once
  // ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('gavel-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'gavel-widget-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────
  global.GavelWidget = {
    init(opts) {
      injectStyles();
      return createWidget(opts);
    },
  };

})(typeof window !== 'undefined' ? window : globalThis);
