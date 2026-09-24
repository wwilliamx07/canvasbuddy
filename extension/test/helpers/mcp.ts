import { vi } from 'vitest';
import { addConnectionRecord, type ConnectionRecord } from '../../src/connections/store';

/**
 * A fake remote MCP server (Streamable HTTP) and a fake OAuth authorization server behind a
 * stubbed `fetch`. The server speaks enough JSON-RPC for the client: initialize, the initialized
 * notification, paginated tools/list and tools/call, with sessions, optional SSE replies and an
 * optional bearer-token requirement. Every request is recorded.
 */

export const MCP_URL = 'https://mcp.test/mcp';
export const AUTH_ORIGIN = 'https://auth.test';

export interface FakeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpRequest {
  method: string;
  id?: number;
  params?: any;
  headers: Record<string, string>;
}

export interface FakeMcp {
  requests: McpRequest[];
  /** Methods in order, e.g. ['initialize', 'notifications/initialized', 'tools/list']. */
  methods(): string[];
  /** Forget every session, so the next request carrying one gets 404. */
  expireSessions(): void;
  /** Token the server accepts now (rotate to simulate revocation). */
  token: string | null;
  tokenRequests: URLSearchParams[];
  registrations: any[];
}

export interface FakeMcpOptions {
  tools?: FakeTool[];
  pageSize?: number;
  /** Answer requests as SSE streams, each preceded by an unrelated notification. */
  sse?: boolean;
  /** Require `Authorization: Bearer <token>`; without it answer 401 with this challenge. */
  requireToken?: string;
  /** Publish protected-resource metadata (RFC 9728) naming AUTH_ORIGIN; default true. */
  resourceMetadata?: boolean;
  /** The authorization server allows dynamic registration; default true. */
  registration?: boolean;
  /** Origin of the token and registration endpoints (Composio keeps them off the issuer's); default AUTH_ORIGIN. */
  endpointOrigin?: string;
  onCall?: (name: string, args: any) => any;
  /** Status for every POST to the MCP URL instead of an answer (e.g. 405 for an old SSE-only server). */
  failWith?: number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function sse(messages: unknown[]): Response {
  const text = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function stubMcp(opts: FakeMcpOptions = {}): FakeMcp {
  const tools = opts.tools ?? [];
  const pageSize = opts.pageSize ?? 100;
  const endpointOrigin = opts.endpointOrigin ?? AUTH_ORIGIN;
  const sessions = new Set<string>();
  let nextSession = 1;
  const state: FakeMcp = {
    requests: [],
    methods: () => state.requests.map((r) => r.method),
    expireSessions: () => sessions.clear(),
    token: opts.requireToken ?? null,
    tokenRequests: [],
    registrations: [],
  };
  const challenge = `Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="read write"`;

  const handleMcp = async (init?: RequestInit): Promise<Response> => {
    // Lower-cased by hand: happy-dom's Headers keeps the case the client used
    const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const message = JSON.parse(String(init?.body));
    state.requests.push({ method: message.method, id: message.id, params: message.params, headers });
    if (opts.failWith) return new Response('nope', { status: opts.failWith });
    if (state.token && headers.authorization !== `Bearer ${state.token}`) {
      return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': challenge } });
    }

    if (message.method === 'initialize') {
      const id = `session-${nextSession++}`;
      sessions.add(id);
      return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }, 200, {
        'mcp-session-id': id,
      });
    }
    const session = headers['mcp-session-id'];
    if (!session || !sessions.has(session)) return new Response('session not found', { status: 404 });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });

    let result: unknown;
    if (message.method === 'tools/list') {
      const start = Number(message.params?.cursor ?? 0);
      const page = tools.slice(start, start + pageSize);
      result = { tools: page, ...(start + pageSize < tools.length ? { nextCursor: String(start + pageSize) } : {}) };
    } else if (message.method === 'tools/call') {
      result = opts.onCall?.(message.params.name, message.params.arguments) ?? { content: [{ type: 'text', text: 'ok' }] };
    } else {
      return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
    const reply = { jsonrpc: '2.0', id: message.id, result };
    return opts.sse ? sse([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, reply]) : json(reply);
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.href === MCP_URL && init?.method === 'POST') return handleMcp(init);
      if (url.href === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
        return opts.resourceMetadata === false ? new Response('no', { status: 404 }) : json({ resource: MCP_URL, authorization_servers: [AUTH_ORIGIN], scopes_supported: ['everything'] });
      }
      if (url.href === `${AUTH_ORIGIN}/.well-known/oauth-authorization-server`) {
        return json({
          issuer: AUTH_ORIGIN,
          authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
          token_endpoint: `${endpointOrigin}/token`,
          ...(opts.registration === false ? {} : { registration_endpoint: `${endpointOrigin}/register` }),
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.href === `${endpointOrigin}/register`) {
        const body = JSON.parse(String(init?.body));
        state.registrations.push(body);
        return json({ client_id: 'client-123', token_endpoint_auth_method: 'none' }, 201);
      }
      if (url.href === `${endpointOrigin}/token`) {
        const body = new URLSearchParams(String(init?.body));
        state.tokenRequests.push(body);
        if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'revoked') return json({ error: 'invalid_grant' }, 400);
        const n = state.tokenRequests.length;
        state.token = `access-${n}`;
        return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer' });
      }
      return new Response('not found', { status: 404 });
    })
  );
  return state;
}

/** Stores a connection the way `addConnection` would, without contacting the server. */
export async function storeConnection(over: Partial<ConnectionRecord> = {}): Promise<ConnectionRecord> {
  const record: ConnectionRecord = {
    id: 'conn-1',
    name: 'Notion',
    slug: 'notion',
    url: MCP_URL,
    enabled: true,
    status: 'ok',
    tools: [],
    alwaysAllow: [],
    addedAt: 0,
    ...over,
  };
  await addConnectionRecord(record);
  return record;
}
