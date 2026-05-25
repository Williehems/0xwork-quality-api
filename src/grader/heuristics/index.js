import { writingHeuristics } from "./writing.js";
import { codeHeuristics } from "./code.js";
import { researchHeuristics } from "./research.js";
import { socialHeuristics } from "./social.js";
import { dataHeuristics } from "./data.js";

export const SUPPORTED_TASK_TYPES = ["writing", "code", "research", "data", "social"];

export function normalizeTaskType(value) {
  const v = String(value ?? "").toLowerCase().trim();
  if (SUPPORTED_TASK_TYPES.includes(v)) return v;
  // Map common 0xwork category synonyms.
  if (["development", "dev"].includes(v)) return "code";
  if (["marketing", "content"].includes(v)) return "writing";
  if (["analytics"].includes(v)) return "data";
  if (["twitter", "x post", "x_post", "tweet"].includes(v)) return "social";
  return "writing";
}

/**
 * Dispatch heuristics by task category. Always returns an object with a
 * `category` field for the LLM grader and downstream renderers.
 */
export function runHeuristics({ task_type, submission, requirements }) {
  const category = normalizeTaskType(task_type);
  let result;
  switch (category) {
    case "code":     result = codeHeuristics({ submission, requirements }); break;
    case "research": result = researchHeuristics({ submission, requirements }); break;
    case "social":   result = socialHeuristics({ submission, requirements }); break;
    case "data":     result = dataHeuristics({ submission, requirements }); break;
    case "writing":
    default:         result = writingHeuristics({ submission, requirements });
  }
  return { category, ...result };
}
