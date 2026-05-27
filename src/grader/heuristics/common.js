// Shared utilities for category heuristics.

export const WORD_RE = /\b\w+\b/g;
export const SENT_RE = /[^.!?]+[.!?]+/g;
export const URL_RE = /https?:\/\/[^\s)<>"']+/gi;

// Count words by splitting on whitespace — this treats hyphenated compounds
// (e.g. "on-chain", "user-friendly") as single words, matching how humans
// count them and how the task poster likely set any word_count requirement.
export function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function sentences(text) {
  return text.match(SENT_RE) ?? [];
}

export function wordCount(text, required) {
  const n = words(text).length;
  // When no word count is required, never penalise on count alone.
  if (required == null) {
    return { submitted: n, required: null, pass: true };
  }
  // Allow 10% under and 50% over the target.
  const pass = n >= Math.floor(required * 0.9) && n <= Math.ceil(required * 1.5);
  return { submitted: n, required, pass };
}

export function topicCoverage(text, keywords) {
  if (!keywords || keywords.length === 0) {
    return { score: null, hits: [], missing: [] };
  }
  const lower = text.toLowerCase();
  const hits = [];
  const missing = [];
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Exact substring match first, then fuzzy: keyword appears inside a longer
    // token (e.g. "0xwork" hits "0xwork.org", "defi" hits "defi-native").
    const hit = lower.includes(kwLower) ||
      lower.split(/\s+/).some(token => token.replace(/[^a-z0-9]/g, "").includes(kwLower.replace(/[^a-z0-9]/g, "")));
    if (hit) hits.push(kw);
    else missing.push(kw);
  }
  return {
    score: Number((hits.length / keywords.length).toFixed(2)),
    hits,
    missing,
  };
}

export function extractUrls(text) {
  return text.match(URL_RE) ?? [];
}

export function uniqueDomains(urls) {
  const set = new Set();
  for (const u of urls) {
    try {
      set.add(new URL(u).hostname.replace(/^www\./, ""));
    } catch {}
  }
  return [...set];
}
