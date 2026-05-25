import express from "express";
import { config } from "./config.js";
import { checkRoute } from "./routes/check.js";
import { healthRoute } from "./routes/health.js";
import { x402Middleware } from "./middleware/x402.js";

export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use("/healthz", healthRoute);
  app.post("/check", x402Middleware, checkRoute);

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
  if (config.x402.bypass) console.log("[api] x402 bypass ON — payments not enforced");
  if (!config.groq.enabled) console.log("[api] GROQ_API_KEY not set — heuristics-only mode");
}
