import { writingHeuristics } from "./writing.js";
import { wordCount, topicCoverage } from "./common.js";

// Detect common data formats so the LLM knows what it's grading.
function detectFormat(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {}
  }
  const lines = t.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length >= 2) {
    const firstCommas = (lines[0].match(/,/g) ?? []).length;
    const secondCommas = (lines[1].match(/,/g) ?? []).length;
    if (firstCommas > 0 && firstCommas === secondCommas) return "csv";
  }
  if (/^\|.+\|$/m.test(t) && /^\|[-:\s|]+\|$/m.test(t)) return "markdown_table";
  return "prose";
}

export function dataHeuristics({ submission, requirements }) {
  const format = detectFormat(submission);

  if (format === "json") {
    let parsed;
    try {
      parsed = JSON.parse(submission);
    } catch {}
    return {
      format,
      json_shape: parsed
        ? {
            top_type: Array.isArray(parsed) ? "array" : typeof parsed,
            top_keys: Array.isArray(parsed)
              ? null
              : Object.keys(parsed).slice(0, 20),
            length: Array.isArray(parsed) ? parsed.length : null,
          }
        : null,
      word_count: wordCount(submission, requirements.word_count),
      topic_coverage: topicCoverage(submission, requirements.topic_keywords),
      issues: parsed ? [] : ["json_parse_failed"],
    };
  }

  if (format === "csv") {
    const lines = submission.trim().split(/\r?\n/).filter((l) => l.length > 0);
    const headers = lines[0]?.split(",").map((s) => s.trim()) ?? [];
    return {
      format,
      csv_shape: {
        row_count: lines.length - 1,
        column_count: headers.length,
        headers,
      },
      word_count: wordCount(submission, requirements.word_count),
      topic_coverage: topicCoverage(submission, requirements.topic_keywords),
      issues: lines.length < 3 ? ["very_few_rows"] : [],
    };
  }

  // Prose / markdown report — fall back to writing heuristics for the body.
  // Flag format_mismatch if the task description implies structured data was expected.
  const notesLower = (requirements.notes ?? requirements.title ?? "").toLowerCase();
  const structuredExpected = /\b(csv|json|table|spreadsheet|dataset|rows?|columns?|structured)\b/.test(notesLower);
  const issues = structuredExpected ? ["format_mismatch"] : [];
  return { format, issues, ...writingHeuristics({ submission, requirements }) };
}
