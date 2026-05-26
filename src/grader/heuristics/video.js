import { topicCoverage } from "./common.js";

export function videoHeuristics({ videoData, requirements }) {
  const text     = videoData?.tweetText || videoData?.fallbackText || "";
  const platform = videoData?.platform ?? "unknown";
  const thumbs   = videoData?.thumbnailUrls ?? [];

  const has_transcript = text.length > 20;
  const has_visual     = thumbs.length > 0;

  const issues = [];
  if (!has_transcript) issues.push("no_transcript");
  if (!has_visual)     issues.push("no_visual");

  const topic = topicCoverage(text, requirements?.topic_keywords);

  const heuristic_verdict =
    issues.includes("no_transcript") && issues.includes("no_visual") ? "reject"
    : issues.length > 0 ? "review"
    : null;

  return {
    platform,
    has_transcript,
    has_visual,
    content_length:  { chars: text.length, pass: text.length > 50 },
    topic_coverage:  topic,
    issues,
    heuristic_verdict,
  };
}
