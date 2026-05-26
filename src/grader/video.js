// Video submission handling: Twitter/X oEmbed extraction + Groq vision grading.
//
// fetchVideoContent: resolves a submission URL to { tweetText, thumbnailUrls, platform }.
// llmGradeVideo: Groq call using Llama 4 Scout (vision-capable) when thumbnails are
//   available; falls back to the standard text model when they're not.
//
// No download, no ffmpeg — stays within Render free tier constraints.

import { fetchProofContent } from "../zerox/client.js";
import Groq from "groq-sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const OEMBED_ENDPOINT = "https://publish.twitter.com/oembed";
const VISION_MODEL    = "meta-llama/llama-4-scout-17b-16e-instruct";

function isTwitterUrl(raw) {
  try {
    const { hostname } = new URL(raw);
    return ["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(hostname);
  } catch { return false; }
}

// Extract the tweet body text from the <p> inside an oEmbed blockquote.
// Input: the raw HTML string from oembed.html
function extractTweetText(html) {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  if (!match) return "";
  return match[1]
    .replace(/<[^>]+>/g, " ")   // strip tags (links, mentions, etc.)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Best-effort thumbnail extraction via og:image meta tag.
// Twitterbot UA bypasses the login redirect that normal crawlers get.
async function tryGetThumbnail(tweetUrl) {
  try {
    const res = await fetch(tweetUrl, {
      headers: { "User-Agent": "Twitterbot/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    const url = m?.[1];
    return url && !url.includes("abs.twimg.com/sticky") ? url : null;
  } catch {
    return null;
  }
}

export async function fetchVideoContent(submissionUrl) {
  const url = (submissionUrl ?? "").trim();
  if (!url) {
    return { platform: "unknown", tweetText: "", thumbnailUrls: [], fallbackText: "" };
  }

  if (isTwitterUrl(url)) {
    try {
      const res = await fetch(
        `${OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}&omit_script=true`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
      const data = await res.json();
      const tweetText = extractTweetText(data.html ?? "");
      const thumbnail = await tryGetThumbnail(url);
      return {
        platform: "twitter",
        tweetText,
        thumbnailUrls: thumbnail ? [thumbnail] : [],
        fallbackText: "",
      };
    } catch (err) {
      console.warn("[grader/video] oEmbed failed for", url, "—", err.message);
      return { platform: "twitter", tweetText: "", thumbnailUrls: [], fallbackText: "" };
    }
  }

  // Non-Twitter fallback: extract page text via the existing HTML/PDF pipeline.
  try {
    const result = await fetchProofContent(url);
    return {
      platform: "unknown",
      tweetText: "",
      thumbnailUrls: [],
      fallbackText: result.text ?? "",
    };
  } catch {
    return { platform: "unknown", tweetText: "", thumbnailUrls: [], fallbackText: "" };
  }
}

let _client = null;
function groqClient() {
  if (!_client) _client = new Groq({ apiKey: config.groq.apiKey });
  return _client;
}

export async function llmGradeVideo({ task_type, requirements, videoData, heuristics }) {
  if (!config.groq.enabled) throw new Error("Groq disabled (no GROQ_API_KEY)");

  const submissionText =
    videoData.tweetText || videoData.fallbackText || "(no submission text available)";

  const textPart = [
    `TASK CATEGORY: ${task_type ?? "video"}`,
    "",
    "TASK REQUIREMENTS:",
    JSON.stringify(requirements, null, 2),
    "",
    "HEURISTIC RESULTS:",
    JSON.stringify(heuristics, null, 2),
    "",
    `PLATFORM: ${videoData.platform}`,
    "SUBMISSION (tweet / page text):",
    "<<<",
    submissionText,
    ">>>",
    "",
    videoData.thumbnailUrls.length > 0
      ? "Video thumbnail(s) are attached as image(s). Assess visual quality and production value alongside the tweet text."
      : "No video thumbnail is available — grade based on the tweet text and heuristics only.",
    "",
    "Return your verdict as a single JSON object.",
  ].join("\n");

  // Build multimodal user content: text first, then up to 5 image_url parts.
  const userContent = [{ type: "text", text: textPart }];
  for (const imgUrl of videoData.thumbnailUrls.slice(0, 5)) {
    userContent.push({ type: "image_url", image_url: { url: imgUrl } });
  }

  // Use vision model only when we actually have images — otherwise save cost/latency.
  const model = videoData.thumbnailUrls.length > 0 ? VISION_MODEL : config.groq.model;

  const completion = await groqClient().chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 600,
  });

  const raw = completion.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  return {
    verdict:    parsed.verdict    ?? "review",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    reasoning:  parsed.reasoning  ?? "",
    strengths:  Array.isArray(parsed.strengths) ? parsed.strengths : [],
    concerns:   Array.isArray(parsed.concerns)  ? parsed.concerns  : [],
    model,
  };
}
