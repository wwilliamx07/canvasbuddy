import { syncOriginRule } from './originRule';

/**
 * Connections: remote MCP servers the user added, persisted in `chrome.storage.local` (tokens do
 * not belong in `localStorage`). They belong to the browser profile, not to a Canvas account, so
 * switching or deleting a Canvas account leaves them alone.
 */

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema of the arguments, as the server declared it. */
  inputSchema: Record<string, unknown>;
  /** The server marks the tool as not changing anything (`annotations.readOnlyHint`). */
  readOnly: boolean;
}

export interface OAuthState {
  /** The MCP server URL, sent as the RFC 8707 `resource` so tokens are bound to it. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokenAuthMethod?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number;
}

export type ConnectionStatus = 'ok' | 'needs-auth' | 'error';

export interface ConnectionRecord {
  id: string;
  name: string;
  /** Prefix of this connection's tool names (`notion__search`); unique among connections. */
  slug: string;
  url: string;
  enabled: boolean;
  status: ConnectionStatus;
  error?: string;
  /** Authorization server that asked for sign-in; set while `status` is `needs-auth`. */
  authIssuer?: string;
  /** Scope the server asked for in its challenge, if any. */
  authScope?: string;
  /** That server's token and registration endpoints, whose origins the Sign in click asks for too. */
  authEndpoints?: string[];
  auth?: OAuthState;
  tools: McpToolInfo[];
  toolsFetchedAt?: number;
  /** Tools the user allowed to run without asking each time. */
  alwaysAllow: string[];
  /** Tools the user switched off: never searched, loaded or declared. Absent on records from before the switch existed. */
  disabledTools?: string[];
  addedAt: number;
}

const KEY = 'canvas-buddy-connections';

export async function loadConnections(): Promise<ConnectionRecord[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const list = stored[KEY];
    return Array.isArray(list) ? (list as ConnectionRecord[]) : [];
  } catch (e) {
    console.error('Failed to load connections:', e);
    return [];
  }
}

async function saveConnections(list: ConnectionRecord[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list });
  // Before anything talks to a new host (the server, then its authorization server)
  await syncOriginRule(list);
}

export async function getConnection(id: string): Promise<ConnectionRecord | null> {
  return (await loadConnections()).find((c) => c.id === id) ?? null;
}

// Writers read-modify-write the whole list; serialize them so a token refresh during a tool call
// and a click in Settings cannot drop each other's change.
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work);
  writes = next.catch(() => {});
  return next;
}

export function addConnectionRecord(record: ConnectionRecord): Promise<void> {
  return serialized(async () => saveConnections([...(await loadConnections()), record]));
}

export function updateConnection(id: string, patch: Partial<ConnectionRecord>): Promise<ConnectionRecord | null> {
  return serialized(async () => {
    const list = await loadConnections();
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) return null;
    list[index] = { ...list[index], ...patch };
    await saveConnections(list);
    return list[index];
  });
}

export function removeConnectionRecord(id: string): Promise<void> {
  return serialized(async () => saveConnections((await loadConnections()).filter((c) => c.id !== id)));
}

export function onConnectionsChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && KEY in changes) listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** `notion`, `my_server_2`: letters, digits and underscores, so `<slug>__<tool>` is a valid function name for both providers. */
export function slugFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'server';
  let slug = base;
  for (let i = 2; taken.includes(slug); i++) slug = `${base}_${i}`;
  return slug;
}
