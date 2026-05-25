// Inline x402 client. Replaces x402-fetch + viem dependency tree.
//
// Drives the 402 → sign → retry flow with just an EIP-1193 provider and
// the browser's built-in btoa + crypto.getRandomValues.

export const NETWORK_TO_CHAIN_ID = {
  "base-sepolia": 84532,
  "base": 8453,
};

export function randomNonce32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function signX402Authorization(provider, address, x402Version, reqSpec) {
  const chainId = NETWORK_TO_CHAIN_ID[reqSpec.network];
  if (!chainId) throw new Error(`Unknown x402 network: ${reqSpec.network}`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: address,
    to: reqSpec.payTo,
    value: String(reqSpec.maxAmountRequired),
    validAfter: "0",
    validBefore: String(now + 600),
    nonce: randomNonce32(),
  };

  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    domain: {
      name: reqSpec.extra?.name ?? "USDC",
      version: reqSpec.extra?.version ?? "2",
      chainId,
      verifyingContract: reqSpec.asset,
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  };

  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  });

  const paymentPayload = {
    x402Version,
    scheme: "exact",
    network: reqSpec.network,
    payload: { signature, authorization },
  };

  return btoa(JSON.stringify(paymentPayload));
}
