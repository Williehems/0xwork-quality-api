import { z } from "zod";
import { grade } from "../grader/index.js";
import { logGrade } from "../../db/index.js";
import { config } from "../config.js";
import * as settings from "../settings.js";

const EvidenceItemSchema = z.object({
  label: z.string().optional(),
  kind: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});

const MetaSchema = z.object({
  proof_url: z.string().optional(),
  content_hash: z.string().optional(),
  artifact_refs: z.array(z.string()).optional(),
  summary: z.string().optional(),
  results_based: z.boolean().optional(),
  proof_type: z.string().optional(),
  raw_submission: z.string().optional(),
});

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
    target_action: z.string().optional(),
    success_signals: z.array(z.string()).default([]),
  }),
  submission: z.string().default(""),
  evidence: z.array(EvidenceItemSchema).default([]),
  meta: MetaSchema.optional(),
}).superRefine((data, ctx) => {
  // Submission may be empty only when there's evidence to grade (result tasks).
  if ((data.submission?.length ?? 0) === 0 && data.evidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["submission"],
      message: "submission is required unless evidence[] is provided",
    });
  }
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

    // Fire-and-forget — never block the response on a DB write.
    const usdcAmount = req.x402?.bypassed
      ? 0
      : parseFloat(settings.get("price", config.pricing.full) ?? 0);
    logGrade({
      verdict:    verdict.verdict,
      taskType:   input.task_type,
      tier:       input.tier,
      confidence: verdict.confidence ?? null,
      usdcAmount,
      fallback:   Boolean(verdict.fallback),
    }).catch(() => {});

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
