import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { checkRoute } from "./routes/check.js";
import { healthRoute } from "./routes/health.js";
import { statsRoute } from "./routes/stats.js";
import { homeRoute } from "./routes/home.js";
import { mountX402 } from "./middleware/x402.js";
import * as settings from "./settings.js";

export function createApiApp() {
  const app = express();
  // Render sits behind a reverse proxy — trust the first hop so req.ip
  // reflects the real client IP from X-Forwarded-For, not the proxy address.
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/", homeRoute);
  app.use("/healthz", healthRoute);
  app.get("/stats", statsRoute);
  app.get("/stats.json", statsRoute);

  // Maintenance gate — admin can flip this without a redeploy.
  app.use("/check", (req, res, next) => {
    if (settings.getBool("maintenance", false)) {
      return res.status(503).json({
        error: "maintenance",
        message: "Grading is temporarily paused. Check back soon.",
      });
    }
    next();
  });

  // Rate-limit /check before x402 verifies payment, so abusive requests
  // don't consume Groq quota or CDP verification calls.
  // max is a function so the admin can change it at runtime via /admin.
  app.use("/check", rateLimit({
    windowMs: config.rateLimit.checkWindowMs,
    max: (req) => settings.getNum("rate_api_max", config.rateLimit.checkMax),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited", message: "Too many grading requests — try again later." },
  }));

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
