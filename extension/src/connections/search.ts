import type { ConnectionTool } from './tools';

/**
 * Lexical search over connection tools for `find_connection_tools`. Each tool is a bag of tokens
 * from its name, title, parameter names and the start of its description, weighted by repetition
 * (name and title count most), scored with BM25 against the query. The corpus is at most a few
 * hundred short documents, so nothing is indexed or stored: every search scores from scratch.
 * An exact tool name in the query outranks any score, because the find tool's description lists
 * the names and the model usually asks for one of them. Query words are widened with a few
 * generic tool-verb/noun synonyms ("add" → create, "find" → search), since the model phrases the
 * need in the student's words and the server names the tool in its own.
 */

export interface SearchHit {
  tool: ConnectionTool;
  score: number;
  exact: boolean;
}

const STOPWORDS = new Set(
  'a an the to of for in on at and or with by from into about as is are be been do does get set my your our their this that these those it its me i we you can could would should will please some any all'.split(' ')
);

/** Stemmed query word → stemmed words a server is likelier to use. Generic on purpose: no service names. */
const SYNONYMS: Record<string, string[]> = {
  add: ['creat'], writ: ['creat'], new: ['creat'], make: ['creat'], insert: ['creat'], draft: ['creat'],
  edit: ['updat'], chang: ['updat'], modify: ['updat'], renam: ['updat'], revis: ['updat'],
  remov: ['delet'], eras: ['delet'], trash: ['delet'],
  find: ['search'], look: ['search'], lookup: ['search'], query: ['search'],
  read: ['fetch'], open: ['fetch'], view: ['fetch'], show: ['fetch'], retriev: ['fetch'],
  note: ['page'], doc: ['page'], document: ['page'],
  table: ['databas'], spreadsheet: ['databas'],
  meet: ['event'], remind: ['task'], todo: ['task'],
};

const K1 = 1.2;
const B = 0.75;
const WEIGHT = { name: 6, title: 6, params: 3, description: 2 };
const DESCRIPTION_CHARS = 300;

/** `creating` / `created` / `creates` → `creat`, `pages` → `page`, `entries` → `entry`. */
function stem(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.endsWith('sses')) t = t.slice(0, -2);
  else if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  // create / creating, update / updated land on the same stem
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function bagFor(tool: ConnectionTool): string[] {
  const properties = tool.tool.inputSchema.properties;
  const params = properties && typeof properties === 'object' ? Object.keys(properties).join(' ') : '';
  const fields: Array<[string, number]> = [
    [tool.tool.name, WEIGHT.name],
    [tool.tool.title ?? '', WEIGHT.title],
    [params, WEIGHT.params],
    [(tool.tool.description ?? '').slice(0, DESCRIPTION_CHARS), WEIGHT.description],
  ];
  const bag: string[] = [];
  for (const [text, weight] of fields) {
    const tokens = tokenize(text);
    for (let i = 0; i < weight; i++) bag.push(...tokens);
  }
  return bag;
}

/** The query as a whole and each whitespace/comma-separated piece of it, normalized like tool names. */
function nameCandidates(query: string): Array<{ name: string; words: number }> {
  const pieces = [query, ...query.split(/[\s,]+/)];
  return pieces
    .map((p) => ({ name: normalizeName(p), words: p.split(/[\s_.-]+/).filter(Boolean).length }))
    .filter((c) => c.name.length >= 4);
}

/**
 * The query names this tool: equal to its MCP or function name, or — for servers that prefix every
 * name (`notion-create-pages`) — equal to the end of it when the query is at least two words
 * (`create-pages`, `create pages`). A single word never matches a name's end: "comment" is not
 * `notion-create-comment`.
 */
function namesTool(candidates: Array<{ name: string; words: number }>, tool: ConnectionTool): boolean {
  const names = [normalizeName(tool.tool.name), normalizeName(tool.name)];
  return candidates.some((c) => names.some((n) => n === c.name || (c.words >= 2 && n.endsWith(c.name))));
}

export function searchConnectionTools(tools: ConnectionTool[], query: string, service?: string): SearchHit[] {
  const wanted = service?.trim().toLowerCase();
  const inService = wanted ? tools.filter((t) => t.connection.name.toLowerCase() === wanted || t.connection.slug === wanted) : [];
  const scope = inService.length ? inService : tools; // an unknown service searches everything
  if (!scope.length) return [];

  const docs = scope.map((tool) => {
    const bag = bagFor(tool);
    const tf = new Map<string, number>();
    for (const token of bag) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { tool, length: bag.length, tf };
  });
  const averageLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  // A word with a synonym counts half, its synonym in full: "add" is rare in descriptions ("Add a
  // comment"), so at full weight it would outrank the tool that actually creates things
  const weights = new Map<string, number>();
  for (const t of tokenize(query)) {
    const synonyms = SYNONYMS[t] ?? [];
    weights.set(t, Math.max(weights.get(t) ?? 0, synonyms.length ? 0.5 : 1));
    for (const s of synonyms) weights.set(s, 1);
  }
  const terms = [...weights.keys()];
  const idf = new Map(
    terms.map((term) => {
      const df = docs.filter((d) => d.tf.has(term)).length;
      return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
    })
  );

  const candidates = nameCandidates(query);
  const hits: SearchHit[] = docs.map(({ tool, length, tf }) => {
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f) score += (weights.get(term) ?? 1) * (idf.get(term) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * length) / averageLength)));
    }
    const exact = namesTool(candidates, tool);
    return { tool, score, exact };
  });

  return hits
    .filter((h) => h.exact || h.score > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
}

/**
 * What a search loads: the named tools when the query names any (and nothing else), otherwise
 * scored hits while they stay within 30 % of the best score; at most `max`, and — except for the
 * first — within `tokenBudget` of definitions.
 */
export function pickToLoad(hits: SearchHit[], limits: { max: number; tokenBudget: number }): ConnectionTool[] {
  if (hits.some((h) => h.exact)) hits = hits.filter((h) => h.exact);
  const best = hits.find((h) => !h.exact)?.score ?? 0;
  const picked: ConnectionTool[] = [];
  let tokens = 0;
  for (const hit of hits) {
    if (picked.length >= limits.max) break;
    if (!hit.exact && hit.score < 0.3 * best) break; // sorted, so nothing after this qualifies
    if (picked.length && tokens + hit.tool.tokens > limits.tokenBudget) continue;
    picked.push(hit.tool);
    tokens += hit.tool.tokens;
  }
  return picked;
}
