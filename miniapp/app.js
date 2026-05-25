// Telegram Mini App for 0xWork quality check.
//
// Flow:
//   1. Read ?session=<id>&wcProjectId=<id> from the URL. apiBase/botBase
//      default to location.origin (combined server hosts both).
//   2. GET /session/<id> to load the grading payload.
//   3. On tap: lazy-import WalletConnect + viem + x402-fetch, pair the
//      wallet, sign the EIP-3009 USDC TransferWithAuthorization, retry
//      /check with X-PAYMENT header.
//   4. Return verdict to the bot via WebApp.sendData().

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
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

// Surface ANY unhandled error to the user so we don't end up with a silent
// dead page when something at module init or in an event handler throws.
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
  try {
    const res = await fetch(`${botBase}/session/${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
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
    fail("Couldn't load submission: " + (err?.message ?? String(err)));
  }
}

// Heavy wallet libs are imported lazily on first tap. This keeps the page
// usable (and the error visible) even if a CDN dep is slow or fails.
let walletLibs = null;
async function importWalletLibs() {
  if (walletLibs) return walletLibs;
  setStatus("Loading wallet libraries…");
  const [{ EthereumProvider }, viem, chains, { wrapFetchWithPayment }] = await Promise.all([
    import("https://esm.sh/@walletconnect/ethereum-provider@2.17.0"),
    import("https://esm.sh/viem@2.21.0"),
    import("https://esm.sh/viem@2.21.0/chains"),
    import("https://esm.sh/x402-fetch@1.2.0"),
  ]);
  walletLibs = {
    EthereumProvider,
    createWalletClient: viem.createWalletClient,
    custom: viem.custom,
    baseSepolia: chains.baseSepolia,
    wrapFetchWithPayment,
  };
  return walletLibs;
}

async function ensureWalletConnected(libs) {
  if (wcProvider?.accounts?.length) return wcProvider;

  if (!wcProjectId) {
    throw new Error(
      "Wallet pairing isn't configured (REOWN_PROJECT_ID missing). Ask the bot operator.",
    );
  }

  wcProvider = await libs.EthereumProvider.init({
    projectId: wcProjectId,
    chains: [libs.baseSepolia.id],
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
    setStatus("Loading wallet libraries…");
    const libs = await importWalletLibs();

    setStatus("Opening wallet…");
    const provider = await ensureWalletConnected(libs);
    const [address] = provider.accounts;
    if (!address) throw new Error("Wallet did not return an account.");

    setStatus(`Wallet paired (${short(address)}). Preparing payment…`);
    const walletClient = libs.createWalletClient({
      account: address,
      chain: libs.baseSepolia,
      transport: libs.custom(provider),
    });

    const fetchWithPayment = libs.wrapFetchWithPayment(fetch, walletClient);

    setStatus("Sign the payment in your wallet…");
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
