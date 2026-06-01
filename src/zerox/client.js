// 0xwork public API client.
// API base: https://api.0xwork.org
// Used to list a poster's in-review submissions and fetch the submitted proof.

import { convert as htmlToText } from "html-to-text";

const API = process.env.ZEROXWORK_API_URL || "https://api.0xwork.org";
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/";

const PROOF_FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_BYTES = 5_000_000;     // 5 MB raw download cap
const MAX_TEXT_LENGTH = 200_000;       // 200K chars of extracted text cap

/** List tasks the given poster has waiting for review. */
export async function listInReviewByPoster(posterAddress, { limit = 20 } = {}) {
  // 0xwork's /tasks endpoint silently ignores poster_address — it returns
  // ALL Submitted tasks regardless of the filter. So we pull a wider page
  // and filter client-side. Still pass the param in case the API gains
  // support for it later.
  const fetchLimit = Math.max(limit * 10, 200);
  const url = `${API}/tasks?poster_address=${encodeURIComponent(
    posterAddress,
  )}&status=Submitted&limit=${fetchLimit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`0xwork list failed: HTTP ${res.status}`);
  const data = await res.json();
  const tasks = data.tasks ?? data ?? [];
  const want = posterAddress.toLowerCase();
  const filtered = tasks
    .filter((t) => (t.poster_address ?? t.poster ?? "").toLowerCase() === want)
    .slice(0, limit);
  return filtered.map(normalizeTask);
}

/** Fetch a single task by id. Tries /tasks/:id then falls back to filtering /tasks. */
export async function getTaskById(taskId) {
  const direct = await fetch(`${API}/tasks/${encodeURIComponent(taskId)}`).catch(() => null);
  if (direct?.ok) {
    const data = await direct.json();
    const task = data.task ?? data;
    if (task && (task.id ?? task.task_id) != null) return normalizeTask(task);
  }
  const res = await fetch(`${API}/tasks?limit=200`);
  if (!res.ok) throw new Error(`0xwork list failed: HTTP ${res.status}`);
  const data = await res.json();
  const tasks = data.tasks ?? data ?? [];
  const task = tasks.find((t) => String(t.id ?? t.task_id) === String(taskId));
  return task ? normalizeTask(task) : null;
}

/** Fetch /tasks/:id/comments — public, no auth. Returns { comments, count }. */
export async function listComments(taskId) {
  const res = await fetch(`${API}/tasks/${encodeURIComponent(taskId)}/comments`);
  if (!res.ok) throw new Error(`0xwork comments failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    comments: Array.isArray(data.comments) ? data.comments : [],
    count: typeof data.count === "number" ? data.count : (data.comments?.length ?? 0),
  };
}

