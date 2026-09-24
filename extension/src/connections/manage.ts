import { dropSession, listTools, McpAuthError } from './mcp';
import { authEndpoints, discoverIssuer, signIn } from './oauth';
import {
  addConnectionRecord,
  getConnection,
  loadConnections,
  removeConnectionRecord,
  slugFor,
  updateConnection,
  type ConnectionRecord,
} from './store';

/**
 * What the Connections section does to a connection. Permission requests are not made here: they
 * must be the first thing a click does, so the caller (`useConnections`) makes them and then
 * calls these.
 */

/** A valid remote server URL, or an error the user can act on. */
export function parseServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter the server\'s full URL, e.g. https://mcp.example.com/mcp');
  }
  if (url.protocol !== 'https:') throw new Error('Only https servers can be connected.');
  url.hash = '';
  return url.toString();
}

/** `https://mcp.notion.com/*`, the pattern Chrome grants for a URL's origin. */
export function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}

/**
 * A fetch that fails outright (no HTTP status) is usually the origin permission: Chrome revoked it,
 * or the request went to an origin that was never granted and the server sends no CORS headers.
 */
export async function describeFailure(url: string, e: unknown): Promise<string> {
  const message = e instanceof Error ? e.message : String(e);
  if (!(e instanceof TypeError)) return message;
  let granted = true;
  try {
    granted = await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    // unknown; fall through to the network explanation
  }
  const host = new URL(url).host;
  return granted
    ? `Could not reach ${host} (${message}). Check the URL and your network.`
    : `CanvasBuddy no longer has access to ${host}. Click Reconnect to grant it again.`;
}

export async function addConnection(url: string, name: string): Promise<ConnectionRecord> {
  const existing = await loadConnections();
  if (existing.some((c) => c.url === url)) throw new Error('This server is already connected.');
  const displayName = name.trim() || new URL(url).hostname.replace(/^(mcp|api|www)\./, '');
  const record: ConnectionRecord = {
    id: `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: displayName,
    slug: slugFor(displayName, existing.map((c) => c.slug)),
    url,
    enabled: true,
    status: 'error',
    tools: [],
    alwaysAllow: [],
    addedAt: Date.now(),
  };
  await addConnectionRecord(record);
  return (await refreshConnection(record.id)) ?? record;
}

/** A server asked for sign-in: remember which authorization server and endpoints, so the Sign in click can ask for their origins. */
export async function markNeedsAuth(id: string, url: string, challenge: string | null): Promise<void> {
  const { issuer, scope } = await discoverIssuer(url, challenge);
  const endpoints = await authEndpoints(issuer);
  await updateConnection(id, { status: 'needs-auth', authIssuer: issuer, authScope: scope, authEndpoints: endpoints, error: undefined });
}

/** Opens a session and re-lists the server's tools; records the outcome on the connection. */
export async function refreshConnection(id: string): Promise<ConnectionRecord | null> {
  const connection = await getConnection(id);
  if (!connection) return null;
  dropSession(id);
  try {
    const tools = await listTools(connection);
    return updateConnection(id, { status: 'ok', error: undefined, tools, toolsFetchedAt: Date.now() });
  } catch (e) {
    if (e instanceof McpAuthError) {
      await markNeedsAuth(id, connection.url, e.challenge);
      return getConnection(id);
    }
    return updateConnection(id, { status: 'error', error: await describeFailure(connection.url, e) });
  }
}

export async function signInConnection(id: string): Promise<void> {
  const connection = await getConnection(id);
  if (!connection) return;
  const auth = await signIn(connection);
  await updateConnection(id, { auth, authIssuer: auth.issuer });
  await refreshConnection(id);
}

export async function removeConnection(id: string): Promise<void> {
  dropSession(id);
  await removeConnectionRecord(id);
}

export async function setConnectionEnabled(id: string, enabled: boolean): Promise<void> {
  await updateConnection(id, { enabled });
}

export async function setToolEnabled(id: string, toolName: string, enabled: boolean): Promise<void> {
  const connection = await getConnection(id);
  if (!connection) return;
  const rest = (connection.disabledTools ?? []).filter((t) => t !== toolName);
  await updateConnection(id, { disabledTools: enabled ? rest : [...rest, toolName] });
}

export async function setAlwaysAllow(id: string, toolName: string, allow: boolean): Promise<void> {
  const connection = await getConnection(id);
  if (!connection) return;
  const rest = connection.alwaysAllow.filter((t) => t !== toolName);
  await updateConnection(id, { alwaysAllow: allow ? [...rest, toolName] : rest });
}
