// Shared utilities for category heuristics.

export const WORD_RE = /\b\w+\b/g;
export const SENT_RE = /[^.!?]+[.!?]+/g;
export const URL_RE = /https?:\/\/[^\s)<>"']+/gi;

export function words(text) {
  return text.match(WORD_RE) ?? [];
}

export function sentences(text) {
  return text.match(SENT_RE) ?? [];
}

export function wordCount(text, required) {
  const n = words(text).length;
  return {
    submitted: n,
    required: required ?? null,
    pass:
      required == null
        ? true
        : n >= Math.floor(required * 0.9) && n <= Math.ceil(required * 1.5),
  };
}

export function topicCoverage(text, keywords) {
  if (!keywords || keywords.length === 0) {
    return { score: null, hits: [], missing: [] };
  }
  const lower = text.toLowerCase();
  const hits = [];
  const missing = [];
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
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
