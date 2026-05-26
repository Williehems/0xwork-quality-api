// Telegram Mini App for 0xWork quality check.
//
// Flow:
//   1. Read ?session=<id>&wcProjectId=<id> from the URL.
//   2. GET /session/<id> to load the grading payload.
//   3. On tap: lazy-import WalletConnect, pair the wallet, then drive the
//      x402 dance via the inline client in ./x402-client.js
//        a. POST /check — expect 402 with payment requirements.
//        b. Sign EIP-3009 TransferWithAuthorization via the provider's
//           native eth_signTypedData_v4.
//        c. Retry /check with the base64-JSON X-PAYMENT header.
//   4. Return verdict to the bot via WebApp.sendData().

import { signX402Authorization } from "./x402-client.js";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
// Same-origin combined server hosts both the Mini App and bot/API.
const apiBase = location.origin;
const botBase = location.origin;
const wcProjectId = params.get("wcProjectId") ?? "";

const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $payLabel = document.getElementById("pay-label");
const $status = document.getElementById("status");
const $wcOpen = document.getElementById("wc-open");

let payload = null;
let wcProvider = null;

window.addEventListener("error", (e) => {
  setStatus("Script error: " + (e.message || String(e.error || "unknown")), "err");
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message || String(e.reason || "unknown");
  setStatus("Error: " + msg, "err");
});

async function loadSession() {
  if (!sessionId) {
    fail("Missing session parameter. Open this from the Telegram bot.");
    return;
  }
  setStatus("Loading submission…");
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
    $task.textContent = payload.requirements?.title ?? "(untitled)";
    const words = String(payload.submission ?? "").split(/\s+/).filter(Boolean).length;
    const type = payload.task_type ? `${payload.task_type} · ` : "";
    $subMeta.textContent = `${type}${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
    $pay.disabled = false;
    setStatus("");
  } catch (err) {
    fail(`Couldn't load submission from ${url}: ${err?.message ?? String(err)}`);
  }
}

// Promise-based, prewarmed lazy import. Two reasons we use a promise
// instead of caching the resolved module:
//   1. We start the import on page load (see prewarmWalletConnect below),
//      well before the user taps "Pair wallet and pay". This races against
//      wallet-extension SES lockdown that freezes intrinsics like WebSocket,
//      and shortens the perceived latency of the click.
//   2. ?bundle=true on esm.sh both bundles deps and biases the import map
//      toward the package's browser export. Without it, esm.sh has been
//      observed to serve @walletconnect/ethereum-provider's Node entry —
//      WC then prints ua=wc-2/.../node, and its relay transport uses a
//      Node WebSocket shim that can't open a real socket in the browser.
let walletConnectModPromise = null;
function importWalletConnect() {
  if (!walletConnectModPromise) {
    walletConnectModPromise = import(
      "https://esm.sh/@walletconnect/ethereum-provider@2.23.9?bundle=true"
    );
  }
  return walletConnectModPromise;
}
function prewarmWalletConnect() {
  // Don't bother inside Telegram WebView — connect() hangs there anyway
  // and we bounce to the external browser at the 402 step.
  if (isInTelegramWebView()) return;
  importWalletConnect().catch(() => {
    // Swallow — the click handler will retry and surface the error then.
  });
}

function maskId(id) {
  if (!id) return "(empty)";
  if (id.length <= 8) return `len=${id.length}`;
  return `${id.slice(0, 4)}…${id.slice(-4)} (len=${id.length})`;
}

// initData is non-empty when launched from inside Telegram. In external
// browsers telegram-web-app.js still loads (so `tg` exists), but initData
// is normally empty. Caveat: after a `tg.openLink` bounce the URL hash
// may still carry tgWebAppData=, and telegram-web-app.js re-parses that
// in the external browser too — which would make this falsely return
// true. Honor an explicit ?fromTgBounce=1 sentinel to short-circuit.
function isInTelegramWebView() {
  if (params.get("fromTgBounce") === "1") return false;
  return !!(tg?.initData);
}

