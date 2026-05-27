import "dotenv/config";

const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
};

const optional = (name, fallback) => process.env[name] ?? fallback;
const bool = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
};
const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got ${v}`);
  return n;
};

export const config = {
  port: num("PORT", 3000),
  nodeEnv: optional("NODE_ENV", "development"),

  groq: {
    apiKey: optional("GROQ_API_KEY", ""),
    model: optional("GROQ_MODEL", "llama-3.3-70b-versatile"),
    enabled: Boolean(optional("GROQ_API_KEY", "")),
  },

  x402: {
    payTo: optional("X402_PAY_TO", "0x0000000000000000000000000000000000000000"),
    network: optional("X402_NETWORK", "base-sepolia"),
    facilitatorUrl: optional("X402_FACILITATOR_URL", "https://x402.org/facilitator"),
    bypass: bool("X402_BYPASS", false),
    cdpApiKeyId: optional("CDP_API_KEY_ID", ""),
    cdpApiKeySecret: optional("CDP_API_KEY_SECRET", ""),
  },

  pricing: {
    full: optional("PRICE_FULL_USDC", "0.10"),
  },

  rateLimit: {
    checkWindowMs: num("RATE_LIMIT_CHECK_WINDOW_MS", 15 * 60 * 1000),
    checkMax:      num("RATE_LIMIT_CHECK_MAX", 10),
    botWindowMs:   num("RATE_LIMIT_BOT_WINDOW_MS", 60 * 60 * 1000),
    botMax:        num("RATE_LIMIT_BOT_MAX", 8),
  },

  admin: {
    telegramId: optional("ADMIN_TELEGRAM_ID", ""),
  },
};
