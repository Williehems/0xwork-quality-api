import { paymentMiddleware } from "x402-express";
import { createFacilitatorConfig } from "@coinbase/x402";
import { config } from "../config.js";
import * as settings from "../settings.js";

// Facilitator is stateless and never needs to be rebuilt — build it once.
const _facilitator = config.x402.cdpApiKeyId && config.x402.cdpApiKeySecret
  ? createFacilitatorConfig(config.x402.cdpApiKeyId, config.x402.cdpApiKeySecret)
  : { url: config.x402.facilitatorUrl };

// Lazy-cache the payment middleware. It is rebuilt only when the price setting
// changes so that /admin price updates take effect without a redeploy.
let _cachedMiddleware = null;
let _cachedPrice = null;

function getPaymentMiddleware() {
  const currentPrice = settings.get("price", config.pricing.full);
  if (_cachedMiddleware && _cachedPrice === currentPrice) return _cachedMiddleware;
  _cachedMiddleware = paymentMiddleware(
    config.x402.payTo,
    {
      "POST /check": {
        price: `$${currentPrice}`,
        network: config.x402.network,
        config: {
          description: "0xWork submission quality grade",
          mimeType: "application/json",
        },
      },
    },
    _facilitator,
  );
  _cachedPrice = currentPrice;
  return _cachedMiddleware;
}

/**
 * Mounts a per-request dynamic x402 gate on `app`.
 *
 * Both bypass and price are checked against the runtime settings layer so the admin
 * can toggle payment enforcement and change the grade price without a redeploy.
 */
export function mountX402(app) {
  app.use((req, res, next) => {
    if (req.method !== "POST" || req.path !== "/check") return next();

    const bypassed = settings.getBool("bypass", config.x402.bypass);
    if (bypassed) {
      req.x402 = { bypassed: true, tx: null };
      return next();
    }

    return getPaymentMiddleware()(req, res, next);
  });

  // Mark paid-but-not-yet-tagged requests so checkRoute can include verified: true.
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path === "/check" && !req.x402) {
      req.x402 = { bypassed: false, tx: null };
    }
    next();
  });
}
