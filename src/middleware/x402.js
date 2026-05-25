import { paymentMiddleware } from "x402-express";
import { config } from "../config.js";

/**
 * Mounts the x402 paywall on `app`, protecting POST /check at the configured
 * full-tier price. Verifies the X-PAYMENT header via the facilitator on the way
 * in, and settles the payment on-chain on the way out.
 *
 * In X402_BYPASS mode (local dev), installs a no-op gate that marks every
 * /check request as bypassed so the route handler still populates response
 * metadata cleanly.
 */
export function mountX402(app) {
  if (config.x402.bypass) {
    app.use((req, _res, next) => {
      if (req.method === "POST" && req.path === "/check") {
        req.x402 = { bypassed: true, tx: null };
      }
      next();
    });
    return;
  }

  app.use(
    paymentMiddleware(
      config.x402.payTo,
      {
        "POST /check": {
          price: `$${config.pricing.full}`,
          network: config.x402.network,
          config: {
            description: "0xWork submission quality grade",
            mimeType: "application/json",
          },
        },
      },
      { url: config.x402.facilitatorUrl },
    ),
  );

  // After paymentMiddleware passes a request through, mark it as paid so
  // checkRoute can include `x402.verified: true` in the response body.
  // (The on-chain settle hash isn't available until res.end() — it ships in
  // the X-PAYMENT-RESPONSE header set by paymentMiddleware itself.)
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path === "/check" && !req.x402) {
      req.x402 = { bypassed: false, tx: null };
    }
    next();
  });
}
