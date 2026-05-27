import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Bot, InlineKeyboard } from "grammy";

import { setWallet, getWallet } from "../db/index.js";
import { listInReviewByPoster, getTaskById, getSubmission } from "../src/zerox/client.js";
import { inferRubric } from "../src/rubric/index.js";
import { createApiApp, logApiStartupNotes } from "../src/app.js";
import { isVideoPlatformUrl } from "../src/grader/video.js";
import { config } from "../src/config.js";
import * as settings from "../src/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINIAPP_URL = process.env.MINIAPP_URL ?? "";
const BOT_PORT = Number(process.env.BOT_PORT ?? process.env.PORT ?? 3001);
const API_BASE_URL = process.env.API_BASE_URL ?? `http://localhost:${BOT_PORT}`;
const BOT_PUBLIC_URL = process.env.BOT_PUBLIC_URL ?? `http://localhost:${BOT_PORT}`;
const REOWN_PROJECT_ID = process.env.REOWN_PROJECT_ID ?? "";
const SESSION_TTL_MS = 30 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
// Random per-process token appended to Mini App URLs as &_v= to defeat
// Telegram WebView's aggressive HTML caching across deploys.
const BUILD_TOKEN = Date.now().toString(36);

const MINIAPP_READY = Boolean(MINIAPP_URL) && !MINIAPP_URL.startsWith("https://your-");

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather.");
  process.exit(1);
}
if (!MINIAPP_READY) {
  console.warn(
    "[bot] MINIAPP_URL is not configured — Grade button will run heuristics+LLM directly (no payment).",
  );
}

const bot = new Bot(TOKEN);

// Captured from getMe() at startup so /session/:id can echo it back to the
// Mini App, which uses it to build a t.me/<bot> return link.
let botUsername = "";

// ── State ──────────────────────────────────────────────────────────────

/** sessions: id → { payload, expiresAt }  (payload = grading request) */
const sessions = new Map();
/** userState: tg_user_id → { kind, ...details, expiresAt } */
const userState = new Map();
/** userGradeTimes: tg_user_id → timestamps[] of recent grading sessions */
const userGradeTimes = new Map();

function canUserGrade(userId) {
  const windowMs = settings.getNum("rate_bot_window_ms", config.rateLimit.botWindowMs);
  const max      = settings.getNum("rate_bot_max", config.rateLimit.botMax);
  const cutoff   = Date.now() - windowMs;
  const times    = (userGradeTimes.get(userId) ?? []).filter(t => t > cutoff);
  userGradeTimes.set(userId, times);
  return times.length < max;
}
function recordGrade(userId) {
  const times = userGradeTimes.get(userId) ?? [];
  times.push(Date.now());
  userGradeTimes.set(userId, times);
}

function setSession(id, payload) {
  sessions.set(id, { payload, expiresAt: Date.now() + SESSION_TTL_MS });
}
function getSession(id) {
  const e = sessions.get(id);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { sessions.delete(id); return null; }
  return e.payload;
}
function updateSession(id, patch) {
  const e = sessions.get(id);
  if (!e) return null;
  e.payload = { ...e.payload, ...patch };
  e.expiresAt = Date.now() + SESSION_TTL_MS;
  return e.payload;
}

function setState(userId, state) {
  userState.set(userId, { ...state, expiresAt: Date.now() + STATE_TTL_MS });
}
function getState(userId) {
  const s = userState.get(userId);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { userState.delete(userId); return null; }
  return s;
}
function clearState(userId) { userState.delete(userId); }

setInterval(() => {
  const now = Date.now();
  for (const [id, e] of sessions) if (e.expiresAt < now) sessions.delete(id);
  for (const [id, s] of userState) if (s.expiresAt < now) userState.delete(id);
  const rateCutoff = now - config.rateLimit.botWindowMs;
  for (const [id, times] of userGradeTimes) {
    const pruned = times.filter(t => t > rateCutoff);
    if (pruned.length === 0) userGradeTimes.delete(id);
    else userGradeTimes.set(id, pruned);
  }
}, 5 * 60 * 1000).unref?.();

// ── Bot commands menu ───────────────────────────────────────────────────

async function registerCommands() {
  await bot.api.setMyCommands([
    { command: "inbox", description: "View submissions awaiting review" },
    { command: "wallet", description: "Bind or change your wallet" },
    { command: "manual", description: "Grade a pasted submission" },
    { command: "help", description: "How it works" },
    { command: "start", description: "Restart the bot" },
  ]);
}

// ── /start ──────────────────────────────────────────────────────────────

async function sendHome(ctx) {
  const w = await getWallet(ctx.from.id);
  const walletLine = w?.wallet
    ? `👛 Wallet: <code>${esc(short(w.wallet))}</code>`
    : `👛 Wallet: <i>not bound</i>`;

  const kb = new InlineKeyboard()
    .text("📥 Inbox", "go:inbox")
    .text(w?.wallet ? "👛 Change wallet" : "👛 Bind wallet", "go:wallet")
    .row()
    .text("❓ How it works", "go:help");

  await ctx.reply(
    `⚖️ <b>Gavel</b>\n<i>0xWork quality bot</i>\n\n` +
      `Grade submissions, then approve or dispute them — all in chat.\n\n` +
      walletLine,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

bot.command("start", async (ctx) => {
  clearState(ctx.from.id);
  await sendHome(ctx);
});

bot.callbackQuery("go:home", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHome(ctx);
});

bot.callbackQuery("go:inbox", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendInbox(ctx);
});

bot.callbackQuery("go:wallet", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendWalletPrompt(ctx);
});

bot.callbackQuery("go:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendHelp(ctx);
});

// ── /help ───────────────────────────────────────────────────────────────

