import { z } from "zod";
import { grade } from "../grader/index.js";

const CheckRequestSchema = z.object({
  task_type: z
    .string()
    .min(1)
    .transform((s) => s.toLowerCase().trim()),
  tier: z.enum(["fast", "full"]).default("full"),
  requirements: z.object({
    title: z.string().min(1),
    word_count: z.number().int().positive().optional(),
    topic_keywords: z.array(z.string()).default([]),
    notes: z.string().optional(),
    char_limit: z.number().int().positive().optional(),
  }),
  submission: z.string().min(1),
});

export async function checkRoute(req, res, next) {
  try {
    const parsed = CheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;
    const verdict = await grade(input);
    res.json({
      ...verdict,
      checked_at: new Date().toISOString(),
      x402: {
        verified: !req.x402?.bypassed,
        bypassed: Boolean(req.x402?.bypassed),
        tx: req.x402?.tx ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
}
