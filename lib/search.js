// Deferred-tool search: tokenizer, index, BM25 scoring, and `select:` syntax.
//
// Pure functions. No host service, no mask, no activation — those live in
// index.js. Keeping scoring testable without a host is the reason this is a
// separate module.
//
// Query forms (the shapes the model is told to use):
//   "select:Read,Edit"     exact names, requested order, missing names reported
//   "+slack send"          "slack" must appear in the tool name, rest ranks
//   "notebook jupyter"     plain keywords, BM25 top-N
//
// Ported from `dsh-toolbox-ui@1.8.2` `lib/tool-search-index.js` (MIT; see
// LICENSE-MIT-TOOLBOX-UI), with the measurements its comments record:
// `maxResults: 10` because top-5 dropped a third of serena's core tools while
// top-10 recovered all of them, and an s-stemmer rather than Porter because
// Porter over-stems ("references" → "refer") and measurably ranked worse.

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** Latin words split on non-alphanumerics; CJK gets character bigrams. */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const tokens = [];
  let cjkRun = '';
  let latin = '';
  const flushCjk = () => {
    if (cjkRun.length === 0) return;
    // A single CJK character cannot form a bigram; keep it whole.
    if (cjkRun.length === 1) tokens.push(cjkRun);
    else for (let i = 0; i < cjkRun.length - 1; i++) tokens.push(cjkRun.slice(i, i + 2));
    cjkRun = '';
  };
  const flushLatin = () => {
    if (latin !== '') {
      tokens.push(latin);
      latin = '';
    }
  };
  for (const char of source) {
    if (CJK.test(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }
    flushCjk();
    if (/[a-z0-9]/.test(char)) latin += char;
    else flushLatin();
  }
  flushCjk();
  flushLatin();
  return tokens;
}

/** Matchable variants of a tool name: the full name and the bare name after the server prefix. */
export function toolNameVariants(name) {
  const variants = [name];
  const separator = name.lastIndexOf('__');
  if (separator !== -1 && separator + 2 < name.length) variants.push(name.slice(separator + 2));
  return variants;
}

/**
 * Plural-only stemmer (s-stemmer). Deliberately not Porter: "symbol" vs
 * "symbols" is the common miss, while Porter also maps "declared" → "declar"
 * and measurably ranked worse on two real MCP inventories.
 *
 * Invariant: query side and document side must use the SAME value, or stemming
 * one side makes the match strictly worse than stemming neither.
 */