async function sendHelp(ctx) {
  const kb = new InlineKeyboard().text("📥 Inbox", "go:inbox").text("🏠 Home", "go:home");
  await ctx.reply(
    `<b>❓ How it works</b>\n\n` +
      `You're a 0xWork poster. Workers submit work, you decide whether to approve or dispute. Gavel grades each submission so the call is fast and consistent, then helps you settle on-chain without leaving the chat.\n\n` +
      `<b>1.</b> Bind your wallet → /wallet\n` +
      `<b>2.</b> Open your inbox → /inbox\n` +
      `<b>3.</b> Tap a submission → Gavel fetches the work + infers a grading rubric\n` +
      `<b>4.</b> Tap <b>Grade</b> → verdict with evidence and reasoning\n` +
      `<b>5.</b> Tap <b>✅ Approve</b> or <b>⚠️ Dispute</b> → sign once on Base, settle on-chain\n\n` +
      `<b>Verdicts</b>\n` +
      `✅ <b>Approve</b> — meets requirements, no significant concerns\n` +
      `⚠️ <b>Review</b> — passes most signals but has a notable concern\n` +
      `❌ <b>Reject</b> — clearly fails a core requirement\n\n` +
      `<b>Fallback</b>\n` +
      `If a proof URL is offline, use /manual to paste the submission yourself.`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

bot.command("help", async (ctx) => {
  await sendHelp(ctx);
});

// ── /wallet ─────────────────────────────────────────────────────────────

async function sendWalletPrompt(ctx) {
  setState(ctx.from.id, { kind: "await_wallet" });
  await ctx.reply(
    `👛 Send me your <b>0xWork poster wallet address</b>.\n\n` +
      `It should look like:\n<code>0x1234567890abcdef1234567890abcdef12345678</code>\n\n` +
      `Or cancel with /start.`,
    { parse_mode: "HTML" },
  );
}

async function bindWallet(ctx, address) {
  await setWallet({ tgUserId: ctx.from.id, tgUsername: ctx.from.username, wallet: address });
  clearState(ctx.from.id);
  const kb = new InlineKeyboard().text("📥 Open Inbox", "go:inbox").text("🏠 Home", "go:home");
  await ctx.reply(
    `✅ Wallet bound: <code>${esc(address)}</code>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

bot.command("wallet", async (ctx) => {
  clearState(ctx.from.id);
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    const w = await getWallet(ctx.from.id);
    if (w?.wallet) {
      const kb = new InlineKeyboard()
        .text("✏️ Change wallet", "go:wallet")
        .text("📥 Inbox", "go:inbox");
      await ctx.reply(
        `👛 Currently bound: <code>${esc(w.wallet)}</code>`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    } else {
      await sendWalletPrompt(ctx);
    }
    return;
  }
  if (!isAddress(arg)) {
    await ctx.reply(`That doesn't look like a wallet address. It should start with <code>0x</code> followed by 40 hex characters.`, { parse_mode: "HTML" });
    return;
  }
  await bindWallet(ctx, arg);
});

// ── /inbox ──────────────────────────────────────────────────────────────

async function sendInbox(ctx) {
  const w = await getWallet(ctx.from.id);
  if (!w?.wallet) {
    const kb = new InlineKeyboard().text("👛 Bind wallet", "go:wallet");
    await ctx.reply(
      `Bind your wallet first to see your in-review submissions.`,
      { reply_markup: kb },
    );
    return;
  }
  const loading = await ctx.reply(`⏳ Fetching your in-review submissions…`);
  let tasks;
  try {
    tasks = await listInReviewByPoster(w.wallet, { limit: 10 });
  } catch (err) {
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `Couldn't reach 0xWork — try again in a moment.`,
    );
    console.error("[bot] inbox fetch failed:", err);
    return;
  }
  if (!tasks.length) {
    const kb = new InlineKeyboard().text("✏️ Change wallet", "go:wallet").text("🏠 Home", "go:home");
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `📭 No submissions awaiting your review.\n\nWhen workers submit to your tasks, they'll show up here.`,
      { reply_markup: kb },
    );
    return;
  }
  const lines = tasks.map((t) =>
    `${categoryIcon(t.category)} <b>#${t.id}</b> · ${esc(truncate(t.title || stripDesc(t.description), 50))} · <b>${formatBounty(t.bounty)}</b> · <i>${timeAgo(t.submittedAt)}</i>`,
  );
  const kb = new InlineKeyboard();
  for (const t of tasks) {
    kb.text(`#${t.id} — ${truncate(t.title || stripDesc(t.description), 32)}`, `pick:${t.id}`).row();
  }
  kb.text("🏠 Home", "go:home");
  await bot.api.editMessageText(
    ctx.chat.id, loading.message_id,
    `<b>📥 ${tasks.length} submission${tasks.length === 1 ? "" : "s"} awaiting your review</b>\n\n` +
      lines.join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

bot.command("inbox", async (ctx) => {
  clearState(ctx.from.id);
  await sendInbox(ctx);
});

// ── Task pick → fetch + rubric ──────────────────────────────────────────

bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  const taskId = ctx.match[1];
  await ctx.answerCallbackQuery();
  const loading = await ctx.reply(`⏳ Loading task #${taskId}…`);

  let task;
  try {
    task = await getTaskById(taskId);
  } catch (err) {
    await bot.api.editMessageText(ctx.chat.id, loading.message_id, `Couldn't fetch task #${taskId} — try /inbox again.`);
    console.error("[bot] getTaskById failed:", err);
    return;
  }
  if (!task) {
    await bot.api.editMessageText(ctx.chat.id, loading.message_id, `Task #${taskId} not found.`);
    return;
  }
  if (task.state !== "Submitted") {
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `Task #${taskId} is no longer in <i>Submitted</i> state (now: ${esc(task.state)}). Refresh with /inbox.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const taskType = normalizeCategory(task.category);

  // Video platform URLs (Twitter, YouTube, TikTok, Vimeo, Loom) are handled
  // directly by the grader's content detector — skip fetchProofContent entirely.
  // This applies regardless of the 0xwork category label: a task labelled
  // "writing" or "social" whose proof URL is a tweet/video link should NOT have
  // HTML text pre-extracted (Twitter is JS-rendered; text would be junk).
  if (taskType === "video" || isVideoPlatformUrl(task.proofUrl)) {
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `📥 Loaded task #${taskId}\n🧠 Inferring rubric…`,
    );
    let rubric;
    try {
      rubric = await inferRubric(task);
    } catch (err) {
      await bot.api.editMessageText(
        ctx.chat.id, loading.message_id,
        `Couldn't infer the rubric — ${esc(err.message)}.\nTry again or use /manual.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const sessionId = `${ctx.from.id}:${Date.now()}`;
    if (!canUserGrade(ctx.from.id)) {
      await bot.api.editMessageText(
        ctx.chat.id, loading.message_id,
        "⏳ You've submitted too many grading requests this hour. Wait a bit before trying again.",
      );
      return;
    }
    setSession(sessionId, {
      task_type: taskType,
      tier: "full",
      requirements: {
        title: rubric.title,
        topic_keywords: rubric.topic_keywords,
        notes: rubric.notes,
      },
      submission: task.proofUrl ?? "",
      meta: {
        task_id: task.id,
        bounty: task.bounty,
        worker_address: task.workerAddress,
        proof_url: task.proofUrl,
        delivery_description: task.deliveryDescription,
        category: task.category,
        submitted_at: task.submittedAt,
        submission_source: "video_url",
      },
      userId: ctx.from.id,
      messageId: loading.message_id,
    });
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      renderRubricConfirm(task, rubric, null, "video", null),
      { parse_mode: "HTML", reply_markup: rubricKeyboard(sessionId) },
    );
    recordGrade(ctx.from.id);
    return;
  }

  await bot.api.editMessageText(
    ctx.chat.id, loading.message_id,
    `📥 Loaded task #${taskId}\n⏳ Fetching submission…`,
  );

  const fetchResult = await getSubmission(task.id, task.proofUrl);

  // Always infer the rubric now — we'll need it regardless of which path we take.
  await bot.api.editMessageText(
    ctx.chat.id, loading.message_id,
    `📥 Loaded task #${taskId}\n🧠 Inferring rubric…`,
  );

  let rubric;
  try {
    rubric = await inferRubric(task);
  } catch (err) {
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `Couldn't infer the rubric — ${esc(err.message)}.\nTry again or use /manual.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const sessionId = `${ctx.from.id}:${Date.now()}`;
  if (!canUserGrade(ctx.from.id)) {
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      "⏳ You've submitted too many grading requests this hour. Wait a bit before trying again.",
    );
    return;
  }
  const baseSession = {
    task_type: taskType,
    tier: "full",
    requirements: {
      title: rubric.title,
      word_count: rubric.word_count ?? undefined,
      char_limit: rubric.char_limit ?? undefined,
      topic_keywords: rubric.topic_keywords,
      notes: rubric.notes,
    },
    submission: fetchResult.kind === "content" ? fetchResult.text : "",
    meta: {
      task_id: task.id,
      bounty: task.bounty,
      worker_address: task.workerAddress,
      proof_url:
        fetchResult.kind === "needs_manual" ? fetchResult.proofUrl : task.proofUrl,
      delivery_description: task.deliveryDescription,
      category: task.category,
      submitted_at: task.submittedAt,
      proof_type: fetchResult.kind === "needs_manual" ? fetchResult.proofType : null,
      worker_summary: fetchResult.kind === "needs_manual" ? fetchResult.summary : null,
      content_hash: fetchResult.kind === "needs_manual" ? fetchResult.contentHash : null,
      artifact_refs:
        fetchResult.kind === "needs_manual" ? fetchResult.artifactRefs ?? [] : [],
      evidence: fetchResult.kind === "needs_manual" ? fetchResult.evidence ?? [] : [],
      submission_format: fetchResult.kind === "content" ? fetchResult.format : null,
      submission_pages: fetchResult.kind === "content" ? fetchResult.pages ?? null : null,
      submission_source: fetchResult.kind === "content" ? "url" : "pending",
    },
    userId: ctx.from.id,
    messageId: loading.message_id,
  };
  setSession(sessionId, baseSession);
  recordGrade(ctx.from.id);

  if (fetchResult.kind === "content") {
    const wordCount = fetchResult.text.split(/\s+/).filter(Boolean).length;
    await bot.api.editMessageText(
      ctx.chat.id, loading.message_id,
      renderRubricConfirm(task, rubric, wordCount, fetchResult.format, fetchResult.pages),
      { parse_mode: "HTML", reply_markup: rubricKeyboard(sessionId) },
    );
    return;
  }

  // Couldn't auto-fetch — offer recovery options.
  await bot.api.editMessageText(
    ctx.chat.id, loading.message_id,
    renderRecoveryPrompt(task, rubric, fetchResult),
    { parse_mode: "HTML", reply_markup: recoveryKeyboard(sessionId, Boolean(fetchResult.summary), task.id) },
  );
});

bot.callbackQuery(/^paste:(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const payload = getSession(sessionId);
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "Session expired." });
    return;
  }
  if (payload.userId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Not your session." });
    return;
  }
  await ctx.answerCallbackQuery();
  setState(ctx.from.id, { kind: "await_submission_paste", sessionId });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    `✏️ <b>Send the submission as your next message.</b>\n\n` +
      `I'll grade it against the inferred rubric. Or /start to abort.`,
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^summary:(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const payload = getSession(sessionId);
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "Session expired." });
    return;
  }
  if (payload.userId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Not your session." });
    return;
  }
  if (!payload.meta?.worker_summary && !payload.meta?.proof_url && !payload.meta?.content_hash) {
    await ctx.answerCallbackQuery({ text: "Not enough metadata to grade." });
    return;
  }
  await ctx.answerCallbackQuery();
  const composed = composeSummaryGradeText(payload.meta);
  const noteAddon = "[Grading on submission metadata only — full content not available.]";
  const newReqs = {
    ...payload.requirements,
    notes: payload.requirements?.notes
      ? `${payload.requirements.notes} ${noteAddon}`
      : noteAddon,
  };
  updateSession(sessionId, {
    submission: composed,
    requirements: newReqs,
    meta: { ...payload.meta, submission_source: "summary" },
  });
  await ctx.editMessageText(
    `${renderRubricConfirmFromSession(getSession(sessionId))}\n\n` +
      `<i>⚠ Grading worker's summary + submission metadata only — verdict will hedge accordingly.</i>`,
    { parse_mode: "HTML", reply_markup: rubricKeyboard(sessionId) },
  ).catch(() => {});
});

