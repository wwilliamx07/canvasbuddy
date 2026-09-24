import { beforeEach, describe, expect, it } from 'vitest';
import { callTool, dropSession, listTools, McpAuthError } from '../../src/connections/mcp';
import { MCP_URL, storeConnection, stubMcp } from '../helpers/mcp';

const TOOLS = [
  { name: 'search', description: 'Search the workspace', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'create-pages', title: 'Create pages', description: 'Create pages', inputSchema: { type: 'object', properties: { pages: { type: 'array' } } } },
  { name: 'no-schema' },
];

beforeEach(() => dropSession('conn-1'));

describe('Streamable HTTP client', () => {
  it('initializes, acknowledges, then lists tools across pages', async () => {
    const server = stubMcp({ tools: TOOLS, pageSize: 2 });
    const connection = await storeConnection();
    const tools = await listTools(connection);

    expect(tools).toEqual([
      { name: 'search', title: undefined, description: 'Search the workspace', inputSchema: TOOLS[0].inputSchema, readOnly: true },
      { name: 'create-pages', title: 'Create pages', description: 'Create pages', inputSchema: TOOLS[1].inputSchema, readOnly: false },
      { name: 'no-schema', title: undefined, description: undefined, inputSchema: { type: 'object', properties: {} }, readOnly: false },
    ]);
    expect(server.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(server.requests[3].params).toEqual({ cursor: '2' });
  });

  it('sends the session id and negotiated protocol version on every later request', async () => {
    const server = stubMcp({ tools: TOOLS });
    await listTools(await storeConnection());
    const [init, ack, list] = server.requests;
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(init.headers.accept).toBe('application/json, text/event-stream');
    for (const r of [ack, list]) {
      expect(r.headers['mcp-session-id']).toBe('session-1');
      expect(r.headers['mcp-protocol-version']).toBe('2025-06-18');
    }
  });

  it('reads replies from SSE streams, skipping unrelated messages', async () => {
    stubMcp({ tools: TOOLS, sse: true, onCall: () => ({ content: [{ type: 'text', text: 'streamed' }] }) });
    const connection = await storeConnection();
    expect(await listTools(connection)).toHaveLength(3);
    expect(await callTool(connection, 'search', { query: 'x' })).toEqual({ content: [{ type: 'text', text: 'streamed' }] });
  });

  it('re-initializes once when the server forgot the session (404)', async () => {
    const server = stubMcp({ tools: TOOLS });
    const connection = await storeConnection();
    await listTools(connection);
    server.expireSessions();
    await callTool(connection, 'search', { query: 'x' });
    expect(server.methods()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
  });

  it('passes tool arguments through with their JSON types', async () => {
    const server = stubMcp({ tools: TOOLS });
    await callTool(await storeConnection(), 'create-pages', { pages: [{ title: 'Notes', count: 2 }], draft: true });
    expect(server.requests.at(-1)!.params).toEqual({ name: 'create-pages', arguments: { pages: [{ title: 'Notes', count: 2 }], draft: true } });
  });

  it('a 401 is an McpAuthError carrying the WWW-Authenticate challenge', async () => {
    stubMcp({ requireToken: 'secret' });
    const error = await listTools(await storeConnection()).catch((e) => e);
    expect(error).toBeInstanceOf(McpAuthError);
    expect(error.challenge).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"');
  });

  it('a signed-in connection sends its bearer token', async () => {
    const server = stubMcp({ requireToken: 'tok' });
    const connection = await storeConnection({
      auth: { resource: MCP_URL, issuer: 'https://auth.test', authorizationEndpoint: 'a', tokenEndpoint: 'https://auth.test/token', clientId: 'c', accessToken: 'tok' },
    });
    await listTools(connection);
    expect(server.requests[0].headers.authorization).toBe('Bearer tok');
  });

  it('explains a URL that is not a Streamable HTTP endpoint', async () => {
    stubMcp({ failWith: 405 });
    await expect(listTools(await storeConnection())).rejects.toThrow(/does not answer MCP requests at this URL \(405\).*\/mcp/);
  });
});
