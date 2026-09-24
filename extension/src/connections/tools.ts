import type { ToolSpec } from '../providers/types';
import { estimateTokenCount } from '../utils/tokens';
import { callTool, McpAuthError, type CallToolResult } from './mcp';
import { describeFailure, markNeedsAuth } from './manage';
import { pickToLoad, searchConnectionTools } from './search';
import type { ConnectionRecord, McpToolInfo } from './store';

/**
 * Connection tools as the agent sees them. Each enabled tool of an enabled, working connection
 * becomes a function named `<slug>__<tool>` whose schema is the server's own JSON Schema, sent after
 * the built-in tools. Unlike built-in tools, arguments are passed through with their JSON types,
 * since the server validates them against the schema it published.
 *
 * Small setups declare every tool on every call (eager). Past `EAGER_CONNECTION_TOKENS` of
 * definitions, tools load on demand (lazy): only `find_connection_tools` is declared up front, a
 * search loads the matching tools into the chat, and a chat's loaded set is declared from then on,
 * bounded by the student's `loadedToolsMax` / `loadedToolsTokenBudget` settings.
 */

export interface ConnectionTool {
  /** The function name the model sees. */
  name: string;
  connection: ConnectionRecord;
  tool: McpToolInfo;
  /** Step label: "Notion: Search". */
  label: string;
  description: string;
  /** JSON Schema of the arguments, with `type: "object"` and `properties` guaranteed. */
  parameters: ToolSpec['parameters'];
  /** Estimated tokens of the definition as sent to the model. */
  tokens: number;
}

/** A tool a chat has loaded. Keyed by connection id + MCP tool name, so a renamed connection keeps it. */
export interface LoadedTool {
  connectionId: string;
  tool: string;
  lastUsed: number;
}

export type ToolLoading = 'none' | 'eager' | 'lazy';

export const EAGER_CONNECTION_TOKENS = 2000;
export const FIND_TOOL_NAME = 'find_connection_tools';
const LOAD_PER_SEARCH = 5;
const NAMES_PER_SERVICE = 60;
const INDEX_MAX = 60;

const NAME_MAX = 64; // OpenAI's limit; Gemini's is the same
const DESCRIPTION_MAX = 1500;
const RESULT_MAX = 12000;

function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36).slice(0, 6);
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function objectSchema(schema: Record<string, unknown>): ToolSpec['parameters'] {
  const { $schema: _schema, ...rest } = schema;
  const properties = rest.properties && typeof rest.properties === 'object' ? (rest.properties as ToolSpec['parameters']['properties']) : {};
  return { ...rest, type: 'object', properties };
}

function definitionFor(connection: ConnectionRecord, tool: McpToolInfo) {
  const about = tool.description || tool.title || humanize(tool.name);
  return {
    label: `${connection.name}: ${tool.title || humanize(tool.name)}`,
    description: `[${connection.name}] ${about.length > DESCRIPTION_MAX ? `${about.slice(0, DESCRIPTION_MAX)}…` : about}`,
    parameters: objectSchema(tool.inputSchema),
  };
}

/** Estimated tokens of one tool's definition, for Settings (the same estimate the loop uses). */
export function toolDefinitionTokens(connection: ConnectionRecord, tool: McpToolInfo): number {
  const { description, parameters } = definitionFor(connection, tool);
  return estimateTokenCount(JSON.stringify({ name: `${connection.slug}__${tool.name}`, description, parameters }));
}