// ── Confirm / Edit / Cancel callbacks ───────────────────────────────────

bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const payload = getSession(sessionId);
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "Session expired. Try /inbox again." });
    return;
  }
  if (payload.userId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Not your session." });
    return;
  }
  if (!payload.submission || payload.submission.trim().length < 10) {
    await ctx.answerCallbackQuery({ text: "Paste the submission first." });
    return;
  }
  await ctx.answerCallbackQuery();
  clearState(ctx.from.id);

  if (MINIAPP_READY) {
    // Mini App is same-origin with the bot/API combined server, so we don't
    // pass api/bot URLs as params — the app uses location.origin directly.
    // Append a per-process token so Telegram's WebView treats every link as
    // a fresh URL and won't serve cached HTML from an earlier deploy.
    const url =
      `${MINIAPP_URL}?session=${encodeURIComponent(sessionId)}` +
      (REOWN_PROJECT_ID ? `&wcProjectId=${encodeURIComponent(REOWN_PROJECT_ID)}` : "") +
      `&_v=${encodeURIComponent(BUILD_TOKEN)}`;
    const kb = new InlineKeyboard().webApp("🎯 Pay & Grade", url);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    return;
  }

  // Direct grading path (no Mini App configured)
  await ctx.editMessageText(
    `⏳ Grading task #${payload.meta?.task_id ?? "?"}…`,
    { parse_mode: "HTML" },
  ).catch(() => {});

  try {
    const res = await fetch(`${API_BASE_URL}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_type: payload.task_type,
        tier: payload.tier,
        requirements: payload.requirements,
        submission: payload.submission,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
    }
    const verdict = await res.json();
    sessions.delete(sessionId);

    await ctx.editMessageText(
      renderVerdict(verdict, payload.meta),
      { parse_mode: "HTML", reply_markup: postVerdictKeyboard() },
    ).catch(async () => {
      // fall back to a new message if edit failed
      await ctx.reply(renderVerdict(verdict, payload.meta), {
        parse_mode: "HTML",
        reply_markup: postVerdictKeyboard(),
      });
    });
  } catch (err) {
    await ctx.reply(`Grading failed — ${esc(err.message)}.`, { parse_mode: "HTML" });
    console.error("[bot] grade failed:", err);
  }
});

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  const payload = getSession(sessionId);
  if (!payload) {
    await ctx.answerCallbackQuery({ text: "Session expired." });
    return;
  }
  if (payload.userId !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: "Not your session." });
    return;
  }
  await ctx.answerCallbackQuery();
  setState(ctx.from.id, { kind: "edit_rubric", sessionId });

  await ctx.reply(
    `✏️ <b>Send the corrected rubric</b>\n\nFormat (skip any field to keep the current value):\n\n` +
      `<pre>WORD_COUNT: 500\nKEYWORDS: a, b, c\nNOTES: must cite sources</pre>`,
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
  const sessionId = ctx.match[1];
  sessions.delete(sessionId);
  clearState(ctx.from.id);
  await ctx.answerCallbackQuery({ text: "Cancelled." });
  await ctx.editMessageText("✕ <i>Cancelled.</i>", { parse_mode: "HTML" }).catch(() => {});
});

// ── /manual ─────────────────────────────────────────────────────────────

bot.callbackQuery("go:manual", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendManualPrompt(ctx);
});

// ── Admin panel ─────────────────────────────────────────────────────────────

function isAdmin(ctx) {
  const adminId = config.admin.telegramId;
  return adminId && String(ctx.from?.id) === String(adminId);
}

function renderAdminPanel() {
  const bypass      = settings.getBool("bypass", config.x402.bypass);
  const price       = settings.get("price", config.pricing.full);
  const rateApiMax  = settings.getNum("rate_api_max", config.rateLimit.checkMax);
  const rateApiWin  = Math.round(
    settings.getNum("rate_api_window_min", config.rateLimit.checkWindowMs / 60000)
  );
  const rateBotMax  = settings.getNum("rate_bot_max", config.rateLimit.botMax);
  const model       = settings.get("groq_model", config.groq.model);
  const maintenance = settings.getBool("maintenance", false);
  const dbOk        = settings.isDbAvailable();

  const text =
    `⚙️ <b>Gavel Admin Panel</b>${dbOk ? "" : " ⚠️ <i>(DB unavailable — changes won't persist)</i>"}\n\n` +
    `💰 <b>Payments</b>\n` +
    `  Price: <code>${price} USDC</code>\n` +
    `  Bypass: <b>${bypass ? "ON ✅" : "OFF"}</b>\n\n` +
    `⚡ <b>Rate Limits</b>\n` +
    `  API: <code>${rateApiMax}</code> per <code>${rateApiWin}</code> min\n` +
    `  Bot: <code>${rateBotMax}</code> per hour\n\n` +
    `🤖 <b>Grading</b>\n` +
    `  Model: <code>${model}</code>\n\n` +
    `${maintenance ? "🔴" : "🟢"} Maintenance: <b>${maintenance ? "ON" : "OFF"}</b>`;

  const kb = new InlineKeyboard()
    .text("💰 Set price",     "admin:edit:price")
    .text(bypass ? "🔄 Bypass ON→OFF" : "🔄 Bypass OFF→ON", "admin:toggle:bypass")
    .row()
    .text("⚡ API limit",     "admin:edit:rate_api_max")
    .text("⚡ Bot limit",     "admin:edit:rate_bot_max")
    .row()
    .text("🤖 Change model",  "admin:edit:groq_model")
    .text(maintenance ? "🟢 Maint. ON→OFF" : "🔴 Maint. OFF→ON", "admin:toggle:maintenance")
    .row()
    .text("↩ Close",          "admin:close");

  return { text, kb };
}

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { text, kb } = renderAdminPanel();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
});

// Toggle callbacks (bypass, maintenance)
bot.callbackQuery(/^admin:toggle:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const key = ctx.match[1];
  const current = settings.getBool(key, key === "bypass" ? config.x402.bypass : false);
  try {
    await settings.set(key, String(!current));
    await ctx.answerCallbackQuery(`${key} → ${!current ? "ON" : "OFF"}`);
  } catch {
    await ctx.answerCallbackQuery("DB error — change applied in-memory only");
    // In-memory already updated by settings.set even if DB write failed
  }
  const { text, kb } = renderAdminPanel();
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// Edit callbacks — prompt for a new value
const ADMIN_EDIT_LABELS = {
  price:        "Grade price in USDC (e.g. 0.10)",
  rate_api_max: "API rate limit — max requests per window (integer)",
  rate_bot_max: "Bot rate limit — max grades per hour per user (integer)",
  groq_model:   "Groq model name (e.g. llama-3.3-70b-versatile)",
};
bot.callbackQuery(/^admin:edit:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const field = ctx.match[1];
  const label = ADMIN_EDIT_LABELS[field] ?? field;
  setState(ctx.from.id, {
    kind: "admin_edit",
    field,
    chatId: ctx.chat.id,
    messageId: ctx.msg?.message_id,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `✏️ <b>Edit: ${label}</b>\n\nSend the new value (or /cancel to abort):`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✖ Cancel", "admin:cancel_edit") },
  );
});

bot.callbackQuery("admin:cancel_edit", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  clearState(ctx.from.id);
  await ctx.answerCallbackQuery("Cancelled");
  const { text, kb } = renderAdminPanel();
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

bot.callbackQuery("admin:close", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

bot.command("manual", async (ctx) => {
  await sendManualPrompt(ctx);
});

async function sendManualPrompt(ctx) {
  await ctx.reply(
    `✏️ <b>Manual mode</b>\n\nPaste a submission in this format:\n\n` +
      `<pre>TITLE: ...\nWORD_COUNT: 500\nKEYWORDS: a, b, c\n---\n&lt;submission text&gt;</pre>`,
    { parse_mode: "HTML" },
  );
}

// ── Text handler: routes by current user state ──────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const state = getState(ctx.from.id);

  if (state?.kind === "await_wallet") {
    const addr = text.trim();
    if (!isAddress(addr)) {
      await ctx.reply(`That doesn't look like a wallet address. It should start with <code>0x</code> followed by 40 hex characters.`, { parse_mode: "HTML" });
      return;
    }
    await bindWallet(ctx, addr);
    return;
  }

  if (state?.kind === "await_submission_paste") {
    const payload = getSession(state.sessionId);
    if (!payload) {
      clearState(ctx.from.id);
      await ctx.reply("Session expired. Try /inbox again.");
      return;
    }
    if (text.trim().length < 20) {
      await ctx.reply("That looks too short to be a submission. Paste the full text, or /start to abort.");
      return;
    }
    updateSession(state.sessionId, {
      submission: text,
      meta: { ...payload.meta, submission_source: "pasted" },
    });
    clearState(ctx.from.id);
    const session = getSession(state.sessionId);
    await ctx.reply(
      `${renderRubricConfirmFromSession(session)}`,
      { parse_mode: "HTML", reply_markup: rubricKeyboard(state.sessionId) },
    );
    return;
  }

  if (state?.kind === "edit_rubric") {
    const payload = getSession(state.sessionId);
    if (!payload) {
      clearState(ctx.from.id);
      await ctx.reply("Session expired. Try /inbox again.");
      return;
    }
    const edits = parseRubricEdit(text);
    if (!edits || Object.keys(edits).length === 0) {
      await ctx.reply("Couldn't parse any fields. Use the format shown when you tapped Edit.");
      return;
    }
    const newReqs = { ...payload.requirements };
    if (edits.word_count !== undefined) newReqs.word_count = edits.word_count;
    if (edits.topic_keywords !== undefined) newReqs.topic_keywords = edits.topic_keywords;
    if (edits.notes !== undefined) newReqs.notes = edits.notes;
    if (edits.title !== undefined) newReqs.title = edits.title;
    updateSession(state.sessionId, { requirements: newReqs });
    clearState(ctx.from.id);
    await ctx.reply(
      `✏️ <b>Rubric updated</b>\n\n${renderRubricSummary(newReqs)}`,
      { parse_mode: "HTML", reply_markup: rubricKeyboard(state.sessionId) },
    );
    return;
  }

  // Admin field edit
  if (state?.kind === "admin_edit" && isAdmin(ctx)) {
    const { field, chatId, messageId } = state;
    clearState(ctx.from.id);
    const label = field.replace(/_/g, " ");

    // Validate by type
    let value = text.trim();
    if (field === "price") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        await ctx.reply("Invalid price — enter a positive number like 0.10.", { parse_mode: "HTML" });
        return;
      }
      value = n.toFixed(4).replace(/\.?0+$/, "");
    } else if (field === "rate_api_max" || field === "rate_bot_max") {
      const n = parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        await ctx.reply("Invalid — enter a positive integer.", { parse_mode: "HTML" });
        return;
      }
      value = String(n);
    }

    try {
      await settings.set(field, value);
    } catch {
      await ctx.reply("⚠️ DB error — change applied in-memory only (won't survive restart).");
    }

    // Restore the panel in the original message
    const { text: panelText, kb } = renderAdminPanel();
    if (chatId && messageId) {
      await bot.api.editMessageText(chatId, messageId, panelText, {
        parse_mode: "HTML", reply_markup: kb,
      }).catch(() => {});
    }
    await ctx.reply(`✅ <b>${label}</b> set to <code>${esc(value)}</code>`, { parse_mode: "HTML" });
    return;
  }

  // Manual paste fallback
  const parsed = parseManualSubmission(text);
  if (!parsed) {
    const kb = new InlineKeyboard().text("📥 Inbox", "go:inbox").text("✏️ Manual", "go:manual");
    await ctx.reply(`I didn't understand that. Pick an action:`, { reply_markup: kb });
    return;
  }
  const sessionId = `${ctx.from.id}:${Date.now()}`;
  if (!canUserGrade(ctx.from.id)) {
    await ctx.reply("⏳ Too many grading requests this hour. Try again in a bit.");
    return;
  }
  setSession(sessionId, { ...parsed, userId: ctx.from.id, meta: { source: "manual" } });
  recordGrade(ctx.from.id);
  await ctx.reply(
    `📝 <b>${esc(parsed.requirements.title)}</b>\nWord count: ${parsed.requirements.word_count ?? "any"}`,
    { parse_mode: "HTML", reply_markup: rubricKeyboard(sessionId) },
  );
});

