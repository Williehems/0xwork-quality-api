// Auto-draft a poster→worker comment from a Gavel verdict.
//
// The poster opens "✨ Auto-comment" on the verdict card; the Mini App fetches
// the draft from the bot and pre-fills the textarea. Poster reviews / edits,
// then signs and sends. The model is asked to speak as the poster, not as
// Gavel — Gavel is the invisible drafting assistant here.

import Groq from "groq-sdk";
import { config } from "../config.js";
import * as settings from "../settings.js";
import { unavailableKindLabel } from "./prompt.js";

const SYSTEM_PROMPT = `You are the poster of a 0xWork task. Gavel (an AI grader) just returned a verdict on a worker's submission. Write a brief, friendly comment (1–3 sentences, under 280 chars) addressed to the worker, matching the verdict tone:

- approve → thank them, call out one strength, no asks.
- review → acknowledge what's good, name the specific concern that needs fixing, ask for a revision.
- reject → kind but direct, name the core gap, suggest what would make it acceptable next time.

Rules:
- Don't restate the rubric verbatim.
- Don't mention Gavel, AI, or grading by name (you're posing as the poster).
- Plain text. No markdown, no signature, no emojis.
- If RECENT THREAD is provided and contains messages labeled (worker), acknowledge the worker's most recent (worker)-labeled message directly. Never restart the conversation as if prior messages don't exist.
- For review/reject only: name exactly ONE specific action the worker must take. If the worker already promised that action in the thread, skip asking and instead confirm you're watching for it.
- If acknowledging the thread and naming an action conflict with the 280-char limit, drop the acknowledgment — the action comes first.
- If PROOF UNAVAILABILITY is provided, this takes priority over all other rules. Name the specific failure in plain language (e.g. "the linked post has been deleted", "the page is private") and tell the worker exactly what to do next (resubmit with a public link, make the account public, etc.).

Return a single JSON object: { "comment": "..." }`;

let _client = null;
function client() {
  if (!_client) _client = new Groq({ apiKey: config.groq.apiKey });
  return _client;
}

const UNAVAILABILITY_ACTION = {
  deleted:       "The linked content has been deleted. Please resubmit with a public URL or screenshot of the work.",
  restricted:    "The linked content is private or requires login. Please make it publicly accessible and share the link.",
  rate_limited:  "We couldn't access the submission right now (platform rate limit). Please try resubmitting shortly.",
  server_error:  "The submission URL returned a server error. Please check the link and resubmit.",
  unreachable:   "The submission URL is unreachable. Please check the link and resubmit with a working URL.",
  hash_only:     "The submission was received as a hash with no public URL. Please provide a publicly accessible link.",
  empty_content: "The submission URL returned empty or unrelated content. Please resubmit with the correct link.",
};

function fallbackDraft({ verdict, reasoning, concerns, strengths, title, unavailableKind }) {
  if (unavailableKind && UNAVAILABILITY_ACTION[unavailableKind]) {
    return UNAVAILABILITY_ACTION[unavailableKind];
  }
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

export async function draftComment({ verdict, reasoning, concerns, strengths, requirements, recentComments, workerAddress, unavailableKind }) {
  const title = requirements?.title;
  const fallback = fallbackDraft({
    verdict,
    reasoning,
    concerns,
    strengths,
    title,
    unavailableKind,
  });

  if (!config.groq.enabled) return fallback;

  const workerAddr = (workerAddress ?? "").toLowerCase();
  const recent = [...(recentComments ?? [])]
    .sort((a, b) => {
      const ta = String(a.created_at ?? "");
      const tb = String(b.created_at ?? "");
      if (ta !== tb) return ta < tb ? -1 : 1;
      return Number(a.id ?? 0) - Number(b.id ?? 0);
    })
    .slice(-3)
    .map((c) => {
      const isWorker = workerAddr && String(c.author_address ?? "").toLowerCase() === workerAddr;
      const role = isWorker ? "(worker)" : "(poster)";
      const who = c.author_username ?? c.author ?? "someone";
      return `- ${who} ${role}: ${c.content ?? c.body ?? ""}`;
    })
    .filter((s) => s.length > 5)
    .join("\n");

  const userMessage = [
    `VERDICT: ${verdict ?? "review"}`,
    title ? `TASK TITLE: ${title}` : "",
    reasoning ? `GAVEL REASONING:\n${reasoning}` : "",
    Array.isArray(strengths) && strengths.length ? `STRENGTHS:\n- ${strengths.slice(0, 2).join("\n- ")}` : "",
    Array.isArray(concerns) && concerns.length ? `CONCERNS:\n- ${concerns.slice(0, 2).join("\n- ")}` : "",
    recent ? `RECENT THREAD:\n${recent}` : "",
    unavailableKind ? `PROOF UNAVAILABILITY: ${unavailableKind}\n${unavailableKindLabel(unavailableKind)}` : "",
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
