// Telegram Mini App for 0xWork quality check.
//
// Flow:
//   1. Read ?session=<id> from the URL.
//   2. GET /session/<id> to load the grading payload.
//   3. On tap: per the chosen signing path (MetaMask injected or pasted
//      private key) drive the x402 dance via the inline client in
//      ./x402-client.js:
//        a. POST /check — expect 402 with payment requirements.
//        b. Sign EIP-3009 TransferWithAuthorization (MetaMask via the
//           injected provider's eth_signTypedData_v4; PK via ethers
//           locally — key never leaves the tab).
//        c. Retry /check with the base64-JSON X-PAYMENT header.
//   4. POST /verdict/<id> so the bot can deliver to chat.

import { signX402Authorization } from "./x402-client.js";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
// Same-origin combined server hosts both the Mini App and bot/API.
const apiBase = location.origin;
const botBase = location.origin;

const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $payLabel = document.getElementById("pay-label");
const $status = document.getElementById("status");
const $wcOpen = document.getElementById("wc-open");
const $pkRow = document.getElementById("pk-row");
const $pkInput = document.getElementById("pk-input");

let payload = null;

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

// === Signing paths ===

const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34"; // 84532

// When multiple wallet extensions inject, the browser exposes a list at
// window.ethereum.providers. Prefer MetaMask when present so the chain
// switch and the signTypedData call route to the same wallet.
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
  // metamask.app.link/dapp/<host+path> opens the page inside MetaMask
  // Mobile's in-app browser, which auto-injects window.ethereum.
  const stripped = window.location.href.replace(/^https?:\/\//, "");
  window.location.href = `https://metamask.app.link/dapp/${stripped}`;
}

async function ensureBaseSepolia(provider) {
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === BASE_SEPOLIA_CHAIN_ID_HEX) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_CHAIN_ID_HEX }],
    });
  } catch (err) {
    // 4902 = unrecognized chain; some wallets surface it via -32603.
    if (err && (err.code === 4902 || err.code === -32603)) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_SEPOLIA_CHAIN_ID_HEX,
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        }],
      });
    } else {
      throw err;
    }
  }
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
  await ensureBaseSepolia(injected);
  return { provider: injected, address: accounts[0] };
}

// Private-key path. Key stays in browser memory only — never POSTed, never
// persisted. ethers.Wallet.signTypedData covers our EIP-712 case directly.
let ethersModPromise = null;
function importEthers() {
  if (!ethersModPromise) {
    ethersModPromise = import("https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm");
  }
  return ethersModPromise;
}

async function connectWithPrivateKey(rawKey) {
  const key = rawKey.trim().startsWith("0x") ? rawKey.trim() : "0x" + rawKey.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Invalid private key — expected 64 hex chars (optionally 0x-prefixed)");
  }
  const ethers = await importEthers();
  const wallet = new ethers.Wallet(key);
  // Minimal EIP-1193-ish shim so x402-client.js can sign through .request()
  // the same way it does for the MetaMask path.
  const provider = {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return BASE_SEPOLIA_CHAIN_ID_HEX;
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [wallet.address];
      if (method === "eth_signTypedData_v4") {
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      throw new Error(`PK provider does not implement ${method}`);
    },
  };
  return { provider, address: wallet.address };
}

function getSelectedConnectionMethod() {
  return document.querySelector('input[name="conn"]:checked')?.value || "metamask";
}

// === Telegram WebView bounce ===

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

// Wallet pairing reliably fails inside Telegram's WebView (relay hangs
// for WC; MetaMask's deeplink can't escape the in-app browser either).
// Send the user to the same Mini App URL in their real browser, where
// both paths work. The session ID stays in the URL so loadSession() picks
// up where this one left off, and the verdict POST still notifies the bot
// so the user gets the result in chat.
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
  };
  setStatus(
    "Wallet pairing doesn't work inside Telegram. Tap to continue in your browser — the verdict will still be sent to this chat.",
  );
  $pay.disabled = true;
  setBtnBusy(false);
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
    // returns 200 immediately and we skip the whole signing dance.
    setStatus("Submitting for grading…");
    let res = await fetch(`${apiBase}/check`, { method: "POST", headers, body });

    if (res.status === 402) {
      if (isInTelegramWebView()) {
        showOpenInBrowserPrompt();
        return;
      }

      const method = getSelectedConnectionMethod();
      let conn;
      if (method === "pk") {
        const pk = $pkInput.value;
        if (!pk) {
          setStatus("Paste a private key first.", "err");
          $pay.disabled = false;
          setBtnBusy(false);
          return;
        }
        setStatus("Loading signer…");
        conn = await connectWithPrivateKey(pk);
        $pkInput.value = ""; // wipe immediately so it can't be re-read
      } else {
        setStatus("Connecting MetaMask…");
        conn = await connectMetaMask();
        if (!conn) return; // deeplink redirect in flight
      }

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

function labelForMethod(m) {
  return m === "pk" ? "Sign with key and pay" : "Connect MetaMask and pay";
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

// Wire connection-method toggle: show/hide PK input, update button label.
document.querySelectorAll('input[name="conn"]').forEach((r) => {
  r.addEventListener("change", () => {
    const m = getSelectedConnectionMethod();
    $pkRow.hidden = m !== "pk";
    if (m !== "pk") $pkInput.value = "";
    $payLabel.textContent = labelForMethod(m);
  });
});

$pay.addEventListener("click", payAndGrade);
loadSession();
