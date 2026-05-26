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
  setStatus("Promise error: " + msg, "err");
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
      fail("Session expired. Go back to chat, open /inbox and pick the task again.");
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

let walletConnectMod = null;
async function importWalletConnect() {
  if (walletConnectMod) return walletConnectMod;
  setStatus("Loading wallet library…");
  walletConnectMod = await import("https://esm.sh/@walletconnect/ethereum-provider@2.23.9");
  return walletConnectMod;
}

function maskId(id) {
  if (!id) return "(empty)";
  if (id.length <= 8) return `len=${id.length}`;
  return `${id.slice(0, 4)}…${id.slice(-4)} (len=${id.length})`;
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
      "Wallet pairing isn't configured (REOWN_PROJECT_ID missing). Ask the bot operator.",
    );
  }

  // Stopwatch — proves setTimeout/setInterval fire even if WC's init
  // is hanging on a blocked storage call. If this counter freezes, the
  // main thread is blocked; if it keeps counting past 30 with no error,
  // our Promise.race has a bug.
  let elapsed = 0;
  setStatus(`Connecting to relay (0s, projectId ${maskId(wcProjectId)})…`);
  const ticker = setInterval(() => {
    elapsed++;
    setStatus(`Connecting to relay (${elapsed}s, projectId ${maskId(wcProjectId)})…`);
  }, 1000);

  try {
    const initPromise = EthereumProvider.init({
      projectId: wcProjectId,
      chains: [84532], // Base Sepolia
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
        `relay never responded after 30s (elapsed=${elapsed}s) — projectId likely not allowed for this origin (` +
        location.origin + "). Re-check the Reown allowed-origins list."
      )), 30000),
    );
    wcProvider = await Promise.race([initPromise, timeout]);
  } catch (e) {
    clearInterval(ticker);
    const m = e?.message || String(e);
    throw new Error(`Relay handshake failed (projectId ${maskId(wcProjectId)}, t=${elapsed}s): ${m}`);
  }
  clearInterval(ticker);

  wcProvider.on?.("display_uri", (uri) => {
    console.log("[wc] display_uri", uri?.slice(0, 40) + "…");
    // Use a wallet universal-link wrapper so Telegram's WebView hands
    // the URL to MetaMask Mobile via iOS/Android Universal Links,
    // instead of a raw wc: scheme which Telegram tends to swallow.
    const universalLink = "https://metamask.app.link/wc?uri=" + encodeURIComponent(uri);
    $wcOpen.href = universalLink;
    $wcOpen.style.display = "block";
    setStatus("Tap below — opens MetaMask Mobile to approve the pairing.");
  });
  wcProvider.on?.("connect", () => {
    console.log("[wc] connect");
    $wcOpen.style.display = "none";
  });
  wcProvider.on?.("disconnect", (e) => console.log("[wc] disconnect", e));

  if (!wcProvider.session) {
    await wcProvider.connect();
  }
  return wcProvider;
}

async function payAndGrade() {
  if (!payload) return;
  $pay.disabled = true;
  setBtnBusy(true);
  try {
    const { EthereumProvider } = await importWalletConnect();

    setStatus("Opening wallet…");
    const provider = await ensureWalletConnected(EthereumProvider);
    const [address] = provider.accounts;
    if (!address) throw new Error("Wallet did not return an account.");

    setStatus(`Wallet paired (${short(address)}). Requesting payment terms…`);
    const body = JSON.stringify({
      task_type: payload.task_type,
      tier: payload.tier,
      requirements: payload.requirements,
      submission: payload.submission,
    });
    const headers = { "content-type": "application/json" };

    let res = await fetch(`${apiBase}/check`, { method: "POST", headers, body });

    if (res.status === 402) {
      const offer = await res.json();
      const accepts = offer?.accepts;
      if (!Array.isArray(accepts) || accepts.length === 0) {
        throw new Error("API offered no payment options.");
      }
      const reqSpec = accepts.find((a) => a.scheme === "exact") ?? accepts[0];

      setStatus("Sign the payment in your wallet…");
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

    if (tg) {
      tg.sendData(JSON.stringify(verdict));
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
