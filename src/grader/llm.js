import Groq from "groq-sdk";
import { config } from "../config.js";
import * as settings from "../settings.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

let _client = null;
function client() {
  if (!_client) {
    _client = new Groq({ apiKey: config.groq.apiKey });
  }
  return _client;
}

export async function llmGrade({ task_type, requirements, submission, heuristics, unavailableKind }) {
  if (!config.groq.enabled) {
    throw new Error("Groq disabled (no GROQ_API_KEY)");
  }
  const completion = await client().chat.completions.create(
    {
      model: settings.get("groq_model", config.groq.model),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage({ task_type, requirements, submission, heuristics, unavailableKind }) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 600,
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  return {
    verdict: parsed.verdict ?? "review",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    reasoning: parsed.reasoning ?? "",
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
    model: settings.get("groq_model", config.groq.model),
  };
}
