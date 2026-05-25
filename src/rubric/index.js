// Rubric inference: given a task description (and optional explicit requirements
// text), extract a structured rubric the grader can use.
//
// Output schema:
//   {
//     title: string,
//     word_count?: number,        // inferred lower bound, omitted if no signal
//     topic_keywords: string[],   // 3-8 short keywords from the description
//     notes: string,              // 1-2 sentence summary of any extra criteria
//     confidence: number          // 0..1 — low when the description is vague
//   }

import Groq from "groq-sdk";

const RUBRIC_SYSTEM = `You extract a structured grading rubric from a 0xWork task description.

Return a single JSON object with this exact shape:
{
  "title": "short task title (use the description's first sentence if no explicit title)",
  "word_count": <integer or null — only set if the description specifies, hints at, or strongly implies a length (e.g. "500-word post", "short tweet", "in-depth essay"). null otherwise.>,
  "char_limit": <integer or null — only for social/tweet tasks; default 280 if the platform is Twitter/X and no explicit limit is given>,
  "topic_keywords": ["3-8 short keywords or phrases the submission MUST cover, drawn from the description"],
  "notes": "1-2 sentence summary of any other specific criteria (tone, format, source citations, code language, etc.)",
  "confidence": <number 0..1: 1 = description is detailed and explicit, 0.3 = vague / underspecified>
}

Guidelines:
- Do not invent requirements the description doesn't imply.
- If the description is very vague ("write a blog post"), set confidence low (0.3-0.5) and pick broad keywords from any topic hints.
- For "tweet" / "X post" / social tasks, set char_limit to 280 unless the task says otherwise. word_count can be null.
- For code tasks, keywords should describe functionality, language, or features required ("authentication", "REST API", "typescript", "tests"). word_count is rarely relevant for code; leave null unless explicit.
- For research tasks, keywords should cover topic areas AND look for citation/source requirements in notes.
- For data tasks, note expected format (csv/json) and shape (columns, row counts) in notes.
- Keywords should be lowercase, 1-3 words each, no duplicates.
- Output JSON only. No preamble.`;

let _client = null;
function client() {
  if (!_client) _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _client;
}

export async function inferRubric({ description, requirements, title, category }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set — cannot infer rubric");
  }
  const userMessage = [
    `Task category: ${category ?? "unknown"}`,
    title ? `Task title: ${title}` : "",
    requirements ? `Explicit requirements field:\n${requirements}` : "",
    `Description:\n${description ?? "(empty)"}`,
    "",
    "Extract the rubric as JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = await client().chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: RUBRIC_SYSTEM },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 400,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);

  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : (title ?? "Untitled task"),
    word_count:
      Number.isFinite(parsed.word_count) && parsed.word_count > 0
        ? Math.round(parsed.word_count)
        : null,
    char_limit:
      Number.isFinite(parsed.char_limit) && parsed.char_limit > 0
        ? Math.round(parsed.char_limit)
        : null,
    topic_keywords: Array.isArray(parsed.topic_keywords)
      ? parsed.topic_keywords.map((s) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 8)
      : [],
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
    confidence:
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
  };
}
