// Telegram Mini App for 0xWork: grading, approval, and dispute flows.
//
// The Mini App is action-aware via a `?action=` URL param:
//   - "grade" (default):  POST /check, optionally pay 0.10 USDC via x402,
//                         deliver the verdict to chat through /verdict/<id>.
//   - "approve":          send TaskPool.approveWork(taskId) on Base mainnet.
//   - "dispute":          send TaskPool.rejectWork(taskId)  on Base mainnet.
//
// All paths share: the connection picker (MetaMask injected vs pasted PK),
// the TG WebView bounce (MM only — PK works in-WebView), the return-to-TG
// success card, and the Telegram theme bridge.

import { signX402Authorization } from "./x402-client.js";
import {
  BASE_MAINNET_CHAIN_ID_HEX,
  BASE_RPC,
  BASESCAN_TX_BASE,
  TASKPOOL_ADDRESS,
  importEthers,
  encodeApproveWork,
  encodeRejectWork,
  sendAndConfirm,
  ensureBaseMainnet,
} from "./onchain.js";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// Mirror Telegram's theme into CSS variables so the Mini App matches the
// user's actual TG client (dark, light, or any custom scheme they have set)
// instead of forcing our hardcoded dark palette.
function applyTelegramTheme() {
  const tp = tg?.themeParams;
  if (!tp) return;
  const map = {
    bg_color: "--bg",
    secondary_bg_color: "--bg-elev",
    section_bg_color: "--surface",
    text_color: "--text",
    subtitle_text_color: "--text-2",
    hint_color: "--text-3",
    section_separator_color: "--border",
    button_color: "--accent",
    button_text_color: "--accent-text",
    link_color: "--link",
    destructive_text_color: "--err",
  };
  const root = document.documentElement.style;
  for (const [tgKey, cssVar] of Object.entries(map)) {
    const v = tp[tgKey];
    if (v) root.setProperty(cssVar, v);
  }
  if (tp.section_bg_color) {
    root.setProperty("--surface-2", `color-mix(in srgb, ${tp.section_bg_color} 88%, ${tp.text_color || "#fff"} 12%)`);
  }
}
applyTelegramTheme();
tg?.onEvent?.("themeChanged", applyTelegramTheme);

// ─── URL params + action mode ─────────────────────────────────────
const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
const action = (params.get("action") || "grade").toLowerCase();
const apiBase = location.origin;
const botBase = location.origin;

// ─── DOM refs ─────────────────────────────────────────────────────
const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $payLabel = document.getElementById("pay-label");
const $status = document.getElementById("status");
const $wcOpen = document.getElementById("wc-open");
const $pkRow = document.getElementById("pk-row");
const $pkInput = document.getElementById("pk-input");
const $payCard = document.querySelector(".pay-card");
const $returnCard = document.getElementById("return-card");
const $returnLink = document.getElementById("return-link");
const $returnSub = document.getElementById("return-sub");
// Action-aware pay-card sections (one is shown, the others hidden).
const $sectionGrade = document.querySelector('[data-mode="grade"]');
const $sectionApprove = document.querySelector('[data-mode="approve"]');
const $sectionDispute = document.querySelector('[data-mode="dispute"]');
// Wallet-warning disclosure — visible only in approve/dispute (on-chain tx) modes.
const $walletNotice = document.querySelector('[data-mode="action"]');
// Approve-specific value slots.
const $approveBounty = document.getElementById("approve-bounty");
const $approveFee = document.getElementById("approve-fee");
const $approvePayout = document.getElementById("approve-payout");
const $approveWorker = document.getElementById("approve-worker");
const $approveHeading = document.getElementById("approve-heading");
const $disputeHeading = document.getElementById("dispute-heading");

let payload = null;
let botUsername = "";

window.addEventListener("error", (e) => {
  setStatus("Script error: " + (e.message || String(e.error || "unknown")), "err");
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message || String(e.reason || "unknown");
  setStatus("Error: " + msg, "err");
});

// ─── Session load + initial render ────────────────────────────────
async function loadSession() {
  if (!sessionId) {
    fail("Missing session parameter. Open this from the Telegram bot.");
    return;
  }
  setStatus("Loading…");
  const url = `${botBase}/session/${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      fail("Session not found — it expired (30min TTL) or the bot restarted. Open /inbox in the chat and pick the task again.");
      return;
    }
    if (!res.ok) {
      fail(`Bot returned ${res.status}. Try again from the chat.`);
      return;
    }
    payload = await res.json();
    botUsername = payload.bot_username || "";
    // Update the grade-mode price display from the server's current setting.
    const $gradePrice = document.getElementById("grade-price");
    if ($gradePrice && payload.price) $gradePrice.textContent = payload.price;
    if (action === "approve" || action === "dispute") {
      renderActionMode(payload, action);
    } else {
      renderGradeMode(payload);
    }
    $pay.disabled = false;
    setStatus("");
  } catch (err) {
    fail(`Couldn't load session from ${url}: ${err?.message ?? String(err)}`);
  }
}

