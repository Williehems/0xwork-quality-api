import rs from "text-readability";
import { WORD_RE, sentences, wordCount, topicCoverage } from "./common.js";

export function writingHeuristics({ submission, requirements }) {
  const text = submission.trim();
  const sents = sentences(text);

  const grade = sents.length > 0 ? rs.fleschKincaidGrade(text) : null;
  const ease = sents.length > 0 ? rs.fleschReadingEase(text) : null;

  return {
    word_count: wordCount(text, requirements.word_count),
    readability: {
      flesch_kincaid_grade: grade,
      flesch_reading_ease: ease,
      band: bandForEase(ease),
    },
    structure: sentenceStructure(sents),
    topic_coverage: topicCoverage(text, requirements.topic_keywords),
  };
}

function bandForEase(ease) {
  if (ease == null) return "unknown";
  if (ease >= 70) return "easy";
  if (ease >= 50) return "standard";
  if (ease >= 30) return "difficult";
  return "very_difficult";
}

function sentenceStructure(sents) {
  if (sents.length < 3) {
    return { sentence_count: sents.length, variance: "insufficient_data", issues: [] };
  }
  const lengths = sents.map((s) => (s.match(WORD_RE) ?? []).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance =
    lengths.reduce((acc, n) => acc + (n - mean) ** 2, 0) / lengths.length;
  const stdev = Math.sqrt(variance);
  const cv = mean === 0 ? 0 : stdev / mean;
  const issues = [];
  if (cv < 0.25) issues.push("uniform_sentence_length");
  if (mean > 35) issues.push("very_long_sentences");
  if (mean < 6) issues.push("very_short_sentences");
  // Both uniform length AND short mean sentence length together is a strong
  // signal of low-effort template or AI-generated filler text.
  if (cv < 0.25 && mean < 9) issues.push("repetitive_structure");
  return {
    sentence_count: sents.length,
    mean_length: Number(mean.toFixed(1)),
    stdev_length: Number(stdev.toFixed(1)),
    coefficient_of_variation: Number(cv.toFixed(2)),
    variance: cv >= 0.3 ? "good" : cv >= 0.2 ? "fair" : "low",
    issues,
  };
}
