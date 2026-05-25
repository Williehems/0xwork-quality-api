import express from "express";
import { config } from "./config.js";
import { checkRoute } from "./routes/check.js";
import { healthRoute } from "./routes/health.js";
import { x402Middleware } from "./middleware/x402.js";

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

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port} (env=${config.nodeEnv})`);
  if (config.x402.bypass) console.log("[api] x402 bypass ON — payments not enforced");
  if (!config.groq.enabled) console.log("[api] GROQ_API_KEY not set — heuristics-only mode");
});