export function connectionTools(connections: ConnectionRecord[]): ConnectionTool[] {
  const out: ConnectionTool[] = [];
  const taken = new Set<string>();
  for (const connection of connections) {
    if (!connection.enabled || connection.status !== 'ok') continue;
    const disabled = connection.disabledTools ?? [];
    for (const tool of connection.tools) {
      if (disabled.includes(tool.name)) continue;
      let name = `${connection.slug}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      if (name.length > NAME_MAX || taken.has(name)) name = `${name.slice(0, NAME_MAX - 7)}_${shortHash(`${connection.id}/${tool.name}`)}`;
      taken.add(name);
      const definition = definitionFor(connection, tool);
      const tokens = estimateTokenCount(JSON.stringify({ name, description: definition.description, parameters: definition.parameters }));
      out.push({ name, connection, tool, ...definition, tokens });
    }
  }
  return out;
}

export const toolTokens = (tools: ConnectionTool[]) => tools.reduce((sum, t) => sum + t.tokens, 0);

export function toolLoading(tools: ConnectionTool[]): ToolLoading {
  if (!tools.length) return 'none';
  return toolTokens(tools) > EAGER_CONNECTION_TOKENS ? 'lazy' : 'eager';
}

/** First sentence of the description, clipped. */
function summaryOf(tool: ConnectionTool, max: number): string {
  const text = (tool.tool.description || tool.tool.title || humanize(tool.tool.name)).replace(/\s+/g, ' ').trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

// ---------------------------------------------------------------------------
// Lazy loading: the find tool and the loaded set
// ---------------------------------------------------------------------------

/** `find_connection_tools`, with every connected tool's name in its description so the model can ask by name. */
export function findToolConfig(tools: ConnectionTool[]): ToolSpec {
  const byService = new Map<string, string[]>();
  for (const t of tools) byService.set(t.connection.name, [...(byService.get(t.connection.name) ?? []), t.tool.name]);
  const lines = [...byService].map(([service, names]) => {
    const shown = names.slice(0, NAMES_PER_SERVICE).join(', ');
    return `${service}: ${shown}${names.length > NAMES_PER_SERVICE ? `, …and ${names.length - NAMES_PER_SERVICE} more; search by what you need` : ''}`;
  });
  return {
    name: FIND_TOOL_NAME,
    description: `Find and load tools of the student's connected services. Pass a tool name from the list below, or a few words for what you need to do. Loaded tools can be called from your next step and stay loaded in this chat; do not search again for a tool already loaded.\n${lines.join('\n')}`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A tool name from the list, or a few words for what you need to do.' },
        service: { type: 'string', description: 'Only search this service.', enum: [...byService.keys()] },
      },
      required: ['query'],
    },
  };
}

const isLoaded = (loaded: LoadedTool[], tool: ConnectionTool) =>
  loaded.some((l) => l.connectionId === tool.connection.id && l.tool === tool.tool.name);

/** The loaded set as live tools, in load order. Entries whose tool is gone, switched off or not working are skipped, not dropped. */
export function resolveLoaded(live: ConnectionTool[], loaded: LoadedTool[]): ConnectionTool[] {
  const out: ConnectionTool[] = [];
  for (const entry of loaded) {
    const tool = live.find((t) => t.connection.id === entry.connectionId && t.tool.name === entry.tool);
    if (tool) out.push(tool);
  }
  return out;
}

/**
 * Adds `tools` to the loaded set (appended, so earlier declarations keep their place) or marks
 * them used, then evicts least-recently-used entries until the set fits `max` and `tokenBudget`.
 * The tools of this call are never evicted by it; one tool larger than the budget still loads.
 */
export function applyLoad(
  loaded: LoadedTool[],
  tools: ConnectionTool[],
  live: ConnectionTool[],
  limits: { max: number; tokenBudget: number },
  now = Date.now()
): LoadedTool[] {
  const keep = new Set(tools.map((t) => `${t.connection.id}/${t.tool.name}`));
  let next = loaded.map((l) => (keep.has(`${l.connectionId}/${l.tool}`) ? { ...l, lastUsed: now } : l));
  for (const t of tools) {
    if (!isLoaded(next, t)) next.push({ connectionId: t.connection.id, tool: t.tool.name, lastUsed: now });
  }

  const tokensOf = (entry: LoadedTool) =>
    live.find((t) => t.connection.id === entry.connectionId && t.tool.name === entry.tool)?.tokens ?? 0;
  const active = () => next.filter((l) => tokensOf(l) > 0);
  const over = () => {
    const current = active();
    return current.length > limits.max || current.reduce((sum, l) => sum + tokensOf(l), 0) > limits.tokenBudget;
  };
  while (over()) {
    const victim = active()
      .filter((l) => !keep.has(`${l.connectionId}/${l.tool}`))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) break;
    next = next.filter((l) => l !== victim);
  }
  // Entries of switched-off tools wait to come back, but not forever
  const inactive = next.filter((l) => tokensOf(l) === 0);
  if (inactive.length > limits.max) {
    const drop = new Set(inactive.sort((a, b) => a.lastUsed - b.lastUsed).slice(0, inactive.length - limits.max));
    next = next.filter((l) => !drop.has(l));
  }
  return next;
}

/**
 * Runs `find_connection_tools`. Pure: returns the JSON for the model and the tools to load; the
 * loop applies the load to the chat. Like every built-in tool, args are strings and it never throws.
 */