/** Fetch a fresh SIWE nonce from /auth/nonce. Returns the nonce string. */
export async function getAuthNonce() {
  const res = await fetch(`${API}/auth/nonce`);
  if (!res.ok) throw new Error(`0xwork nonce failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.nonce;
}

/** Fetch /tasks/:id/proof — richer than the bare proof_hash. Returns null on 404. */
export async function getProofMeta(taskId) {
  const res = await fetch(`${API}/tasks/${encodeURIComponent(taskId)}/proof`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`proof meta failed: HTTP ${res.status}`);
  const data = await res.json();
  const p = data.proof ?? {};
  return {
    proofType: p.proofType ?? null,
    proofUrl: p.proofUrl ?? null,
    summary: p.summary ?? null,
    title: p.title ?? null,
    evidence: Array.isArray(p.evidence) ? p.evidence : [],
    artifactRefs: Array.isArray(p.artifactRefs) ? p.artifactRefs : [],
    contentHash: p.contentHash ?? null,
    linkHealth: p.linkHealth ?? null,
    workerAddress: p.workerAddress ?? null,
    raw: data,
  };
}

/**
 * Get the submission for a task. Returns one of:
 *   { kind: "content", text, url, contentType, size }
 *   { kind: "needs_manual", reason, summary, evidence[], evidenceNotes[],
 *                            proofType, proofUrl, contentHash, artifactRefs[] }
 */
export async function getSubmission(taskId, fallbackProofUrl) {
  let meta = null;
  try {
    meta = await getProofMeta(taskId);
  } catch (err) {
    console.warn("[zerox] proof meta lookup failed:", err.message);
  }

  const url = meta?.proofUrl ?? fallbackProofUrl ?? null;
  const linkDead = meta?.linkHealth?.ok === false;
  const isHashOnly = url && /^[0-9a-fA-F]{40,}$/.test(url);

  const makeManual = (reason, errorKind = "unreachable") => ({
    kind: "needs_manual",
    reason,
    errorKind,
    summary: meta?.summary ?? null,
    evidence: (meta?.evidence ?? []).map((e) => ({
      label: e.label ?? null,
      kind: e.kind ?? null,
      url: e.url ?? null,
      note: e.note ?? null,
    })),
    evidenceNotes: (meta?.evidence ?? [])
      .map((e) => e.note)
      .filter((s) => typeof s === "string" && s.trim().length > 0),
    proofType: meta?.proofType ?? null,
    proofUrl: url,
    contentHash: meta?.contentHash ?? null,
    artifactRefs: meta?.artifactRefs ?? [],
  });

  if (!url) return makeManual("No submission URL was provided", "unreachable");
  if (linkDead) return makeManual("The proof URL is no longer reachable", "deleted");
  if (isHashOnly && meta?.proofType === "agent_browser") {
    return makeManual("The submission was delivered through a private channel (no public URL)", "hash_only");
  }
  if (isHashOnly) return makeManual("The proof is a raw hash, not a fetchable URL", "hash_only");

  try {
    const content = await fetchProofContent(url);
    return {
      kind: "content",
      ...content,
      // Surface proof metadata on the happy path too so multi-format submissions
      // (screenshots, artifact refs, worker summary) flow through to the grader
      // — not just on the needs_manual branch.
      summary: meta?.summary ?? null,
      evidence: meta?.evidence ?? [],
      artifactRefs: meta?.artifactRefs ?? [],
      contentHash: meta?.contentHash ?? null,
      proofType: meta?.proofType ?? null,
    };
  } catch (err) {
    return makeManual(`Couldn't fetch the proof URL (${err.message})`, err.proofErrorKind ?? "unreachable");
  }
}

// Refuses to fetch URLs that resolve (textually, pre-DNS) to private / link-local /
// cloud-metadata addresses. The DNS-rebinding case (hostname resolves to public,
// then to private on second lookup) isn't covered by this check — for that you'd
// need an HTTP client that pins resolved IPs. Best-effort blocklist for now.
const PRIVATE_HOST_RE =
  /^(?:localhost|0(?:\.0){0,3}|127(?:\.\d{1,3}){0,3}|10(?:\.\d{1,3}){0,3}|192\.168(?:\.\d{1,3}){0,2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){0,2}|169\.254(?:\.\d{1,3}){0,2}|fc00:|fd[0-9a-f]{2}:|fe80:|::1|metadata\.google\.internal|169\.254\.169\.254)$/i;

