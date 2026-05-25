// Telegram Mini App — wallet pairing + x402 payment + API call.
//
// This is a SCAFFOLD. The real flow needs:
//   1. WalletConnect v2 client (or Coinbase Smart Wallet SDK) to pair the wallet
//   2. x402 client logic: receive 402 → sign payment payload → resend with X-Payment
//
// See:
//   https://docs.walletconnect.com/web3modal/javascript/about
//   https://www.x402.org/docs (client-side flow)
//
// Wired up:
//   - reads ?session=<id>&api=<url>&bot=<url> from the URL (bot puts these there)
//   - fetches the submission from the bot via GET ${bot}/session/${id}
//   - calls the API; on 402, surfaces payment details (real wallet flow still TODO)
//   - on success, returns the verdict to the chat via WebApp.sendData()

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
const apiBase = params.get("api") ?? "";
const botBase = params.get("bot") ?? "";

const $task = document.getElementById("task");
const $subMeta = document.getElementById("sub-meta");
const $pay = document.getElementById("pay");
const $status = document.getElementById("status");

let payload = null;

async function loadSession() {
  if (!sessionId || !botBase) {
    $status.textContent = "Missing session or bot URL — open this from the Telegram bot.";
    $status.className = "status err";
    $pay.disabled = true;
    return;
  }
  try {
    const res = await fetch(`${botBase}/session/${encodeURIComponent(sessionId)}`);
    if (res.status === 404) {
      $status.textContent = "Session expired or not found. Re-send the submission to the bot.";
      $status.className = "status err";
      $pay.disabled = true;
      return;
    }
    if (!res.ok) throw new Error(`bot ${res.status}`);
    payload = await res.json();
    $task.textContent = payload.requirements.title;
    $subMeta.textContent = `${payload.submission.split(/\s+/).filter(Boolean).length} words`;
  } catch (err) {
    $status.textContent = "Couldn't load submission: " + (err.message ?? String(err));
    $status.className = "status err";
    $pay.disabled = true;
  }
}

async function payAndGrade() {
  if (!payload) return;
  $pay.disabled = true;
  $status.className = "status";
  $status.textContent = "Pairing wallet…";

  try {
    // TODO: WalletConnect pair + sign x402 payment here.
    // const signed = await walletconnectSignX402({ amount: "0.5", currency: "USDC", network: "base" });
    const xPayment = ""; // empty == bypass mode only

    $status.textContent = "Calling API…";
    const res = await fetch(`${apiBase}/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(xPayment ? { "x-payment": xPayment } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 402) {
      const body = await res.json();
      $status.textContent =
        "Payment required: " + body.payment.amount + " USDC on " + body.payment.network;
      $status.className = "status err";
      $pay.disabled = false;
      return;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    const verdict = await res.json();
    $status.textContent = "Done. Returning verdict to chat…";

    if (tg) {
      tg.sendData(JSON.stringify(verdict));
      tg.close();
    } else {
      $status.textContent = JSON.stringify(verdict, null, 2);
    }
  } catch (err) {
    $status.textContent = "Error: " + (err.message ?? String(err));
    $status.className = "status err";
    $pay.disabled = false;
  }
}

$pay.addEventListener("click", payAndGrade);
loadSession();