function renderGradeMode(p) {
  $sectionGrade.hidden = false;
  $sectionApprove.hidden = true;
  $sectionDispute.hidden = true;
  if ($walletNotice) $walletNotice.hidden = true;
  $task.textContent = p.requirements?.title ?? "(untitled)";
  const words = String(p.submission ?? "").split(/\s+/).filter(Boolean).length;
  const typeLabel = p.task_type ? p.task_type.replace(/^./, (c) => c.toUpperCase()) : "Submission";
  $subMeta.innerHTML =
    `<strong>${escapeHtml(typeLabel)}</strong>` +
    `<span class="sep">·</span>` +
    `<span>${words.toLocaleString()} word${words === 1 ? "" : "s"}</span>`;
  $payLabel.textContent = labelForMethod(getSelectedConnectionMethod());
}

function renderActionMode(p, kind) {
  // Hide the grading sections, reveal the action-specific one.
  $sectionGrade.hidden = true;
  $sectionApprove.hidden = kind !== "approve";
  $sectionDispute.hidden = kind !== "dispute";
  if ($walletNotice) $walletNotice.hidden = false;

  const task = p.task || {};
  $task.textContent = task.title || p.requirements?.title || `Task #${task.id ?? "?"}`;
  const bountyN = Number(task.bountyAmount ?? task.bounty ?? 0);
  $subMeta.innerHTML =
    `<strong>Task #${escapeHtml(String(task.id ?? "?"))}</strong>` +
    `<span class="sep">·</span>` +
    `<span>${formatUSDC(bountyN)} USDC bounty</span>`;

  if (kind === "approve") {
    // Fee structure per @0xwork/sdk: 5% standard, 2% with discountedFee flag.
    const feeRate = task.discountedFee ? 0.02 : 0.05;
    const fee = bountyN * feeRate;
    const payout = bountyN - fee;
    $approveHeading.textContent = `Approve task #${task.id ?? "?"}`;
    $approveBounty.textContent = `${formatUSDC(bountyN)} USDC`;
    $approveFee.textContent = `${formatUSDC(fee)} USDC (${Math.round(feeRate * 100)}%)`;
    $approvePayout.textContent = `${formatUSDC(payout)} USDC`;
    $approveWorker.textContent = task.worker ? short(task.worker) : "—";
    if (task.worker) $approveWorker.setAttribute("title", task.worker);
  } else {
    $disputeHeading.textContent = `Dispute task #${task.id ?? "?"}`;
  }

  $payLabel.textContent = labelForMethod(getSelectedConnectionMethod());
}

// ─── Wallet connection paths (shared between grade + action flows) ─
function getInjectedProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    const mm = eth.providers.find((p) => p.isMetaMask);
    return mm ?? eth.providers[0];
  }
  return eth;
}

function openInMetaMaskAppBrowser() {
  const stripped = window.location.href.replace(/^https?:\/\//, "");
  window.location.href = `https://metamask.app.link/dapp/${stripped}`;
}

async function connectMetaMask() {
  const injected = getInjectedProvider();
  if (!injected) {
    setStatus("Opening MetaMask…");
    openInMetaMaskAppBrowser();
    return null; // page is navigating away
  }
  const accounts = await injected.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("MetaMask returned no account");
  await ensureBaseMainnet(injected);
  return { provider: injected, address: accounts[0] };
}

// Private-key path. Key stays in browser memory only — never POSTed, never
// persisted. ethers.Wallet handles both typed-data signing (for x402
// grading payments) and full transactions (for approve/dispute).
async function connectWithPrivateKey(rawKey) {
  const key = rawKey.trim().startsWith("0x") ? rawKey.trim() : "0x" + rawKey.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Invalid private key — expected 64 hex chars (optionally 0x-prefixed)");
  }
  const ethers = await importEthers();
  // Connect to Base mainnet RPC so wallet.sendTransaction can fetch
  // nonce / gas / submit. The same wallet handles typed-data signing
  // (no RPC needed for that, but the connection is harmless).
  const rpcProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(key, rpcProvider);
  const provider = {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return BASE_MAINNET_CHAIN_ID_HEX;
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [wallet.address];
      if (method === "eth_signTypedData_v4") {
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      if (method === "eth_sendTransaction") {
        const tx = params?.[0] ?? {};
        const sent = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
        });
        return sent.hash;
      }
      throw new Error(`PK provider does not implement ${method}`);
    },
  };
  return { provider, address: wallet.address };
}

