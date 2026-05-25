// Telegram Mini App — real WalletConnect v2 pairing + x402 USDC payment.
//
// Flow:
//   1. Read ?session=<id>&api=<url>&bot=<url>&wcProjectId=<id> from the URL.
//   2. GET ${bot}/session/${id} to load the grading payload.
//   3. On user tap: init WalletConnect EthereumProvider, prompt wallet pair.
//   4. Build a viem walletClient on top of the WC EIP-1193 provider.
//   5. wrapFetchWithPayment intercepts the 402 from /check, signs the EIP-3009
//      USDC TransferWithAuthorization, retries with X-PAYMENT header.
//   6. Return the verdict to the bot via WebApp.sendData(); bot renders it.

import { EthereumProvider } from "https://esm.sh/@walletconnect/ethereum-provider@2.17.0";
import { createWalletClient, custom } from "https://esm.sh/viem@2.21.0";
import { baseSepolia } from "https://esm.sh/viem@2.21.0/chains";
import { wrapFetchWithPayment } from "https://esm.sh/x402-fetch@1.2.0";

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
// Mini App is served from the same origin as the bot/API combined server,
// so default to location.origin instead of trusting URL params (which the bot
// can't fill in if BOT_PUBLIC_URL env isn't set).
const apiBase = params.get("api") || location.origin;
const botBase = params.get("bot") || location.origin;
const wcProjectId = params.get("wcProjectId") ?? "";

const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $payLabel = document.getElementById("pay-label");
const $status = document.getElementById("status");

let payload = null;
let wcProvider = null;

async function loadSession() {
  if (!sessionId) {
    fail("Missing session — open this from the Telegram bot.");
    return;
  }
  try {
    const res = await fetch(`${botBase}/session/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) {
      fail("Session expired or not found. Re-send the submission to the bot.");
      return;
    }
    if (!res.ok) throw new Error(`bot ${res.status}`);
    payload = await res.json();
    $task.textContent = payload.requirements?.title ?? "(untitled)";
    const words = String(payload.submission ?? "").split(/\s+/).filter(Boolean).length;
    const type = payload.task_type ? `${payload.task_type} · ` : "";
    $subMeta.textContent = `${type}${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
  } catch (err) {
    fail("Couldn't load submission: " + (err.message ?? String(err)));
  }
}

async function ensureWalletConnected() {
  if (wcProvider?.accounts?.length) return wcProvider;

  if (!wcProjectId) {
    throw new Error(
      "Wallet pairing isn't configured (missing Reown Project ID). The bot operator needs to set REOWN_PROJECT_ID.",
    );
  }

  wcProvider = await EthereumProvider.init({
    projectId: wcProjectId,
    chains: [baseSepolia.id],
    showQrModal: true,
    metadata: {
      name: "0xWork Quality Check",
      description: "Pay-per-grade submission grader",
      url: location.origin,
      icons: [],
    },
  });

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
    setStatus("Opening wallet…", "info");
    const provider = await ensureWalletConnected();
    const [address] = provider.accounts;
    if (!address) throw new Error("Wallet did not return an account.");

    setStatus(`Wallet paired (${short(address)}). Preparing payment…`, "info");
    const walletClient = createWalletClient({
      account: address,
      chain: baseSepolia,
      transport: custom(provider),
    });

    const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

    setStatus("Sign the payment in your wallet…", "info");
    const res = await fetchWithPayment(`${apiBase}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_type: payload.task_type,
        tier: payload.tier,
        requirements: payload.requirements,
        submission: payload.submission,
      }),
    });

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
  }
}

function short(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function setStatus(msg, kind) {
  $status.textContent = msg;
  $status.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok" : kind === "info" ? " info" : "");
}

function setBtnBusy(busy) {
  if (busy) {
    $pay.classList.add("busy");
    if ($payLabel) $payLabel.textContent = "Working…";
  } else {
    $pay.classList.remove("busy");
    if ($payLabel) $payLabel.textContent = "Pair wallet & pay";
  }
}

function fail(msg) {
  setStatus(msg, "err");
  $pay.disabled = true;
}

$pay.addEventListener("click", payAndGrade);
loadSession();
