import { paymentMiddleware } from "x402-express";
import { createFacilitatorConfig } from "@coinbase/x402";
import { config } from "../config.js";
import * as settings from "../settings.js";

// Build the real payment middleware once at startup. It is used on every request
// where the runtime "bypass" setting is false. Creating it once avoids re-initialising
// the facilitator connection on each request.
const _facilitator = config.x402.cdpApiKeyId && config.x402.cdpApiKeySecret
  ? createFacilitatorConfig(config.x402.cdpApiKeyId, config.x402.cdpApiKeySecret)
  : { url: config.x402.facilitatorUrl };

const _realPaymentMiddleware = paymentMiddleware(
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
  _facilitator,
);

/**
 * Mounts a per-request dynamic x402 gate on `app`.
 *
 * Bypass is checked on every request against the runtime settings layer so the admin
 * can toggle payment enforcement without a redeploy. When bypass is on, a no-op shim
 * marks req.x402 = { bypassed: true } and passes through. When bypass is off, the real
 * payment middleware runs (verifies X-PAYMENT header, settles on-chain on the way out).
 */
export function mountX402(app) {
  app.use((req, res, next) => {
    if (req.method !== "POST" || req.path !== "/check") return next();

    const bypassed = settings.getBool("bypass", config.x402.bypass);
    if (bypassed) {
      req.x402 = { bypassed: true, tx: null };
      return next();
    }

    return _realPaymentMiddleware(req, res, next);
  });

  // Mark paid-but-not-yet-tagged requests so checkRoute can include verified: true.
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path === "/check" && !req.x402) {
      req.x402 = { bypassed: false, tx: null };
    }
    next();
  });
}
