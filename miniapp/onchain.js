// On-chain helpers for poster actions against TaskPool V4 on Base mainnet.
//
// The Mini App owns all chain interaction; the bot stays HTTP-only. This
// module covers calldata encoding for approveWork / rejectWork plus a
// sendAndConfirm helper that polls Base's public RPC for the receipt
// (Mini App waits for 1 confirmation before reporting success to the bot
// — see plan: "After the user signs and the transaction lands…" decision).

// ─── Chain & contract ───────────────────────────────────────────────
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_MAINNET_CHAIN_ID_HEX = "0x2105"; // 8453
export const BASE_RPC = "https://mainnet.base.org";
export const BASESCAN_TX_BASE = "https://basescan.org/tx/";

// V4 deployed Feb 28 2026 — see @0xwork/sdk constants.js
export const TASKPOOL_ADDRESS = "0xF404aFdbA46e05Af7B395FB45c43e66dB549C6D2";

// Minimal ABI subset — only the functions the Mini App actually invokes.
const TASKPOOL_ABI = [
  "function approveWork(uint256 taskId)",
  "function rejectWork(uint256 taskId)",
  // getTask is here for parity / future use; the bot pre-fetches task
  // metadata via the REST client so we don't currently call it from the
  // Mini App, but it's cheap to ship the ABI entry.
  "function getTask(uint256 taskId) view returns (tuple(address poster, address worker, string description, uint256 bountyAmount, uint256 stakeAmount, uint256 posterStakeAmount, uint256 deadline, uint256 disputeDeadline, uint256 disputeTimestamp, uint256 submitTimestamp, string proofHash, uint8 state, uint8 revisionCount, address cancelRequestedBy, uint48 postedTimestamp, uint48 claimedTimestamp, uint48 completedTimestamp, uint48 cancelledTimestamp))",
];

// ─── Lazy ethers loader ────────────────────────────────────────────
// Shared with app.js's PK signing path so the second consumer hits HTTP
// cache. jsdelivr's +esm endpoint serves the browser export so we don't
// hit the Node-entry trap the WC bundle had.
let ethersPromise = null;
export function importEthers() {
  if (!ethersPromise) {
    ethersPromise = import("https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm");
  }
  return ethersPromise;
}

// ─── Calldata encoders ─────────────────────────────────────────────
async function encodeCall(fnName, args) {
  const ethers = await importEthers();
  const iface = new ethers.Interface(TASKPOOL_ABI);
  return iface.encodeFunctionData(fnName, args);
}

export async function encodeApproveWork(taskId) {
  return encodeCall("approveWork", [BigInt(taskId)]);
}

export async function encodeRejectWork(taskId) {
  return encodeCall("rejectWork", [BigInt(taskId)]);
}

// ─── Send + poll for receipt ───────────────────────────────────────
// Submits an eth_sendTransaction through the wallet provider and polls
// Base's public RPC for the receipt. Returns { txHash, blockNumber } on
// success. Throws if the transaction is mined but reverts on-chain.
//
// The wallet returns the hash optimistically (mempool acceptance); we
// wait for 1 confirmation before reporting success so the bot's chat
// message reflects on-chain truth, not just "mempool said yes."
export async function sendAndConfirm({ provider, from, to, data }) {
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data }],
  });
  if (!txHash || typeof txHash !== "string") {
    throw new Error("Wallet did not return a transaction hash");
  }

  const ethers = await importEthers();
  const rpc = new ethers.JsonRpcProvider(BASE_RPC);

  // Base block time ~2s. Poll 1s for up to 90s.
  const start = Date.now();
  const deadline = start + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let receipt = null;
    try {
      receipt = await rpc.getTransactionReceipt(txHash);
    } catch {
      // RPC hiccup — keep polling, don't surface every transient failure.
    }
    if (!receipt) continue;
    // ethers v6: receipt.status is bigint 1 (success) / 0 (revert) or
    // number depending on RPC. Normalize.
    const status = typeof receipt.status === "bigint" ? Number(receipt.status) : receipt.status;
    if (status === 0) {
      throw new Error(`Transaction reverted on-chain — see ${BASESCAN_TX_BASE}${txHash}`);
    }
    return { txHash, blockNumber: Number(receipt.blockNumber) };
  }
  // Timed out. Return the hash anyway so the user has a record — the
  // tx might still confirm; we just couldn't watch it complete.
  throw new Error(
    `Tx not confirmed within 90s — it may still land. Check ${BASESCAN_TX_BASE}${txHash}`,
  );
}

// ─── Chain switching ───────────────────────────────────────────────
// Ensures the wallet provider is pointed at Base mainnet. Handles the
// 4902 "unrecognized chain" case by adding the network with sane RPC
// + explorer defaults.
export async function ensureBaseMainnet(provider) {
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === BASE_MAINNET_CHAIN_ID_HEX) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_MAINNET_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_MAINNET_CHAIN_ID_HEX,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [BASE_RPC],
          blockExplorerUrls: ["https://basescan.org"],
        }],
      });
    } else {
      throw err;
    }
  }
}