// WC's connect() reliably hangs inside Telegram's WebView at the
// session-propose relay publish step (known WC/Reown issue). Rather
// than fight it, send the user to the same Mini App URL in their
// real browser, where WC works normally. The session ID stays in
// the URL so loadSession() picks up where this one left off, and the
// verdict POST still notifies the bot so the user gets the result
// in chat.
function showOpenInBrowserPrompt() {
  // Strip the `#tgWebAppData=...` hash so the external browser doesn't
  // re-init as a TG WebApp, and add ?fromTgBounce=1 so our detector
  // short-circuits even if some hash slips through.
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set("fromTgBounce", "1");
  const cleanUrl = url.toString();
  $wcOpen.textContent = "Open in browser to pay";
  $wcOpen.href = cleanUrl;
  $wcOpen.style.display = "block";
  $wcOpen.onclick = (e) => {
    if (tg?.openLink) {
      e.preventDefault();
      tg.openLink(cleanUrl);
    }
    // else: fall through to default anchor behavior (already not in TG)
  };
  setStatus(
    "Wallet pairing doesn't work inside Telegram. Tap to continue in your browser — the verdict will still be sent to this chat.",
  );
  $pay.disabled = true;
  setBtnBusy(false);
}

// Telegram WebView blocks/partitions IndexedDB on some Android builds.
// WC's @walletconnect/keyvaluestorage falls through to IDB by default,
// and a blocked IDB request just hangs forever — that's the silent
// "stuck at Connecting to relay" symptom with no error from our timeout
// (no exception is raised, init() just never resolves). Hand WC an
// in-memory store so it never touches IDB.
function createMemStorage() {
  const m = new Map();
  return {
    async init() {},
    async getKeys() { return [...m.keys()]; },
    async getEntries() { return [...m.entries()]; },
    async getItem(key) { return m.get(key); },
    async setItem(key, value) { m.set(key, value); },
    async removeItem(key) { m.delete(key); },
  };
}

async function ensureWalletConnected(EthereumProvider) {
  if (wcProvider?.accounts?.length) return wcProvider;

  if (!wcProjectId) {
    throw new Error(
      "Wallet config missing from this link. Reopen Pay & Grade from the bot chat — if you see this again, the bot operator needs to set REOWN_PROJECT_ID.",
    );
  }

  // Phase-tracked init. Each "phase" is a step we want to attribute a
  // freeze/error to. The ticker shows phase + elapsed time so the user
  // can tell us which step is stuck. Ticks fast (100ms) for the first
  // ~2s to distinguish "frozen main thread" from "we just haven't ticked
  // yet" — setInterval(1000ms) fires its first callback at 1000ms, which
  // can look indistinguishable from a sync block.
  let phase = "starting";
  let phaseStart = performance.now();
  const setPhase = (p) => { phase = p; phaseStart = performance.now(); };
  const fmtElapsed = () => {
    const ms = performance.now() - phaseStart;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  };
  setStatus(`[${phase} 0ms] projectId ${maskId(wcProjectId)}`);
  let tickN = 0;
  let fastTicker = null;
  let slowTicker = null;
  const stopTickers = () => {
    if (fastTicker) clearInterval(fastTicker);
    if (slowTicker) clearInterval(slowTicker);
  };
  const tickMsg = () => `[${phase} ${fmtElapsed()}] tick #${tickN}, projectId ${maskId(wcProjectId)}`;
  fastTicker = setInterval(() => {
    tickN++;
    setStatus(tickMsg());
    // After 20 fast ticks (~2s), drop to 1s interval to reduce noise.
    if (tickN === 20) {
      clearInterval(fastTicker);
      fastTicker = null;
      slowTicker = setInterval(() => { tickN++; setStatus(tickMsg()); }, 1000);
    }
  }, 100);

  try {
    setPhase("init-call");
    console.log("[wc] phase:init-call");
    const initPromise = EthereumProvider.init({
      projectId: wcProjectId,
      optionalChains: [84532], // Base Sepolia (optional so wallets without it can still pair)
      showQrModal: false,
      storage: createMemStorage(),
      metadata: {
        name: "0xWork Quality Check",
        description: "Pay-per-grade submission grader",
        url: location.origin,
        icons: [],
      },
    });
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        `Reown relay didn't respond in 30s (phase=${phase}, ticks=${tickN}). ` +
        `Origin ${location.origin}. ` +
        `Likely causes: origin not in Reown allowed-origins list, ` +
        `WebSocket blocked by network/WebView, or relay outage.`
      )), 30000),
    );
    wcProvider = await Promise.race([initPromise, timeout]);
    setPhase("init-resolved");
    console.log("[wc] phase:init-resolved");
  } catch (e) {
    stopTickers();
    const m = e?.message || String(e);
    throw new Error(`init failed (phase=${phase}, ticks=${tickN}): ${m}`);
  }

  setPhase("attach-events");
  console.log("[wc] phase:attach-events");
  wcProvider.on?.("display_uri", (uri) => {
    console.log("[wc] display_uri", uri?.slice(0, 40) + "…");
    setPhase("display-uri-received");
    // Use a wallet universal-link wrapper so Telegram's WebView hands
    // the URL to MetaMask Mobile via iOS/Android Universal Links,
    // instead of a raw wc: scheme which Telegram tends to swallow.
    const universalLink = "https://metamask.app.link/wc?uri=" + encodeURIComponent(uri);
    $wcOpen.href = universalLink;
    $wcOpen.style.display = "block";
    $wcOpen.onclick = (e) => {
      if (tg?.openLink) {
        e.preventDefault();
        tg.openLink(universalLink, { try_instant_view: false });
      }
    };
    setStatus("Tap below — opens MetaMask Mobile to approve the pairing.");
  });
  wcProvider.on?.("connect", () => {
    console.log("[wc] connect");
    setPhase("wallet-connected");
    $wcOpen.style.display = "none";
  });
  wcProvider.on?.("disconnect", (e) => console.log("[wc] disconnect", e));

  try {
    if (!wcProvider.session) {
      setPhase("connect-call");
      console.log("[wc] phase:connect-call");
      await wcProvider.connect();
      setPhase("connect-resolved");
      console.log("[wc] phase:connect-resolved");
    }
  } catch (e) {
    stopTickers();
    const m = e?.message || String(e);
    throw new Error(`connect failed (phase=${phase}, ticks=${tickN}): ${m}`);
  }

  stopTickers();
  return wcProvider;
}

