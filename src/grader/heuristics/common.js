// Shared utilities for category heuristics.

export const WORD_RE = /\b\w+\b/g;
export const SENT_RE = /[^.!?]+[.!?]+/g;
export const URL_RE = /https?:\/\/[^\s)<>"']+/gi;

// Canonical synonym/abbreviation map — both directions.
// Keys and values are lowercase. Expand as needed.
const SYNONYMS = {
  'l1':         ['layer 1', 'layer1'],
  'l2':         ['layer 2', 'layer2'],
  'l3':         ['layer 3', 'layer3'],
  'defi':       ['decentralized finance', 'decentralised finance'],
  'nft':        ['non-fungible token', 'non fungible token'],
  'dao':        ['decentralized autonomous organization', 'decentralised autonomous organisation'],
  'dex':        ['decentralized exchange', 'decentralised exchange'],
  'cex':        ['centralized exchange', 'centralised exchange'],
  'evm':        ['ethereum virtual machine'],
  'pos':        ['proof of stake'],
  'pow':        ['proof of work'],
  'zk':         ['zero knowledge', 'zero-knowledge'],
  'zkp':        ['zero knowledge proof', 'zero-knowledge proof'],
  'tvl':        ['total value locked'],
  'amm':        ['automated market maker'],
  'lp':         ['liquidity provider', 'liquidity pool'],
  'apy':        ['annual percentage yield'],
  'apr':        ['annual percentage rate'],
  'btc':        ['bitcoin'],
  'eth':        ['ethereum'],
  'sol':        ['solana'],
  'ux':         ['user experience'],
  'ui':         ['user interface'],
  'api':        ['application programming interface'],
  'sdk':        ['software development kit'],
  'kyc':        ['know your customer'],
  'aml':        ['anti money laundering', 'anti-money laundering'],
  'p2p':        ['peer to peer', 'peer-to-peer'],
  'ai':         ['artificial intelligence'],
  'ml':         ['machine learning'],
  'llm':        ['large language model'],
  'web3':       ['web 3', 'web3.0', 'web 3.0'],
  'nonce':      ['number once', 'number used once'],
  'gas':        ['gas fee', 'gas fees', 'transaction fee'],
  'tx':         ['transaction'],
  'addr':       ['address'],
  'sig':        ['signature'],
};

// Build reverse map: expanded form → abbreviation
const REVERSE_SYNONYMS = {};
for (const [abbr, expansions] of Object.entries(SYNONYMS)) {
  for (const exp of expansions) {
    REVERSE_SYNONYMS[exp] = abbr;
  }
}

// Returns all aliases for a keyword (the keyword itself + any synonyms)
function aliases(kw) {
  const lower = kw.toLowerCase().trim();
  const result = new Set([lower]);
  // abbr → expansions
  if (SYNONYMS[lower]) SYNONYMS[lower].forEach(e => result.add(e));
  // expansion → abbr
  if (REVERSE_SYNONYMS[lower]) result.add(REVERSE_SYNONYMS[lower]);
  return result;
}

// Count words — strip markdown, code blocks, and URLs first so they don't
// inflate the count. Hyphenated compounds count as one word.
export function words(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')      // fenced code blocks
    .replace(/`[^`]+`/g, '')             // inline code
    .replace(URL_RE, '')                 // URLs
    .trim()
    .split(/\s+/)
    .filter(w => /[a-zA-Z0-9]/.test(w)); // must contain at least one alphanumeric
}

export function sentences(text) {
  return text.match(SENT_RE) ?? [];
}

export function wordCount(text, required) {
  const n = words(text).length;
  if (required == null) {
    return { submitted: n, required: null, pass: true };
  }
  const pass = n >= Math.floor(required * 0.9) && n <= Math.ceil(required * 1.5);
  return { submitted: n, required, pass };
}

export function topicCoverage(text, keywords) {
  if (!keywords || keywords.length === 0) {
    return { score: null, hits: [], missing: [] };
  }
  const lower = text.toLowerCase();
  const hits = [];
  const missing = [];

  for (const kw of keywords) {
    const kwAliases = aliases(kw);
    let hit = false;

    for (const alias of kwAliases) {
      // Exact substring
      if (lower.includes(alias)) { hit = true; break; }
      // Token-level fuzzy (strips non-alphanumeric)
      const aliasStripped = alias.replace(/[^a-z0-9]/g, '');
      if (lower.split(/\s+/).some(tok => tok.replace(/[^a-z0-9]/g, '') === aliasStripped)) {
        hit = true; break;
      }
    }

    if (hit) hits.push(kw);
    else missing.push(kw);
  }

  return {
    score: Number((hits.length / keywords.length).toFixed(2)),
    hits,
    missing,
  };
}

export function extractUrls(text) {
  return text.match(URL_RE) ?? [];
}

export function uniqueDomains(urls) {
  const set = new Set();
  for (const u of urls) {
    try {
      set.add(new URL(u).hostname.replace(/^www\./, ""));
    } catch {}
  }
  return [...set];
}

