// LLM grader for results-based tasks.
//
// Routes through Groq's vision model when image proof URLs exist (screenshots,
// thumbnails); otherwise text-only. The judgment criterion is "did the worker
// demonstrably achieve the outcome described in target_action?" — not content
// quality. The prompt explicitly forbids penalizing for length/coverage.

import Groq from "groq-sdk";
import { config } from "../config.js";
import * as settings from "../settings.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { VISION_MODEL } from "./video.js";

let _client = null;
function groqClient() {
  if (!_client) _client = new Groq({ apiKey: config.groq.apiKey });
  return _client;
}

function buildResultText({ requirements, submission, evidence, meta, videoData, heuristics }) {
  const evidenceLines = (evidence ?? []).slice(0, 10).map((e, i) => {
    const parts = [`${i + 1}.`];
    if (e.label) parts.push(`[${e.label}]`);
    if (e.kind) parts.push(`(${e.kind})`);
    if (e.url) parts.push(e.url);
    if (e.note) parts.push(`— ${e.note}`);
    return parts.join(" ");
  });

  const lines = [
    `TASK CATEGORY: result`,
    "",
    "TASK REQUIREMENTS:",
    JSON.stringify(requirements, null, 2),
    "",
    "HEURISTIC RESULTS:",
    JSON.stringify(heuristics, null, 2),
    "",
  ];

  if (meta?.proof_url) lines.push(`PROOF URL: ${meta.proof_url}`);
  if (meta?.proof_type) lines.push(`PROOF TYPE: ${meta.proof_type}`);
  if (meta?.content_hash) lines.push(`CONTENT HASH: ${meta.content_hash}`);
  if (Array.isArray(meta?.artifact_refs) && meta.artifact_refs.length) {
    lines.push(`ARTIFACT REFS: ${meta.artifact_refs.join(", ")}`);
  }
  if (meta?.summary) {
    lines.push("", "WORKER SUMMARY:", "<<<", meta.summary, ">>>");
  }
  if (evidenceLines.length) {
    lines.push("", "EVIDENCE:", ...evidenceLines);
  }
  if (videoData?.tweetText) {
    lines.push("", "ASSOCIATED TWEET TEXT:", "<<<", videoData.tweetText, ">>>");
  }
  if (submission && submission.trim()) {
    lines.push("", "SUBMISSION TEXT:", "<<<", submission.trim(), ">>>");
  }
  lines.push("",
    "Judge whether the worker demonstrably achieved the target_action, evidenced by at least one of the success_signals. " +
    "Short submission text is fine — proof quality is the criterion. " +
    "Do NOT penalize for word count, char limit, or topic coverage. " +
    "If proof is missing or unrelated to the target, reject. " +
    "If proof is plausible but ambiguous (e.g., a hash with no public URL), use 'review'.",
    "",
    "Return your verdict as a single JSON object.",
  );
  return lines.join("\n");
}

export async function llmGradeResult({ requirements, submission, evidence, meta, videoData, heuristics }) {
  if (!config.groq.enabled) throw new Error("Groq disabled (no GROQ_API_KEY)");

  // Collect image URLs: heuristic-extracted + video thumbnails (for video+result tasks).
  const heuristicImages = Array.isArray(heuristics?.image_urls) ? heuristics.image_urls : [];
  const videoThumbs = Array.isArray(videoData?.thumbnailUrls) ? videoData.thumbnailUrls : [];
  const imageUrls = [...new Set([...heuristicImages, ...videoThumbs])]
    .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
    .slice(0, 5);

  const textPart = buildResultText({ requirements, submission, evidence, meta, videoData, heuristics });

  const userContent = [{ type: "text", text: textPart }];
  for (const url of imageUrls) {
    userContent.push({ type: "image_url", image_url: { url } });
  }

  const model = imageUrls.length > 0 ? VISION_MODEL : settings.get("groq_model", config.groq.model);

  const completion = await groqClient().chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 600,
    },
    { signal: AbortSignal.timeout(30_000) },
  );

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  return {
    verdict:    parsed.verdict    ?? "review",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    reasoning:  parsed.reasoning  ?? "",
    strengths:  Array.isArray(parsed.strengths) ? parsed.strengths : [],
    concerns:   Array.isArray(parsed.concerns)  ? parsed.concerns  : [],
    model,
  };
}