function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`refused scheme: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) {
    throw new Error(`refused private/internal host: ${host}`);
  }
}

/** Resolve a proof URL and return its content as text, with format detection. */
export async function fetchProofContent(proofUrl) {
  if (!proofUrl) throw new Error("no proof url");
  let url = proofUrl;
  if (/^[0-9a-fA-F]{40,}$/.test(url)) {
    throw new Error("proof is a raw hash, not a fetchable URL");
  }
  if (url.startsWith("ipfs://")) {
    const cid = url.slice("ipfs://".length).replace(/^\/+/, "");
    url = IPFS_GATEWAY + cid;
  }
  url = rewriteUrl(url);
  assertPublicUrl(url);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROOF_FETCH_TIMEOUT_MS);
  try {
    // Walk redirects manually so we can re-check each hop against the SSRF
    // blocklist. fetch(..., {redirect: "follow"}) would silently jump to
    // an internal address if a public host returned 302 to 169.254.x.x.
    let current = url;
    let res;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(current, { redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        assertPublicUrl(current);
        continue;
      }
      break;
    }
    if (!res.ok) {
      const kind = res.status === 404 ? "deleted"
        : (res.status === 403 || res.status === 401) ? "restricted"
        : res.status === 429 ? "rate_limited"
        : res.status >= 500 ? "server_error"
        : "unreachable";
      throw Object.assign(new Error(`proof fetch failed: HTTP ${res.status}`), { proofErrorKind: kind });
    }
    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`proof too large: ${buf.byteLength} bytes (max ${MAX_FETCH_BYTES})`);
    }

    const format = detectFormat(url, contentType, buf);
    let text;
    let extras = {};

    if (format === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const data = await parser.getText();
      text = data.text ?? "";
      extras = { pages: data.total ?? null };
    } else if (format === "html") {
      const raw = buf.toString("utf-8");
      text = htmlToText(raw, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { ignoreHref: false } },
          { selector: "img", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "nav", format: "skip" },
          { selector: "header", format: "skip" },
          { selector: "footer", format: "skip" },
        ],
      });
    } else {
      text = buf.toString("utf-8");
    }

    text = text.trim();
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + "\n\n[…truncated]";
    }

    return { url, contentType, format, text, size: buf.byteLength, ...extras };
  } finally {
    clearTimeout(timer);
  }
}

function detectFormat(url, contentType, buf) {
  const ct = (contentType || "").toLowerCase();
  const path = url.toLowerCase().split("?")[0];

  if (ct.includes("pdf") || path.endsWith(".pdf") || buf.slice(0, 4).toString() === "%PDF") {
    return "pdf";
  }
  if (ct.includes("html") || path.endsWith(".html") || path.endsWith(".htm")) {
    return "html";
  }
  if (ct.includes("markdown") || path.endsWith(".md") || path.endsWith(".markdown")) {
    return "markdown";
  }
  if (ct.includes("json") || path.endsWith(".json")) {
    return "json";
  }
  // Heuristic: if it sniffs as HTML but content-type wasn't set, treat as html
  const head = buf.slice(0, 1024).toString("utf-8").toLowerCase();
  if (/<!doctype html|<html|<head|<body/.test(head)) return "html";
  return "text";
}

function rewriteUrl(url) {
  // GitHub blob → raw
  const ghBlob = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (ghBlob) {
    return `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;
  }
  // GitHub Gist → raw
  const gist = url.match(/^https:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)(?:\/.*)?$/);
  if (gist) {
    return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`;
  }
  // Google Docs → export as plain text (works for publicly shared docs)
  const gdoc = url.match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)(?:\/.*)?$/);
  if (gdoc) {
    return `https://docs.google.com/document/d/${gdoc[1]}/export?format=txt`;
  }
  return url;
}

function normalizeTask(t) {
  return {
    id: t.id ?? t.task_id ?? t.chainTaskId ?? t.chain_task_id ?? null,
    title: t.title ?? null,
    category: t.category ?? null,
    description: t.description ?? "",
    requirements: t.requirements ?? null,
    bounty: Number.parseFloat(t.bounty ?? t.bounty_amount ?? 0) || 0,
    posterAddress: t.poster_address ?? t.poster ?? null,
    workerAddress: t.worker_address ?? t.worker ?? null,
    discountedFee: Boolean(t.discounted_fee ?? t.discountedFee ?? false),
    state: t.state ?? t.status ?? null,
    proofUrl: t.delivery_link ?? t.proof_hash ?? t.proof ?? t.proof_url ?? t.proofHash ?? null,
    deliveryDescription: t.delivery_description ?? null,
    deadline: t.deadline ?? null,
    submittedAt: t.submit_timestamp ?? null,
    resultsBased: Boolean(t.results_based ?? t.resultsBased ?? false),
    raw: t,
  };
}