// ── Mini App data ───────────────────────────────────────────────────────

bot.on("message", async (ctx) => {
  if (ctx.message.web_app_data) {
    try {
      const verdict = JSON.parse(ctx.message.web_app_data.data);
      await ctx.reply(renderVerdict(verdict, {}), {
        parse_mode: "HTML",
        reply_markup: postVerdictKeyboard(),
      });
    } catch {
      await ctx.reply("Couldn't render the verdict — Mini App returned malformed data.");
    }
  }
});

bot.catch((err) => console.error("[bot] error:", err));

// ── HTTP server (Mini App session lookup + Render healthcheck) ──────────

const http = express();
http.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
http.get("/", (_req, res) => res.json({ ok: true, service: "bot+api" }));

// Serve the Telegram Mini App at /app (e.g. /app/index.html, /app/app.js).
// Telegram's WebView caches HTML aggressively, so disable caching on all
// mini app assets — the bundle is tiny enough that re-fetching is fine.
http.use("/app", express.static(path.join(__dirname, "../miniapp"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

http.get("/session/:id", (req, res) => {
  const payload = getSession(req.params.id);
  if (!payload) return res.status(404).json({ error: "session_not_found" });
  res.json({
    task_type: payload.task_type,
    tier: payload.tier,
    requirements: payload.requirements,
    submission: payload.submission,
    meta: payload.meta ?? null,
    task: payload.task ?? null,
    price: settings.get("price", config.pricing.full),
    bot_username: botUsername || null,
  });
});

// Mini App opened via inline keyboard can't use tg.sendData() — it POSTs the
// verdict here instead, and we forward it to the user's chat as a message.
http.use(express.json({ limit: "32kb" }));
http.post("/verdict/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const payload = getSession(sessionId);
    if (!payload) return res.status(404).json({ error: "session_not_found" });
    const userId = payload.userId;
    if (!userId) return res.status(400).json({ error: "session_has_no_user" });
    const verdict = req.body;

    // Build the `task` object the action flow needs. We re-fetch the task
    // from 0xwork so discountedFee reflects current on-chain state, but
    // fall back to the meta we already have if the API hiccups — the Mini
    // App can still operate with bountyAmount + worker and just shows the
    // 5% fee assumption.
    let freshTask = null;
    if (payload.meta?.task_id != null) {
      freshTask = await getTaskById(payload.meta.task_id).catch((err) => {
        console.warn("[bot] /verdict: getTaskById failed, using session meta:", err.message);
        return null;
      });
    }
    const poster = await getWallet(userId).catch(() => null);
    const task = {
      id: payload.meta?.task_id,
      title: freshTask?.title ?? payload.requirements?.title ?? null,
      bountyAmount: freshTask?.bounty ?? payload.meta?.bounty ?? 0,
      worker: freshTask?.workerAddress ?? payload.meta?.worker_address ?? null,
      posterAddress: poster?.wallet ?? freshTask?.posterAddress ?? null,
      discountedFee: freshTask?.discountedFee ?? false,
    };
    updateSession(sessionId, { task });

    await bot.api.sendMessage(userId, renderVerdict(verdict, payload.meta), {
      parse_mode: "HTML",
      reply_markup: postVerdictKeyboard(sessionId),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[bot] /verdict send failed:", err);
    res.status(500).json({ error: "send_failed", message: err.message });
  }
});

// Mini App POSTs here after a confirmed approve/reject on-chain tx. We
// notify the user's chat with a BaseScan link and clear the session.
http.post("/action-result/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const payload = getSession(sessionId);
    if (!payload) return res.status(404).json({ error: "session_not_found" });
    const userId = payload.userId;
    if (!userId) return res.status(400).json({ error: "session_has_no_user" });

    const { action, taskId, txHash } = req.body ?? {};
    if (action !== "approve" && action !== "dispute") {
      return res.status(400).json({ error: "bad_action" });
    }
    if (!txHash || typeof txHash !== "string") {
      return res.status(400).json({ error: "missing_tx_hash" });
    }

    const message = renderActionResult({ action, taskId, txHash, payload });
    const kb = new InlineKeyboard()
      .url("🔍 View on BaseScan", `https://basescan.org/tx/${txHash}`)
      .row()
      .text("📥 Inbox", "go:inbox")
      .text("🏠 Home", "go:home");
    await bot.api.sendMessage(userId, message, {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
    // Action terminal — wipe the session so the same Approve button can't
    // be tapped twice. (User can /inbox again if they need to redo.)
    sessions.delete(sessionId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[bot] /action-result send failed:", err);
    res.status(500).json({ error: "send_failed", message: err.message });
  }
});

function renderActionResult({ action, taskId, txHash, payload }) {
  const id = taskId ?? payload?.meta?.task_id ?? "?";
  const shortHash = `${String(txHash).slice(0, 10)}…${String(txHash).slice(-6)}`;
  if (action === "approve") {
    return (
      `✅ <b>Approved task #${esc(String(id))}</b>\n\n` +
      `Bounty released to the worker on-chain.\n` +
      `Tx: <code>${esc(shortHash)}</code>`
    );
  }
  // dispute
  return (
    `⚠️ <b>Dispute opened on task #${esc(String(id))}</b>\n\n` +
    `48-hour dispute window started. If no resolution is reached, the worker ` +
    `is paid automatically. Escalate via <a href="https://0xwork.org/tasks/${esc(String(id))}">0xwork.org</a> ` +
    `before the window closes if you want to deny payment.\n\n` +
    `Tx: <code>${esc(shortHash)}</code>`
  );
}

// Mount the API (/healthz, /check) on the same server.
http.use(createApiApp());

// Load runtime settings from DB before the server handles any requests.
await settings.loadSettings();

http.listen(BOT_PORT, () => {
  console.log(`[server] listening on :${BOT_PORT} (bot + api)`);
  logApiStartupNotes();
});

await registerCommands().catch((e) => console.warn("[bot] setMyCommands failed:", e.message));

// Telegram only allows one getUpdates poller per bot at a time. On Render
// free-tier redeploys the old instance can still be polling for up to ~30s
// after the new one starts, which makes getUpdates return 409. Retry with
// backoff instead of crashing the process.
async function startWithRetry() {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: (me) => {
          botUsername = me.username;
          console.log(`[bot] started as @${me.username}`);
        },
      });
      return;
    } catch (err) {
      if (err?.error_code === 409 && attempt < 8) {
        const wait = Math.min(5000 * attempt, 30000);
        console.warn(`[bot] 409 conflict (old instance still polling); retry ${attempt}/8 in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

startWithRetry().catch((err) => {
  console.error("[bot] fatal start error:", err);
  process.exit(1);
});

// ── Renderers ───────────────────────────────────────────────────────────

function composeSummaryGradeText(meta) {
  const parts = [
    "[NOTE: The full submission content could not be retrieved. The text below contains the worker's summary plus every available submission reference — URL, content hash, artifact IDs, evidence notes. Grade with caution and lean toward 'review' unless the metadata alone gives clear approve/reject signal.]",
    "",
    "── WORKER'S SUMMARY ──",
    meta.worker_summary?.trim() || "(no summary provided)",
  ];

  const submitBits = [];
  if (meta.proof_type) submitBits.push(`Submission type: ${meta.proof_type}`);
  if (meta.proof_url) submitBits.push(`Submission URL: ${meta.proof_url}`);
  if (meta.content_hash) submitBits.push(`Content hash (SHA-256): ${meta.content_hash}`);
  if (meta.artifact_refs?.length) {
    submitBits.push(`Artifact refs: ${meta.artifact_refs.join(", ")}`);
  }
  if (meta.delivery_description) {
    submitBits.push(`Worker's delivery note: ${meta.delivery_description}`);
  }
  if (submitBits.length) {
    parts.push("", "── SUBMISSION REFERENCES ──", ...submitBits);
  }

  if (Array.isArray(meta.evidence) && meta.evidence.length) {
    parts.push("", "── EVIDENCE ──");
    for (const e of meta.evidence) {
      const bits = [];
      if (e.label) bits.push(e.label);
      if (e.kind) bits.push(`(${e.kind})`);
      if (e.url) bits.push(`URL: ${e.url}`);
      if (e.note) bits.push(`Note: ${e.note}`);
      if (bits.length) parts.push("• " + bits.join(" · "));
    }
  }

  return parts.join("\n");
}

function rubricKeyboard(sessionId) {
  const price = settings.get("price", config.pricing.full);
  const gradeLabel = MINIAPP_READY ? `🎯 Grade (${price} USDC)` : "🎯 Grade";
  return new InlineKeyboard()
    .text(gradeLabel, `confirm:${sessionId}`)
    .row()
    .text("✏️ Edit", `edit:${sessionId}`)
    .text("✕ Cancel", `cancel:${sessionId}`);
}

function recoveryKeyboard(sessionId, hasSummary, taskId) {
  const kb = new InlineKeyboard();
  kb.url("🔗 View on 0xwork.org", `https://0xwork.org/tasks/${taskId}`).row();
  kb.text("✏️ Paste submission", `paste:${sessionId}`).row();
  if (hasSummary) kb.text("🎯 Grade summary only", `summary:${sessionId}`).row();
  kb.text("📥 Inbox", "go:inbox").text("✕ Cancel", `cancel:${sessionId}`);
  return kb;
}

function postVerdictKeyboard(sessionId) {
  const kb = new InlineKeyboard();
  // Only attach approve/dispute when the Mini App is available; otherwise
  // the buttons would dead-end (no UI to sign the on-chain tx).
  if (MINIAPP_READY && sessionId) {
    const base = `${MINIAPP_URL}?session=${encodeURIComponent(sessionId)}&_v=${encodeURIComponent(BUILD_TOKEN)}`;
    kb.webApp("✅ Approve", `${base}&action=approve`)
      .webApp("⚠️ Dispute", `${base}&action=dispute`)
      .row();
  }
  kb.text("📥 Inbox", "go:inbox").text("🏠 Home", "go:home");
  return kb;
}

function renderRubricConfirm(task, rubric, wordCount, format, pages) {
  const fmt = format && format !== "text" ? ` · ${format}${pages ? ` (${pages}pp)` : ""}` : "";
  const lines = [
    `${categoryIcon(task.category)} <b>Task #${task.id}</b> · ${esc(task.title || "Untitled")}`,
    `${formatBounty(task.bounty)} · submitted ${timeAgo(task.submittedAt)} · ${wordCount} words${fmt}`,
    "",
    `<b>Rubric</b> ${confidenceDot(rubric.confidence)}`,
    `• Word count: ${rubric.word_count ?? "any"}`,
    `• Keywords: ${rubric.topic_keywords.length ? rubric.topic_keywords.map((k) => esc(k)).join(", ") : "<i>none</i>"}`,
  ];
  if (rubric.notes) lines.push(`• Notes: ${esc(rubric.notes)}`);
  if (task.deliveryDescription) {
    lines.push("", `<i>Worker note: ${esc(task.deliveryDescription)}</i>`);
  }
  return lines.join("\n");
}

function renderRubricConfirmFromSession(session) {
  const m = session.meta ?? {};
  const subWords = String(session.submission ?? "").split(/\s+/).filter(Boolean).length;
  const sourceTag =
    m.submission_source === "pasted" ? " <i>(pasted)</i>" :
    m.submission_source === "summary" ? " <i>(summary only)</i>" :
    "";
  const lines = [
    `${categoryIcon(m.category)} <b>Task #${m.task_id ?? "?"}</b> · ${esc(session.requirements?.title || "Untitled")}`,
    `${formatBounty(m.bounty)} · submitted ${timeAgo(m.submitted_at)} · ${subWords} words${sourceTag}`,
    "",
    `<b>Rubric</b>`,
    `• Word count: ${session.requirements?.word_count ?? "any"}`,
    `• Keywords: ${session.requirements?.topic_keywords?.length ? session.requirements.topic_keywords.map(esc).join(", ") : "<i>none</i>"}`,
  ];
  if (session.requirements?.notes) lines.push(`• Notes: ${esc(session.requirements.notes)}`);
  return lines.join("\n");
}

function renderRecoveryPrompt(task, rubric, fetchResult) {
  const lines = [
    `${categoryIcon(task.category)} <b>Task #${task.id}</b> · ${esc(task.title || "Untitled")}`,
    `${formatBounty(task.bounty)} · submitted ${timeAgo(task.submittedAt)}`,
    "",
    `<b>⚠️ Couldn't auto-fetch the submission</b>`,
    `<i>${esc(fetchResult.reason)}</i>`,
  ];

  // What was submitted — surface every available reference so the poster can act manually.
  const submittedBits = [];
  if (fetchResult.proofUrl) {
    const isHash = /^[0-9a-fA-F]{40,}$/.test(fetchResult.proofUrl);
    if (isHash) {
      submittedBits.push(`<b>Hash:</b> <code>${esc(fetchResult.proofUrl)}</code>`);
    } else {
      const dead = fetchResult.reason.includes("no longer reachable") ? " <i>(dead)</i>" : "";
      submittedBits.push(`<b>URL:</b> <a href="${esc(fetchResult.proofUrl)}">${esc(truncate(fetchResult.proofUrl, 60))}</a>${dead}`);
    }
  }
  if (fetchResult.proofType) {
    submittedBits.push(`<b>Type:</b> ${esc(fetchResult.proofType)}`);
  }
  if (fetchResult.contentHash && fetchResult.contentHash !== fetchResult.proofUrl) {
    submittedBits.push(`<b>Content hash:</b> <code>${esc(fetchResult.contentHash.slice(0, 16))}…</code>`);
  }
  if (fetchResult.artifactRefs?.length) {
    submittedBits.push(`<b>Artifacts:</b> ${fetchResult.artifactRefs.map((r) => `<code>${esc(r)}</code>`).join(", ")}`);
  }
  if (submittedBits.length) {
    lines.push("", `<b>📎 What was submitted</b>`);
    for (const b of submittedBits) lines.push(b);
  }

  if (fetchResult.summary) {
    lines.push("", `<b>Worker's summary</b>`, `“${esc(fetchResult.summary)}”`);
  }

  const evidenceWithUrls = (fetchResult.evidence ?? []).filter((e) => e.url || e.note);
  if (evidenceWithUrls.length) {
    lines.push("", `<b>Evidence</b>`);
    for (const e of evidenceWithUrls.slice(0, 5)) {
      const label = e.label ? `<b>${esc(e.label)}</b>` : "•";
      const url = e.url ? ` — <a href="${esc(e.url)}">${esc(truncate(e.url, 50))}</a>` : "";
      const note = e.note ? (e.url ? `\n  ${esc(e.note)}` : ` ${esc(e.note)}`) : "";
      lines.push(`${label}${url}${note}`);
    }
  }

  lines.push(
    "",
    `<b>Rubric</b> ${confidenceDot(rubric.confidence)}`,
    `• Keywords: ${rubric.topic_keywords.length ? rubric.topic_keywords.map(esc).join(", ") : "<i>none</i>"}`,
  );
  if (rubric.notes) lines.push(`• Notes: ${esc(rubric.notes)}`);

  lines.push("", `<i>Open the task on 0xwork to view the submission, then paste it back here to grade.</i>`);
  return lines.join("\n");
}

function renderRubricSummary(reqs) {
  const lines = [
    `• Title: ${esc(reqs.title ?? "—")}`,
    `• Word count: ${reqs.word_count ?? "any"}`,
    `• Keywords: ${reqs.topic_keywords?.length ? reqs.topic_keywords.map(esc).join(", ") : "<i>none</i>"}`,
  ];
  if (reqs.notes) lines.push(`• Notes: ${esc(reqs.notes)}`);
  return lines.join("\n");
}

function renderVerdict(v, meta) {
  const tag =
    v.verdict === "approve" ? "✅ <b>APPROVE</b>" :
    v.verdict === "reject"  ? "❌ <b>REJECT</b>"  :
                              "⚠️ <b>REVIEW</b>";
  const confidence = typeof v.confidence === "number" ? ` · ${Math.round(v.confidence * 100)}%` : "";
  const taskRef = meta?.task_id ? ` · task #${meta.task_id}` : "";

  const lines = [`${tag}${confidence}${taskRef}`];

  if (v.reasoning) {
    lines.push("", `<i>${esc(v.reasoning)}</i>`);
  }

  const ev = v.evidence ?? {};
  const evBits = [];
  if (ev.word_count) {
    const wc = ev.word_count;
    const mark = wc.pass ? "✓" : "✗";
    evBits.push(`📏 Words: <b>${wc.submitted}${wc.required ? ` / ${wc.required}` : ""}</b> ${mark}`);
  }
  if (ev.topic_coverage?.score != null) {
    evBits.push(`🎯 Topic coverage: <b>${Math.round(ev.topic_coverage.score * 100)}%</b>`);
  }
  if (ev.readability?.band) {
    evBits.push(`📖 Readability: <b>${esc(ev.readability.band)}</b>`);
  }
  if (ev.structure?.variance) {
    evBits.push(`📐 Structure: <b>${esc(ev.structure.variance)}</b>`);
  }
  if (ev.structure?.issues?.length) {
    evBits.push(`⚠ Flags: ${ev.structure.issues.map((s) => esc(s)).join(", ")}`);
  }
  if (evBits.length) {
    lines.push("", `<b>📊 Evidence</b>`);
    for (const b of evBits) lines.push(b);
  }

  if (v.strengths?.length) {
    lines.push("", `<b>✨ Strengths</b>`);
    for (const s of v.strengths) lines.push(`• ${esc(s)}`);
  }
  if (v.concerns?.length) {
    lines.push("", `<b>⚠ Concerns</b>`);
    for (const c of v.concerns) lines.push(`• ${esc(c)}`);
  }

  if (v.fallback || v.x402?.bypassed) {
    const notes = [];
    if (v.fallback) notes.push("heuristics-only fallback (LLM unavailable)");
    if (v.x402?.bypassed) notes.push("payment skipped (test mode)");
    if (notes.length) lines.push("", `<i>${notes.join(" · ")}</i>`);
  }

  return lines.join("\n");
}

// ── Parsers ─────────────────────────────────────────────────────────────

function parseRubricEdit(text) {
  const out = {};
  const getLine = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im");
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const title = getLine("TITLE");
  const wc = getLine("WORD_COUNT");
  const kw = getLine("KEYWORDS");
  const notes = getLine("NOTES");
  if (title) out.title = title;
  if (wc) {
    const n = Number(wc);
    if (Number.isFinite(n) && n > 0) out.word_count = Math.round(n);
  }
  if (kw) out.topic_keywords = kw.split(",").map((s) => s.trim()).filter(Boolean);
  if (notes) out.notes = notes;
  return out;
}

function parseManualSubmission(text) {
  const sep = text.indexOf("\n---");
  if (sep === -1) return null;
  const header = text.slice(0, sep);
  const submission = text.slice(sep + 4).trim();
  if (!submission) return null;

  const getLine = (key) => {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im");
    const m = header.match(re);
    return m ? m[1].trim() : null;
  };

  const title = getLine("TITLE");
  if (!title) return null;
  const wcRaw = getLine("WORD_COUNT");
  const word_count = wcRaw ? Number(wcRaw) : undefined;
  const kwRaw = getLine("KEYWORDS");
  const topic_keywords = kwRaw
    ? kwRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    task_type: "writing",
    tier: "full",
    requirements: { title, word_count, topic_keywords },
    submission,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function short(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function stripDesc(s) {
  return String(s || "").split(/[.!?]/)[0].trim();
}

function categoryIcon(cat) {
  const c = String(cat ?? "").toLowerCase();
  if (c.includes("writing")) return "📝";
  if (c.includes("code") || c.includes("dev")) return "💻";
  if (c.includes("research")) return "🔬";
  if (c.includes("social") || c.includes("twitter") || c.includes("x post")) return "🌐";
  if (c.includes("design")) return "🎨";
  if (c.includes("data") || c.includes("analytics")) return "📊";
  return "📋";
}

function normalizeCategory(cat) {
  const c = String(cat ?? "").toLowerCase().trim();
  if (["code", "development", "dev"].includes(c)) return "code";
  if (["research"].includes(c)) return "research";
  if (["data", "analytics"].includes(c)) return "data";
  if (["social", "twitter", "x post", "x_post", "tweet"].includes(c)) return "social";
  if (["video", "media", "reel", "clip", "tiktok"].includes(c)) return "video";
  if (["writing", "content", "marketing"].includes(c)) return "writing";
  return "writing"; // safe default
}

function formatBounty(b) {
  const n = Number(b);
  if (!Number.isFinite(n)) return "—";
  return `${n} USDC`;
}

function timeAgo(ts) {
  if (!ts) return "recently";
  const d = typeof ts === "string" ? new Date(ts).getTime() : ts * (String(ts).length <= 10 ? 1000 : 1);
  if (!Number.isFinite(d)) return "recently";
  const diff = Date.now() - d;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function confidenceDot(c) {
  if (typeof c !== "number") return "";
  if (c >= 0.75) return "🟢";
  if (c >= 0.5) return "🟡";
  return "🔴";
}
