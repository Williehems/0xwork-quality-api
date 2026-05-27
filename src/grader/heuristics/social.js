import { wordCount, topicCoverage, extractUrls } from "./common.js";

const HASHTAG_RE = /(?:^|\s)#[A-Za-z0-9_]+/g;
const MENTION_RE = /(?:^|\s)@[A-Za-z0-9_]+/g;

export function socialHeuristics({ submission, requirements }) {
  const text = submission.trim();
  const chars = [...text].length;
  const hashtags = (text.match(HASHTAG_RE) ?? []).map((s) => s.trim());
  const mentions = (text.match(MENTION_RE) ?? []).map((s) => s.trim());
  const urls = extractUrls(text);
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;

  const limit = requirements.char_limit ?? 280;
  const overLimit = chars > limit;

  const issues = [];
  if (overLimit) issues.push(`over_char_limit:${chars}/${limit}`);
  if (hashtags.length === 0) issues.push("no_hashtags");
  // Only flag very_short_post when it's both short AND has no hashtags —
  // a short post with hashtags and good topic coverage is a valid tweet.
  if (lineCount === 1 && chars < 50 && hashtags.length === 0) issues.push("very_short_post");

  return {
    character_count: { submitted: chars, limit, pass: !overLimit },
    word_count: wordCount(text, requirements.word_count),
    hashtags: { count: hashtags.length, values: hashtags.slice(0, 10) },
    mentions: { count: mentions.length, values: mentions.slice(0, 10) },
    links: { count: urls.length },
    line_count: lineCount,
    topic_coverage: topicCoverage(text, requirements.topic_keywords),
    issues,
  };
}
