import { wordCount, topicCoverage } from "./common.js";

const LANG_HINTS = [
  { name: "javascript", re: /\b(const|let|var|function|=>|require\(|module\.exports|import\s+.+\s+from)\b/g },
  { name: "typescript", re: /\b(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|: ?(string|number|boolean|void|any|unknown))\b/g },
  { name: "python",     re: /\b(def\s+\w+|class\s+\w+|import\s+\w+|from\s+\w+\s+import|self\.|elif\b|async\s+def)\b/g },
  { name: "go",         re: /\b(func\s+\w+|package\s+\w+|fmt\.|err\s*:=|chan\s+\w+)\b/g },
  { name: "rust",       re: /\b(fn\s+\w+|let\s+mut|impl\s+\w+|match\s+\w+|use\s+std::)\b/g },
  { name: "java",       re: /\b(public\s+(class|static)|void\s+main\(|System\.out\.println|import\s+java\.)\b/g },
  { name: "shell",      re: /(?:^|\n)\s*#!\/.+sh|(^|\n)\s*(echo|grep|awk|sed|cat|ls|cd|mkdir|export)\s/g },
  { name: "sql",        re: /\b(SELECT|FROM|WHERE|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|JOIN)\b/gi },
];

const COMMENT_PATTERNS = [
  /^\s*\/\//,    // js/ts/c-style
  /^\s*#/,       // python/shell
  /^\s*\/\*/,    // block start
  /^\s*\*/,      // block middle
  /^\s*--/,      // sql
];

export function codeHeuristics({ submission, requirements }) {
  const text = submission;
  const lines = text.split(/\r?\n/);
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const commentLines = lines.filter((l) => COMMENT_PATTERNS.some((re) => re.test(l)));
  const codeLines = nonEmptyLines.length - commentLines.length;

  const language = detectLanguage(text);

  const functionsLike = (text.match(/(\bfunction\s+\w+|\bdef\s+\w+|\bfn\s+\w+|\bfunc\s+\w+|\bclass\s+\w+|=>\s*[{(])/g) ?? [])
    .length;

  const placeholders = countAll(text, /\b(TODO|FIXME|XXX|HACK|PLACEHOLDER)\b/g);
  const ellipses = countAll(text, /(^|[^.])\.\.\.\s*$/gm);

  const braceBalance = balance(text, "{", "}");
  const parenBalance = balance(text, "(", ")");
  const bracketBalance = balance(text, "[", "]");

  const issues = [];
  if (codeLines < 5) issues.push("very_few_code_lines");
  if (functionsLike === 0 && codeLines > 20) issues.push("no_functions_or_classes");
  if (placeholders > 0) issues.push(`placeholders_present:${placeholders}`);
  if (ellipses > 2) issues.push("excessive_ellipses");
  if (braceBalance !== 0) issues.push(`unbalanced_braces:${braceBalance}`);
  if (parenBalance !== 0) issues.push(`unbalanced_parens:${parenBalance}`);
  if (bracketBalance !== 0) issues.push(`unbalanced_brackets:${bracketBalance}`);
  if (codeLines > 0 && commentLines / codeLines > 1) issues.push("more_comments_than_code");

  return {
    language,
    line_count: {
      total: lines.length,
      non_empty: nonEmptyLines.length,
      code: codeLines,
      comments: commentLines.length,
    },
    word_count: wordCount(text, requirements.word_count),
    structure: {
      functions_or_classes: functionsLike,
      placeholders,
      brace_balance: braceBalance,
      paren_balance: parenBalance,
      bracket_balance: bracketBalance,
      issues,
    },
    topic_coverage: topicCoverage(text, requirements.topic_keywords),
  };
}

function detectLanguage(text) {
  let best = { name: "unknown", score: 0 };
  for (const { name, re } of LANG_HINTS) {
    const n = (text.match(re) ?? []).length;
    if (n > best.score) best = { name, score: n };
  }
  return best.score >= 2 ? best.name : "unknown";
}

function countAll(text, re) {
  return (text.match(re) ?? []).length;
}

function balance(text, open, close) {
  let depth = 0;
  for (const c of text) {
    if (c === open) depth++;
    else if (c === close) depth--;
  }
  return depth;
}