function getSelectedConnectionMethod() {
  return document.querySelector('input[name="conn"]:checked')?.value || "metamask";
}

async function getConnection() {
  const method = getSelectedConnectionMethod();
  // MetaMask can't sign inside TG's WebView (no window.ethereum, deeplink
  // would drop the user out of TG). Bounce to external browser. The PK
  // path signs locally with ethers, so it works fine in-WebView.
  if (method === "metamask" && isInTelegramWebView()) {
    showOpenInBrowserPrompt();
    return null;
  }
  if (method === "pk") {
    const pk = $pkInput.value;
    if (!pk) {
      setStatus("Paste a private key first.", "err");
      $pay.disabled = false;
      setBtnBusy(false);
      return null;
    }
    setStatus("Loading signer…");
    const conn = await connectWithPrivateKey(pk);
    $pkInput.value = ""; // wipe immediately so it can't be re-read
    return conn;
  }
  setStatus("Connecting MetaMask…");
  return await connectMetaMask();
}

// ─── Telegram WebView bounce ──────────────────────────────────────
function isInTelegramWebView() {
  if (params.get("fromTgBounce") === "1") return false;
  return !!(tg?.initData);
}

function showOpenInBrowserPrompt() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("fromTgBounce", "1");
  const cleanUrl = url.toString();
  $wcOpen.textContent = "Open in browser to continue";
  $wcOpen.href = cleanUrl;
  $wcOpen.style.display = "block";
  $wcOpen.onclick = (e) => {
    if (tg?.openLink) {
      e.preventDefault();
      tg.openLink(cleanUrl);
    }
  };
  setStatus(
    "MetaMask can't connect inside Telegram. Tap to continue in your browser — the result will still be sent to this chat.",
  );
  $pay.disabled = true;
  setBtnBusy(false);
}

// ─── Action dispatch ──────────────────────────────────────────────
async function onPrimaryClick() {
  if (!payload) return;
  $pay.disabled = true;
  setBtnBusy(true);
  try {
    if (action === "approve" || action === "dispute") {
      await signAndSendAction(action);
    } else {
      await payAndGrade();
    }
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    setStatus("Error: " + msg, "err");
    $pay.disabled = false;
    setBtnBusy(false);
    $wcOpen.style.display = "none";
  }
}

