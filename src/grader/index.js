import { runHeuristics, normalizeTaskType } from "./heuristics/index.js";
import { llmGrade } from "./llm.js";
import { detectCategoryFromSubmission, llmGradeVideo } from "./video.js";
import { config } from "../config.js";

export async function grade({ task_type, tier, requirements, submission }) {
  const hintCategory = normalizeTaskType(task_type);

  // Detect actual content type from submission URL/content.
  // For plain text the hint is returned unchanged; for known URLs (Twitter,
  // YouTube, GitHub, etc.) the content is inspected to override the hint.
  const { category, videoData } = await detectCategoryFromSubmission(submission, hintCategory);

  // When detection fetched content from a URL (tweet text, page text), use that
  // as the effective submission for text-based heuristics instead of the raw URL.
  // For video tasks videoData is consumed directly; for social/writing tasks the
  // tweet text replaces the URL so character counts, topic coverage, etc. are real.
  const effectiveSubmission =
    (videoData?.tweetText || videoData?.fallbackText) || submission;

  const heuristics = runHeuristics({
    task_type: category, submission: effectiveSubmission, requirements, videoData,
  });

  if (tier === "fast" || !config.groq.enabled) {
    return {
      task_type: category,
      tier,
      verdict: heuristicVerdict(heuristics),
      reasoning: heuristicReason(heuristics),
      evidence: heuristics,
      llm: null,
      fallback: !config.groq.enabled && tier !== "fast",
    };
  }

  try {
    const llm = category === "video"
      ? await llmGradeVideo({ task_type: category, requirements, videoData, heuristics })
      : await llmGrade({ task_type: category, requirements, submission: effectiveSubmission, heuristics });

    return {
      task_type: category,
      tier: "full",
      verdict: llm.verdict,
      reasoning: llm.reasoning,
      confidence: llm.confidence,
      strengths: llm.strengths,
      concerns: llm.concerns,
      evidence: heuristics,
      llm: { model: llm.model },
      fallback: false,
    };
  } catch (err) {
    console.warn("[grader] LLM failed, falling back to heuristics:", err.message);
    return {
      task_type: category,
      tier: "full",
      verdict: heuristicVerdict(heuristics),
      reasoning: `LLM unavailable, heuristics only: ${heuristicReason(heuristics)}`,
      evidence: heuristics,
      llm: null,
      fallback: true,
      llm_error: err.message,
    };
  }
}

function heuristicVerdict(h) {
  // Video has independent logic — skip global word_count / topic_coverage checks
  // which would misfire on empty tweet text.
  if (h.category === "video") {
    if (h.heuristic_verdict === "reject") return "reject";
    if (h.heuristic_verdict === "review") return "review";
    if (h.topic_coverage?.score != null && h.topic_coverage.score < 0.3) return "reject";
    if (h.topic_coverage?.score != null && h.topic_coverage.score < 0.6) return "review";
    return "approve";
  }

  // Category-agnostic base rules.
  if (h.word_count?.required != null && !h.word_count.pass) return "reject";
  if (h.topic_coverage?.score != null && h.topic_coverage.score < 0.5) return "reject";

  if (h.category === "code") {
    const issues = h.structure?.issues ?? [];
    if (issues.some((i) => i.startsWith("unbalanced_") || i === "very_few_code_lines"))
      return "reject";
    if (issues.length) return "review";
  }
  if (h.category === "social") {
    if (h.character_count && !h.character_count.pass) return "reject";
    if ((h.issues ?? []).length) return "review";
  }
  if (h.category === "research") {
    if ((h.research_issues ?? []).includes("no_citations")) return "reject";
    if ((h.research_issues ?? []).length) return "review";
  }
  if (h.category === "data") {
    if ((h.issues ?? []).includes("json_parse_failed") || (h.issues ?? []).includes("very_few_rows")) return "reject";
    if ((h.issues ?? []).includes("format_mismatch")) return "review";
  }
  // uniform_sentence_length is passed as evidence to the LLM which treats it
  // as a concern, not an auto-reject. Don't escalate it in the heuristic
  // verdict — let the LLM decide based on the full context.
  if (h.topic_coverage?.score != null && h.topic_coverage.score < 0.8) return "review";
  return "approve";
}

function heuristicReason(h) {
  const bits = [];
  if (h.category === "video") {
    bits.push(`platform: ${h.platform}`);
    if (!h.has_transcript) bits.push("no tweet text");
    if (!h.has_visual) bits.push("no thumbnail");
    if (h.content_length) bits.push(`${h.content_length.chars} chars`);
  } else if (h.word_count?.required != null) {
    bits.push(
      `word count ${h.word_count.submitted}/${h.word_count.required} (${h.word_count.pass ? "ok" : "fail"})`,
    );
  } else if (h.word_count) {
    bits.push(`${h.word_count.submitted} words`);
  }
  if (h.category === "code") {
    if (h.language) bits.push(`language: ${h.language}`);
    if (h.line_count) bits.push(`${h.line_count.code} code / ${h.line_count.comments} comment lines`);
    if (h.structure?.issues?.length) bits.push(`code: ${h.structure.issues.join(", ")}`);
  } else if (h.category === "social") {
    if (h.character_count) bits.push(`${h.character_count.submitted}/${h.character_count.limit} chars`);
    if (h.hashtags) bits.push(`${h.hashtags.count} hashtags`);
  } else if (h.category === "research") {
    if (h.citations) bits.push(`${h.citations.url_count} citations, ${h.citations.unique_domains} domains`);
    if (h.research_issues?.length) bits.push(h.research_issues.join(", "));
  } else if (h.category === "data") {
    if (h.format) bits.push(`format: ${h.format}`);
    if (h.csv_shape) bits.push(`${h.csv_shape.row_count} rows × ${h.csv_shape.column_count} cols`);
    if (h.json_shape) bits.push(`json: ${h.json_shape.top_type}`);
  } else if (h.category !== "video") {
    if (h.readability?.band && h.readability.band !== "unknown") {
      bits.push(`readability ${h.readability.band}`);
    }
    if (h.structure?.issues?.length) bits.push(`structure: ${h.structure.issues.join(", ")}`);
  }
  if (h.topic_coverage?.score != null) {
    bits.push(`topic coverage ${Math.round(h.topic_coverage.score * 100)}%`);
  }
  return bits.join("; ");
}
