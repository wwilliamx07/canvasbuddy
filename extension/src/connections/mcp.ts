import { readSSE, parseSSEJson } from '../utils/sse';
import { accessTokenFor } from './oauth';
import { getConnection, type ConnectionRecord, type McpToolInfo } from './store';

/**
 * A Model Context Protocol client over Streamable HTTP: JSON-RPC requests POSTed to the server's
 * one URL, answered with JSON or with an SSE stream that carries the reply. Only what the agent
 * needs: `initialize`, `tools/list`, `tools/call`. The client declares no capabilities, so servers
 * do not send it sampling or elicitation requests; anything on the stream that is not the awaited
 * reply is ignored. Sessions (`Mcp-Session-Id`) live for the page and are re-created when the
 * server forgets them (404).
 */

const PROTOCOL_VERSION = '2025-06-18';

export class McpAuthError extends Error {
  /** The server's `WWW-Authenticate` header, which names its authorization metadata. */
  readonly challenge: string | null;
  constructor(message: string, challenge: string | null) {
    super(message);
    this.challenge = challenge;
  }
}

interface Session {
  id?: string;
  protocolVersion: string;
}

const sessions = new Map<string, Promise<Session>>();
let nextRequestId = 1;

export function dropSession(connectionId: string) {
  sessions.delete(connectionId);
}

async function post(connection: ConnectionRecord, message: unknown, session: Session | null, signal?: AbortSignal): Promise<Response> {
  // The stored record, not the caller's copy: a refresh elsewhere may have rotated the tokens
  const current = (await getConnection(connection.id)) ?? connection;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session?.id) headers['Mcp-Session-Id'] = session.id;
  if (session) headers['MCP-Protocol-Version'] = session.protocolVersion;
  if (current.auth) {
    const token = await accessTokenFor(current);
    if (!token) throw new McpAuthError(`${current.name} needs you to sign in again.`, null);
    headers.Authorization = `Bearer ${token}`;
  }

  const send = () => fetch(current.url, { method: 'POST', headers, body: JSON.stringify(message), signal });
  let response = await send();
  if (response.status === 401 && current.auth?.refreshToken) {
    // Revoked or expired ahead of its stated lifetime: one forced refresh, then give up
    const token = await accessTokenFor(current, true);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      response = await send();
    }
  }
  if (response.status === 401) {
    throw new McpAuthError(`${current.name} needs you to sign in.`, response.headers.get('WWW-Authenticate'));
  }
  return response;
}

async function httpError(connection: ConnectionRecord, response: Response): Promise<Error> {
  if (response.status === 404 || response.status === 405) {
    return new Error(
      `${connection.name} does not answer MCP requests at this URL (${response.status}). CanvasBuddy supports servers using Streamable HTTP; their URL usually ends in /mcp.`
    );
  }
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // no body
  }
  return new Error(`${connection.name} answered ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
}

/** The JSON-RPC reply to request `id`, from a JSON body or from the SSE stream the server opened for it. */
async function readReply(response: Response, id: number): Promise<any> {
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    for await (const data of readSSE(response)) {
      const message = parseSSEJson(data);
      if (message?.id === id && ('result' in message || 'error' in message)) return message;
    }
    throw new Error('The server closed the stream without answering.');
  }
  const body = await response.json().catch(() => null);
  const message = Array.isArray(body) ? body.find((m) => m?.id === id) : body;
  if (!message || typeof message !== 'object') throw new Error('The server answered with something other than JSON-RPC.');
  return message;
}

async function initialize(connection: ConnectionRecord, signal?: AbortSignal): Promise<Session> {
  const id = nextRequestId++;
  const response = await post(
    connection,
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'CanvasBuddy', version: chrome.runtime.getManifest().version } },
    },
    null,
    signal
  );
  if (!response.ok) throw await httpError(connection, response);
  const sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;
  const reply = await readReply(response, id);
  if (reply.error) throw new Error(`${connection.name} refused to start a session: ${reply.error.message || reply.error.code}`);
  const session: Session = { id: sessionId, protocolVersion: reply.result?.protocolVersion || PROTOCOL_VERSION };
  // The protocol requires this before any other request; the 202 that answers it carries nothing
  try {
    const ack = await post(connection, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, signal);
    await ack.body?.cancel();
  } catch (e) {
    if (e instanceof McpAuthError) throw e;
  }
  return session;
}

function sessionFor(connection: ConnectionRecord, signal?: AbortSignal): Promise<Session> {
  let session = sessions.get(connection.id);
  if (!session) {
    session = initialize(connection, signal);
    sessions.set(connection.id, session);
    session.catch(() => sessions.delete(connection.id));
  }
  return session;
}

async function request(connection: ConnectionRecord, method: string, params: unknown, signal?: AbortSignal): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const session = await sessionFor(connection, signal);
    const id = nextRequestId++;
    const response = await post(connection, { jsonrpc: '2.0', id, method, params }, session, signal);
    if (response.status === 404 && session.id && attempt === 0) {
      dropSession(connection.id); // the server ended the session; start a new one once
      continue;
    }
    if (!response.ok) throw await httpError(connection, response);
    const reply = await readReply(response, id);
    if (reply.error) throw new Error(reply.error.message || `error ${reply.error.code}`);
    return reply.result;
  }
}

export async function listTools(connection: ConnectionRecord, signal?: AbortSignal): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await request(connection, 'tools/list', cursor ? { cursor } : {}, signal);
    for (const t of result?.tools ?? []) {
      if (!t?.name) continue;
      tools.push({
        name: String(t.name),
        title: t.title ?? t.annotations?.title,
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        readOnly: t.annotations?.readOnlyHint === true,
      });
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** An MCP `CallToolResult`, as far as the client reads it. */
export interface CallToolResult {
  content?: Array<{ type?: string; text?: string; resource?: { text?: string }; uri?: string; name?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export function callTool(connection: ConnectionRecord, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  return request(connection, 'tools/call', { name, arguments: args }, signal);
}
