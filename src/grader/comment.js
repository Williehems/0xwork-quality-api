// Auto-draft a poster→worker comment from a Gavel verdict.
//
// The poster opens "✨ Auto-comment" on the verdict card; the Mini App fetches
// the draft from the bot and pre-fills the textarea. Poster reviews / edits,
// then signs and sends. The model is asked to speak as the poster, not as
// Gavel — Gavel is the invisible drafting assistant here.

import Groq from "groq-sdk";
import { config } from "../config.js";
import * as settings from "../settings.js";

const SYSTEM_PROMPT = `You are the poster of a 0xWork task. Gavel (an AI grader) just returned a verdict on a worker's submission. Write a brief, friendly comment (1–3 sentences, under 280 chars) addressed to the worker, matching the verdict tone:

- approve → thank them, call out one strength, no asks.
- review → acknowledge what's good, name the specific concern that needs fixing, ask for a revision.
- reject → kind but direct, name the core gap, suggest what would make it acceptable next time.

Rules:
- Don't restate the rubric verbatim.
- Don't mention Gavel, AI, or grading by name (you're posing as the poster).
- Plain text. No markdown, no signature, no emojis.
- If recent comments are provided, don't repeat what was already said.

Return a single JSON object: { "comment": "..." }`;

let _client = null;
function client() {
  if (!_client) _client = new Groq({ apiKey: config.groq.apiKey });
  return _client;
}

function fallbackDraft({ verdict, reasoning, concerns, strengths, title }) {
  const concern = concerns?.[0];
  const strength = strengths?.[0];
  const taskRef = title ? ` on "${title}"` : "";
  if (verdict === "approve") {
    return `Thanks for the submission${taskRef}. ${strength ? `${strength}. ` : ""}Approving now.`;
  }
  if (verdict === "reject") {
    return `Thanks for the effort${taskRef}, but this one isn't ready. ${concern ?? reasoning ?? "It doesn't meet the requirements."} Happy to look at a fresh attempt.`;
  }
  // review (default)
  return `Thanks for the submission${taskRef}. ${concern ?? reasoning ?? "A few things need adjusting before I can approve."} Could you revise and resubmit?`;
}

export async function draftComment({ verdict, reasoning, concerns, strengths, requirements, recentComments }) {
  const title = requirements?.title;
  const fallback = fallbackDraft({
    verdict,
    reasoning,
    concerns,
    strengths,
    title,
  });

  if (!config.groq.enabled) return fallback;

  const recent = (recentComments ?? [])
    .slice(-3)
    .map((c) => `- ${c.author_username ?? c.author ?? "someone"}: ${c.content ?? c.body ?? ""}`)
    .filter((s) => s.length > 5)
    .join("\n");

  const userMessage = [
    `VERDICT: ${verdict ?? "review"}`,
    title ? `TASK TITLE: ${title}` : "",
    reasoning ? `GAVEL REASONING:\n${reasoning}` : "",
    Array.isArray(strengths) && strengths.length ? `STRENGTHS:\n- ${strengths.slice(0, 2).join("\n- ")}` : "",
    Array.isArray(concerns) && concerns.length ? `CONCERNS:\n- ${concerns.slice(0, 2).join("\n- ")}` : "",
    recent ? `RECENT THREAD:\n${recent}` : "",
    "",
    "Draft the comment now. Output JSON only.",
  ].filter(Boolean).join("\n\n");

  try {
    const completion = await client().chat.completions.create(
      {
        model: settings.get("groq_model", config.groq.model),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        temperature: 0.5,
        max_tokens: 200,
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    const raw = completion.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const draft = typeof parsed.comment === "string" ? parsed.comment.trim() : "";
    return draft || fallback;
  } catch (err) {
    console.warn("[comment] draft failed, using fallback:", err.message);
    return fallback;
  }
}