export function stemToken(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

export function applyStem(tokens, enabled) {
  return enabled ? tokens.map(stemToken) : tokens;
}

/**
 * Build the searchable index from tool schemas.
 *
 * Parameter text is indexed too: models often query by parameter name
 * ("screenshot", "timeout"), which appears nowhere else.
 *
 * @param {Array<{name: string, description?: string, parameters?: object}>} schemas
 * @param {boolean} stem
 * @returns {Map<string, object>}
 */
export function buildIndex(schemas, stem = false) {
  const index = new Map();
  for (const schema of schemas ?? []) {
    if (!schema || typeof schema.name !== 'string' || schema.name === '') continue;
    const description = typeof schema.description === 'string' ? schema.description : '';
    const parameters = schema.parameters ?? null;
    const parameterText = parameters === null ? '' : JSON.stringify(parameters);
    const document = [schema.name, description, parameterText].join(' ');
    index.set(schema.name, {
      name: schema.name,
      description,
      parameters,
      nameTokens: new Set(applyStem(tokenize(schema.name), stem)),
      documentTokens: applyStem(tokenize(document), stem),
    });
  }
  return index;
}

/**
 * Parse a query into its internal form. `raw` keeps the normalized text so an
 * exact-name query can be pinned without depending on BM25 score drift.
 */
export function parseQuery(query) {
  const trimmed = String(query ?? '').trim();
  if (trimmed === '') return { kind: 'empty', raw: trimmed };
  if (trimmed.startsWith('select:')) {
    const names = trimmed
      .slice('select:'.length)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    return { kind: 'select', names, raw: trimmed };
  }
  if (trimmed.startsWith('+')) {
    // "+server words": the leading segment is a hard name constraint. It must be
    // tokenized with the same rules as tool names, because a server name may
    // contain `-`/`_` and the public name splits on non-alphanumerics —
    // "chrome-devtools" becomes ['chrome','devtools'] in the name.
    const head = /^\+(\S+)/.exec(trimmed);
    const requiredTokens = head === null ? [] : [...new Set(tokenize(head[1]))];
    const rest = head === null ? trimmed : trimmed.slice(head[0].length);
    return { kind: 'filter', requiredTokens, terms: tokenize(rest), raw: trimmed };
  }
  return { kind: 'keywords', terms: tokenize(trimmed), raw: trimmed };
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Score for the query term hitting the tool's name; keeps "search by name" above "mentioned in prose". */
const NAME_BONUS = 12;

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Run one search.
 *
 * `select:` reports every requested name in request order, including missing
 * ones as `found: false` — the model asked a direct question and deserves a
 * direct answer rather than a silent drop.
 *
 * @param {Map<string, object>} index
 * @param {string} query
 * @param {number} maxResults
 * @param {boolean} stem must equal the value used by {@link buildIndex}
 */
export function searchIndex(index, query, maxResults = 10, stem = false) {
  const limit = Math.max(1, Math.floor(maxResults) || 1);
  const parsed = parseQuery(query);
  if (parsed.kind === 'empty' || index.size === 0) return [];

  if (parsed.kind === 'select') {
    const matches = [];
    const seen = new Set();
    for (const name of parsed.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = index.get(name);
      if (entry === undefined) {
        matches.push({ name, found: false });
        continue;
      }
      matches.push({ name: entry.name, description: entry.description, parameters: entry.parameters, found: true });
    }
    return matches;
  }

  const documents = [...index.values()];
  const averageLength = documents.reduce((sum, doc) => sum + doc.documentTokens.length, 0) / documents.length;
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of new Set(doc.documentTokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const idf = (token) => {
    const df = documentFrequency.get(token) ?? 0;
    return Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
  };

  const rawLower = parsed.raw.toLowerCase();
  const isExactName = (doc) => toolNameVariants(doc.name).some((variant) => variant.toLowerCase() === rawLower);
  const scored = [];
  for (const doc of documents) {
    if (parsed.kind === 'filter' && parsed.requiredTokens.length > 0) {
      const required = applyStem(parsed.requiredTokens, stem);
      if (!required.every((token) => doc.nameTokens.has(token))) continue;
    }
    if (isExactName(doc)) {
      scored.push({ entry: doc, score: Infinity });
      continue;
    }
    const terms = applyStem(parsed.terms, stem);
    if (terms.length === 0) {
      // Constraints only (e.g. "+slack"): neutral score, catalog order.
      scored.push({ entry: doc, score: 0 });
      continue;
    }
    const frequency = new Map();
    for (const token of doc.documentTokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
    let score = 0;
    let nameHit = false;
    for (const token of terms) {
      const tf = frequency.get(token) ?? 0;
      if (tf === 0) continue;
      const norm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.documentTokens.length) / averageLength));
      score += idf(token) * norm;
      if (doc.nameTokens.has(token)) nameHit = true;
      if (toolNameVariants(doc.name).includes(token)) nameHit = true;
    }
    if (nameHit) score += NAME_BONUS;
    if (score > 0) scored.push({ entry: doc, score });
  }

  // Ties break on code-unit order, not localeCompare: ICU collation varies by
  // region and would make the result order non-deterministic across machines.
  scored.sort((left, right) => right.score - left.score || compareNames(left.entry.name, right.entry.name));
  return scored.slice(0, limit).map(({ entry }) => ({
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    found: true,
  }));
}
