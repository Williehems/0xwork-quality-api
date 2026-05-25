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
const apiBase = params.get("api") ?? "";
const botBase = params.get("bot") ?? "";
const wcProjectId = params.get("wcProjectId") ?? "";

const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $status = document.getElementById("status");

let payload = null;
let wcProvider = null;

async function loadSession() {
  if (!sessionId || !botBase) {
    fail("Missing session or bot URL — open this from the Telegram bot.");
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
    $subMeta.textContent =
      `${String(payload.submission ?? "").split(/\s+/).filter(Boolean).length} words`;
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
  $status.className = "status";
  try {
    $status.textContent = "Opening wallet…";
    const provider = await ensureWalletConnected();
    const [address] = provider.accounts;
    if (!address) throw new Error("Wallet did not return an account.");

    $status.textContent = `Wallet paired (${short(address)}). Preparing payment…`;
    const walletClient = createWalletClient({
      account: address,
      chain: baseSepolia,
      transport: custom(provider),
    });

    const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

    $status.textContent = "Sign the payment in your wallet…";
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
    $status.textContent = "Graded. Returning verdict to chat…";

    if (tg) {
      tg.sendData(JSON.stringify(verdict));
      tg.close();
    } else {
      $status.textContent = JSON.stringify(verdict, null, 2);
    }
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    $status.textContent = "Error: " + msg;
    $status.className = "status err";
    $pay.disabled = false;
  }
}

function short(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function fail(msg) {
  $status.textContent = msg;
  $status.className = "status err";
  $pay.disabled = true;
}

$pay.addEventListener("click", payAndGrade);
loadSession();