export function runFindConnectionTools(
  live: ConnectionTool[],
  loaded: LoadedTool[],
  args: Record<string, string>,
  limits: { max: number; tokenBudget: number }
): { result: string; load: ConnectionTool[] } {
  const query = (args.query ?? '').trim();
  if (!query) return { result: JSON.stringify({ error: 'Pass query: a tool name or a few words for what you need.' }), load: [] };

  const hits = searchConnectionTools(live, query, args.service);
  const picked = pickToLoad(hits, { max: Math.min(LOAD_PER_SEARCH, limits.max), tokenBudget: limits.tokenBudget });
  if (!picked.length) {
    const wanted = args.service?.trim().toLowerCase();
    const scoped = live.filter((t) => !wanted || t.connection.name.toLowerCase() === wanted || t.connection.slug === wanted);
    const index = (scoped.length ? scoped : live).slice(0, INDEX_MAX).map((t) => ({ name: t.tool.name, summary: summaryOf(t, 80) }));
    return {
      result: JSON.stringify({ loaded: [], index, note: 'No tool matched. Search again with an exact name from this list.' }),
      load: [],
    };
  }

  const already = picked.filter((t) => isLoaded(loaded, t));
  const fresh = picked.filter((t) => !isLoaded(loaded, t));
  return {
    result: JSON.stringify({
      loaded: fresh.map((t) => ({ name: t.name, summary: summaryOf(t, 120), changes_something: !t.tool.readOnly })),
      ...(already.length ? { already_loaded: already.map((t) => t.name) } : {}),
      note: 'Loaded tools can be called from your next step.',
    }),
    load: picked, // already-loaded hits are marked used
  };
}

/**
 * The result for a call to a function that does not exist. With connections live it lists the
 * function names that do (all of them run, loaded or not), scoped to the service whose slug the
 * name starts with. Aggregators return app actions by name inside a result (Composio's search:
 * `GOOGLECALENDAR_CREATE_EVENT`), and models then call those as `<app>__<action>`; the note sends
 * them back to the service's own tools, without naming any service.
 */
export function unknownToolResult(name: string, live: ConnectionTool[]): string {
  if (!live.length) return JSON.stringify({ error: `Tool not found: ${name}` });
  const prefix = name.includes('__') ? name.slice(0, name.indexOf('__')) : null;
  const scoped = live.filter((t) => t.connection.slug === prefix);
  const tools: Record<string, string[]> = {};
  for (const t of scoped.length ? scoped : live) {
    const names = (tools[t.connection.name] ??= []);
    if (names.length < NAMES_PER_SERVICE) names.push(t.name);
  }
  return JSON.stringify({
    error: `No tool is named ${name}. Only the connection tools listed here can be called, by these exact names.`,
    tools,
    note: "A name that appears inside a tool's result (an action a service's search returned) is not a function you can call. Run it through that service's own tool for executing actions, passing the name as an argument.",
  });
}

// ---------------------------------------------------------------------------
// Running a call
// ---------------------------------------------------------------------------

/** Whether the call may run without asking: the server marks the tool read-only, or the user said "always allow". */
export function runsWithoutAsking(tool: ConnectionTool): boolean {
  return tool.tool.readOnly || tool.connection.alwaysAllow.includes(tool.tool.name);
}

/** A `CallToolResult` as the JSON string the loop hands the model: `{ result }` or `{ error }`. */
function shapeResult(result: CallToolResult | null | undefined): string {
  const parts: string[] = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item?.type === 'resource' && typeof item.resource?.text === 'string') parts.push(item.resource.text);
    else if (item?.type === 'resource_link' && item.uri) parts.push(`<${item.uri}>${item.name ? ` ${item.name}` : ''}`);
    else if (item?.type) parts.push(`[${item.type} content omitted]`);
  }
  const text = parts.join('\n\n');
  if (result?.isError) return JSON.stringify({ error: (text || 'The tool reported an error.').slice(0, 2000) });
  const body = text || (result?.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : '');
  if (body.length <= RESULT_MAX) return JSON.stringify({ result: body });
  return JSON.stringify({ result: body.slice(0, RESULT_MAX), note: `Result cut to ${RESULT_MAX.toLocaleString()} characters.` });
}

/** Runs one call. Like the built-in tools it returns a JSON string and never throws. */
export async function runConnectionTool(tool: ConnectionTool, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const { connection } = tool;
  try {
    const result = await callTool(connection, tool.tool.name, args, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
    return shapeResult(result);
  } catch (e) {
    if (e instanceof McpAuthError) {
      await markNeedsAuth(connection.id, connection.url, e.challenge).catch(() => {});
      return JSON.stringify({ error: `${connection.name} needs the student to sign in again (Settings → Connections).` });
    }
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    const reason = timedOut ? 'no answer within 60 seconds' : await describeFailure(connection.url, e);
    return JSON.stringify({ error: `${connection.name}: ${reason}` });
  }
}