// ─── Grade flow (existing pay+grade dance) ────────────────────────
async function payAndGrade() {
  const body = JSON.stringify({
    task_type: payload.task_type,
    tier: payload.tier,
    requirements: payload.requirements,
    submission: payload.submission,
  });
  const headers = { "content-type": "application/json" };

  setStatus("Submitting for grading…");
  let res = await fetch(`${apiBase}/check`, { method: "POST", headers, body });

  if (res.status === 402) {
    const conn = await getConnection();
    if (!conn) return;
    const { provider, address } = conn;
    setStatus(`Signer ready (${short(address)}). Signing payment…`);

    const offer = await res.json();
    const accepts = offer?.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) {
      throw new Error("API offered no payment options.");
    }
    const reqSpec = accepts.find((a) => a.scheme === "exact") ?? accepts[0];

    const xPayment = await signX402Authorization(
      provider, address, offer.x402Version ?? 1, reqSpec,
    );

    setStatus("Submitting payment…");
    res = await fetch(`${apiBase}/check`, {
      method: "POST",
      headers: { ...headers, "X-PAYMENT": xPayment },
      body,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  const verdict = await res.json();
  setStatus("Graded. Returning verdict to chat…", "ok");

  const deliverRes = await fetch(`${apiBase}/verdict/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(verdict),
  });
  if (!deliverRes.ok) {
    throw new Error("Couldn't deliver verdict to chat: API " + deliverRes.status);
  }
  showReturnToTelegram("Verdict delivered", "Check your Telegram chat for the result.");
}

// ─── Approve / dispute flow ───────────────────────────────────────
async function signAndSendAction(kind) {
  const task = payload?.task;
  if (task?.id == null) throw new Error("Session has no task data.");
  const taskId = task.id;

  const conn = await getConnection();
  if (!conn) return;
  const { provider, address } = conn;

  // Sanity check: only the poster can approve/reject on-chain. The bot
  // shouldn't have launched this flow if the wallet isn't the poster, but
  // surface a clear error if it happens (e.g. user picked a different
  // wallet than the one bound via /wallet).
  if (task.posterAddress && address.toLowerCase() !== String(task.posterAddress).toLowerCase()) {
    throw new Error(
      `Wallet ${short(address)} isn't the poster of task #${taskId} ` +
      `(poster: ${short(task.posterAddress)}). Switch wallets or rebind via /wallet.`
    );
  }

  await ensureBaseMainnet(provider);

  setStatus(`Encoding ${kind === "approve" ? "approval" : "dispute"} call…`);
  const data = kind === "approve"
    ? await encodeApproveWork(taskId)
    : await encodeRejectWork(taskId);

  setStatus(`Open ${kind === "approve" ? "MetaMask" : "wallet"} to confirm. Your wallet may warn — this is expected.`);
  const { txHash } = await sendAndConfirm({
    provider,
    from: address,
    to: TASKPOOL_ADDRESS,
    data,
  });

  setStatus("Notifying chat…", "ok");
  const resultBody = { action: kind, taskId, txHash };
  const r = await fetch(`${apiBase}/action-result/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(resultBody),
  });
  if (!r.ok) {
    // The tx already landed — telling the user the chat notification
    // failed is more honest than hiding it.
    const t = await r.text().catch(() => "");
    throw new Error(`Tx confirmed (${BASESCAN_TX_BASE}${txHash}) but chat notify failed: ${r.status}${t ? ` ${t.slice(0, 120)}` : ""}`);
  }

  const headline = kind === "approve" ? "Approved" : "Dispute opened";
  const sub = kind === "approve"
    ? "Bounty released to the worker on-chain. Check your Telegram chat for the BaseScan link."
    : "48h dispute window started. Check your Telegram chat for details.";
  showReturnToTelegram(headline, sub, { txHash });
}

// ─── Utility ──────────────────────────────────────────────────────
function short(addr) {
  if (!addr) return "—";
  const s = String(addr);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUSDC(n) {
  if (!Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// Swap the action surface for a success card. tg.close() runs after a
// brief beat (TG WebView closes; external browser stays put and shows
// the success card with a t.me/<bot> fallback).
function showReturnToTelegram(headline, sub, extras = {}) {
  if ($payCard) $payCard.style.display = "none";
  const href = botUsername ? `https://t.me/${botUsername}` : "https://t.me";
  $returnLink.href = href;
  $returnLink.target = "_blank";
  $returnLink.rel = "noopener";
  if (headline) {
    const h = document.querySelector("#return-card .return-title");
    if (h) h.textContent = headline;
  }
  if (sub) $returnSub.textContent = sub;
  // Optional BaseScan link below the sub copy.
  if (extras.txHash) {
    const existing = document.getElementById("return-scan");
    const scan = existing || document.createElement("a");
    scan.id = "return-scan";
    scan.href = `${BASESCAN_TX_BASE}${extras.txHash}`;
    scan.target = "_blank";
    scan.rel = "noopener";
    scan.textContent = "View tx on BaseScan";
    scan.className = "return-scan";
    if (!existing) $returnSub.insertAdjacentElement("afterend", scan);
  }
  $returnCard.classList.add("show");
  if (tg && typeof tg.close === "function") {
    setTimeout(() => { try { tg.close(); } catch { /* ignore */ } }, 700);
  }
}

function setStatus(msg, kind) {
  $status.textContent = msg ?? "";
  $status.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok" : "");
}

function labelForMethod(m) {
  const verb = action === "approve" ? "approve"
             : action === "dispute" ? "dispute"
             : "pay";
  if (m === "pk") return `Sign with key and ${verb}`;
  return `Connect MetaMask and ${verb}`;
}

function setBtnBusy(busy) {
  if (busy) {
    $pay.classList.add("busy");
    $payLabel.textContent = "Working…";
  } else {
    $pay.classList.remove("busy");
    $payLabel.textContent = labelForMethod(getSelectedConnectionMethod());
  }
}

function fail(msg) {
  setStatus(msg, "err");
  $pay.disabled = true;
  if ($task.textContent === "Loading…") $task.textContent = "—";
  if ($subMeta.textContent === "Loading…") $subMeta.textContent = "—";
}

// Wire connection-method toggle.
document.querySelectorAll('input[name="conn"]').forEach((r) => {
  r.addEventListener("change", () => {
    const m = getSelectedConnectionMethod();
    $pkRow.hidden = m !== "pk";
    if (m !== "pk") $pkInput.value = "";
    $payLabel.textContent = labelForMethod(m);
  });
});

$pay.addEventListener("click", onPrimaryClick);
loadSession();