async function payAndGrade() {
  if (!payload) return;
  $pay.disabled = true;
  setBtnBusy(true);
  try {
    const body = JSON.stringify({
      task_type: payload.task_type,
      tier: payload.tier,
      requirements: payload.requirements,
      submission: payload.submission,
    });
    const headers = { "content-type": "application/json" };

    // Try /check first without payment. If the server's running in bypass
    // mode (or otherwise doesn't require payment for this caller) it
    // returns 200 immediately and we skip the whole WalletConnect dance.
    setStatus("Submitting for grading…");
    let res = await fetch(`${apiBase}/check`, { method: "POST", headers, body });

    if (res.status === 402) {
      // Server demands payment. WC's connect() reliably hangs in
      // Telegram's WebView, so bounce out to the user's real browser
      // before even loading WC.
      if (isInTelegramWebView()) {
        showOpenInBrowserPrompt();
        return;
      }
      // Server demands payment — now we load WC and pair the wallet.
      setStatus("Loading wallet library…");
      const { EthereumProvider } = await importWalletConnect();
      setStatus("Opening wallet…");
      const provider = await ensureWalletConnected(EthereumProvider);
      const [address] = provider.accounts;
      if (!address) throw new Error("Wallet paired but returned no account for Base Sepolia (chain 84532). Make sure your wallet is unlocked and has Base Sepolia enabled.");

      setStatus(`Wallet paired (${short(address)}). Signing payment…`);
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
    if (tg) {
      tg.close();
    } else {
      setStatus(JSON.stringify(verdict, null, 2), "ok");
    }
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    setStatus("Error: " + msg, "err");
    $pay.disabled = false;
    setBtnBusy(false);
    $wcOpen.style.display = "none";
  }
}

function short(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function setStatus(msg, kind) {
  $status.textContent = msg ?? "";
  $status.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok" : "");
}

function setBtnBusy(busy) {
  if (busy) {
    $pay.classList.add("busy");
    $payLabel.textContent = "Working…";
  } else {
    $pay.classList.remove("busy");
    $payLabel.textContent = "Pair wallet and pay";
  }
}

function fail(msg) {
  setStatus(msg, "err");
  $pay.disabled = true;
  if ($task.textContent === "Loading…") $task.textContent = "—";
  if ($subMeta.textContent === "Loading…") $subMeta.textContent = "—";
}

$pay.addEventListener("click", payAndGrade);
loadSession();
prewarmWalletConnect();
