// Heuristics for results-based tasks.
//
// These tasks are graded on whether the worker demonstrably achieved an
// outcome (a follow, a retweet, a metric hit) — not on whether they wrote
// good content. Deliberately omits word_count / char_limit / topic_coverage
// so the global rejection rules in src/grader/index.js can't misfire.

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(\?|$)/i;
const HASH_ONLY_RE = /^[0-9a-fA-F]{40,}$/;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "as", "by", "at", "from", "that", "this", "it",
  "get", "make", "do", "have", "has",
]);

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9@_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function uniq(arr) {
  return [...new Set(arr)];
}

export function resultHeuristics({ submission, requirements, evidence, meta }) {
  const ev = Array.isArray(evidence) ? evidence : [];
  const summary = String(meta?.summary ?? "").trim();
  const proofUrl = meta?.proof_url ?? "";
  const isHashOnly = proofUrl ? HASH_ONLY_RE.test(proofUrl) : false;
  const hasUrl = Boolean(proofUrl) && !isHashOnly;
  const submissionText = String(submission ?? "").trim();

  const imageUrls = uniq([
    ...(IMAGE_EXT_RE.test(proofUrl) ? [proofUrl] : []),
    ...ev.map((e) => e?.url).filter((u) => typeof u === "string" && IMAGE_EXT_RE.test(u)),
  ]);

  // Lightweight target-signal scan: does the submission or worker summary
  // mention any token from success_signals or target_action?
  const haystack = `${submissionText}\n${summary}`.toLowerCase();
  const signalTokens = uniq([
    ...(requirements.success_signals ?? []).flatMap(tokens),
    ...tokens(requirements.target_action ?? ""),
  ]);
  const matched = signalTokens.filter((t) => haystack.includes(t));
  const target_signal_match = signalTokens.length === 0
    ? { score: null, matched: [], missing: [] }
    : {
        score: Number((matched.length / signalTokens.length).toFixed(2)),
        matched,
        missing: signalTokens.filter((t) => !matched.includes(t)),
      };

  const proof_presence = {
    has_url: hasUrl,
    is_hash_only: isHashOnly,
    has_summary: summary.length > 0,
    has_content_hash: Boolean(meta?.content_hash),
    evidence_count: ev.length,
    artifact_count: Array.isArray(meta?.artifact_refs) ? meta.artifact_refs.length : 0,
    image_url_count: imageUrls.length,
  };

  const issues = [];
  if (!hasUrl && !proof_presence.has_summary && proof_presence.evidence_count === 0
      && !proof_presence.is_hash_only && !proof_presence.has_content_hash) {
    issues.push("no_proof");
  }
  if (proof_presence.is_hash_only && proof_presence.evidence_count === 0 && !proof_presence.has_summary) {
    issues.push("only_hash");
  }
  if (target_signal_match.score != null && target_signal_match.score === 0 && proof_presence.has_summary) {
    issues.push("summary_lacks_target_signals");
  }

  return {
    proof_presence,
    target_signal_match,
    target_action: requirements.target_action ?? null,
    success_signals: requirements.success_signals ?? [],
    image_urls: imageUrls,
    issues,
  };
}
