import { config } from "../config.js";

/**
 * x402 payment middleware (stub).
 *
 * Replace with the real `x402-express` paymentMiddleware once you've configured
 * a facilitator and a Base wallet. The real flow:
 *   1. If no X-PAYMENT header: respond 402 with payment requirements
 *   2. If header present: verify signed payment with facilitator
 *   3. On verified payment: attach tx info to req and call next()
 *
 * This stub:
 *   - In X402_BYPASS mode: lets every request through, marks it bypassed
 *   - Otherwise: rejects with 402 + payment details (no real verification)
 */
export function x402Middleware(req, res, next) {
  if (config.x402.bypass) {
    req.x402 = { bypassed: true, tx: null };
    return next();
  }

  const tier = req.body?.tier ?? "full";
  const amountUSDC = tier === "fast" ? config.pricing.fast : config.pricing.full;

  const payment = req.header("x-payment");
  if (!payment) {
    return res.status(402).json({
      error: "payment_required",
      payment: {
        amount: amountUSDC,
        currency: "USDC",
        network: config.x402.network,
        pay_to: config.x402.payTo,
        facilitator: config.x402.facilitatorUrl,
      },
      message: `Pay ${amountUSDC} USDC on ${config.x402.network} and retry with X-Payment header`,
    });
  }

  // TODO: call facilitator to verify the signed payment receipt
  // const verified = await facilitator.verify(payment, { amountUSDC, payTo: config.x402.payTo });
  // For now, accept any non-empty header — DO NOT ship to prod like this
  req.x402 = { bypassed: false, tx: payment };
  next();
}
