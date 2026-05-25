import { writingHeuristics } from "./writing.js";
import { extractUrls, uniqueDomains } from "./common.js";

const SECTION_KEYWORDS = [
  "introduction",
  "background",
  "methods",
  "methodology",
  "approach",
  "results",
  "findings",
  "analysis",
  "discussion",
  "conclusion",
  "conclusions",
  "references",
  "sources",
  "citations",
];

const REF_MARKER_RE = /\[\d+\]|\(\w+\s+et\s+al\.?,?\s*\d{4}\)|\(\d{4}\)/g;

export function researchHeuristics({ submission, requirements }) {
  const writing = writingHeuristics({ submission, requirements });
  const text = submission;
  const lower = text.toLowerCase();

  const urls = extractUrls(text);
  const domains = uniqueDomains(urls);
  const refMarkers = (text.match(REF_MARKER_RE) ?? []).length;
  const sectionsFound = SECTION_KEYWORDS.filter((s) =>
    new RegExp(`(^|\\n)\\s*#{1,3}\\s*${s}\\b|\\b${s}\\b\\s*:`, "i").test(text) ||
    lower.includes(`\n${s}\n`) ||
    lower.includes(`\n${s}:`),
  );

  const issues = [];
  if (urls.length === 0 && refMarkers === 0) issues.push("no_citations");
  if (urls.length > 0 && domains.length === 1) issues.push("single_source_domain");
  if (sectionsFound.length < 2) issues.push("missing_section_structure");

  return {
    ...writing,
    citations: {
      url_count: urls.length,
      unique_domains: domains.length,
      ref_markers: refMarkers,
      domains: domains.slice(0, 10),
    },
    sections_found: sectionsFound,
    research_issues: issues,
  };
}
