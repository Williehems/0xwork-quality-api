import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { checkRoute } from "./routes/check.js";
import { healthRoute } from "./routes/health.js";
import { mountX402 } from "./middleware/x402.js";

export function createApiApp() {
  const app = express();
  // Render sits behind a reverse proxy — trust the first hop so req.ip
  // reflects the real client IP from X-Forwarded-For, not the proxy address.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  app.use("/healthz", healthRoute);

  // Rate-limit /check before x402 verifies payment, so abusive requests
  // don't consume Groq quota or CDP verification calls.
  app.use("/check", rateLimit({
    windowMs: config.rateLimit.checkWindowMs,
    max: config.rateLimit.checkMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited", message: "Too many grading requests — try again later." },
  }));

  app.use("/healthz", healthRoute);

  mountX402(app);
  app.post("/check", checkRoute);

  app.use((err, req, res, _next) => {
    console.error("[error]", err);
    res.status(err.status ?? 500).json({
      error: err.code ?? "internal_error",
      message: err.message ?? "Something went wrong",
    });
  });

  return app;
}

export function logApiStartupNotes() {
  if (config.x402.bypass) {
    console.log("[api] x402 bypass ON — payments not enforced");
  } else {
    console.log(
      `[api] x402 ON — pay ${config.pricing.full} USDC on ${config.x402.network} to ${config.x402.payTo} via ${config.x402.facilitatorUrl}`,
    );
  }
  if (!config.groq.enabled) console.log("[api] GROQ_API_KEY not set — heuristics-only mode");
}
