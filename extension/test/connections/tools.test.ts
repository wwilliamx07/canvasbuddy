import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyLoad,
  connectionTools,
  EAGER_CONNECTION_TOKENS,
  findToolConfig,
  resolveLoaded,
  runConnectionTool,
  runFindConnectionTools,
  runsWithoutAsking,
  toolLoading,
  toolTokens,
  unknownToolResult,
  type ConnectionTool,
  type LoadedTool,
} from '../../src/connections/tools';
import { dropSession } from '../../src/connections/mcp';
import { addConnection, parseServerUrl, refreshConnection, setToolEnabled } from '../../src/connections/manage';
import { getConnection, slugFor, type ConnectionRecord, type McpToolInfo } from '../../src/connections/store';
import { chromeState } from '../setup';
import { MCP_URL, storeConnection, stubMcp } from '../helpers/mcp';

const tool = (name: string, over: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name,
  description: `Does ${name}.`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  readOnly: false,
  ...over,
});

const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'conn-1',
  name: 'Notion',
  slug: 'notion',
  url: MCP_URL,
  enabled: true,
  status: 'ok',
  tools: [tool('search', { readOnly: true }), tool('create-pages')],
  alwaysAllow: [],
  addedAt: 0,
  ...over,
});

beforeEach(() => dropSession('conn-1'));

describe('connectionTools', () => {
  it('names tools <slug>__<tool>, prefixes descriptions and forces an object schema', () => {
    const [search, create] = connectionTools([
      record({
        tools: [
          tool('search', { inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', properties: { q: { type: 'string' } } } }),
          tool('create pages!', { title: 'Create pages', inputSchema: {} }),
        ],
      }),
    ]);
    expect(search).toMatchObject({ name: 'notion__search', label: 'Notion: Search', description: '[Notion] Does search.', parameters: { type: 'object', properties: { q: { type: 'string' } } } });
    expect(search.parameters).not.toHaveProperty('$schema');
    expect(create).toMatchObject({ name: 'notion__create_pages_', label: 'Notion: Create pages', parameters: { type: 'object', properties: {} } });
    expect(search.tokens).toBeGreaterThan(0);
  });

  it('keeps names within 64 characters and unique', () => {
    const long = 'x'.repeat(80);
    const tools = connectionTools([record({ tools: [tool(long), tool(`${long}y`)] })]);
    expect(tools.every((t) => t.name.length <= 64)).toBe(true);
    expect(new Set(tools.map((t) => t.name)).size).toBe(2);
  });

  it('skips switched-off tools, disabled connections and connections that are not working', () => {
    expect(connectionTools([record({ disabledTools: ['create-pages'] })]).map((t) => t.tool.name)).toEqual(['search']);
    expect(connectionTools([record({ enabled: false })])).toEqual([]);
    expect(connectionTools([record({ status: 'needs-auth' })])).toEqual([]);
  });

  it('runs without asking only when read-only or always allowed', () => {
    const [search, create] = connectionTools([record()]);
    expect(runsWithoutAsking(search)).toBe(true);
    expect(runsWithoutAsking(create)).toBe(false);
    const [, allowed] = connectionTools([record({ alwaysAllow: ['create-pages'] })]);
    expect(runsWithoutAsking(allowed)).toBe(true);
  });

  it('slugs are unique among connections', () => {
    expect(slugFor('Notion', [])).toBe('notion');
    expect(slugFor('Notion', ['notion'])).toBe('notion_2');
    expect(slugFor('My Server!!', [])).toBe('my_server');
  });
});

describe('runConnectionTool', () => {
  const run = async (result: unknown) => {
    stubMcp({ tools: [{ name: 'search' }], onCall: () => result });
    const connection = await storeConnection();
    const [t] = connectionTools([{ ...connection, tools: [tool('search')] }]);
    return JSON.parse(await runConnectionTool(t, { query: 'x' }, new AbortController().signal));
  };

  it('joins text content; notes other content types', async () => {
    expect(await run({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: '…' }, { type: 'resource_link', uri: 'https://n.test/p', name: 'Page' }] })).toEqual({
      result: 'one\n\n[image content omitted]\n\n<https://n.test/p> Page',
    });
  });

  it('uses structuredContent only without text', async () => {
    expect(await run({ content: [], structuredContent: { pages: 3 } })).toEqual({ result: '{"pages":3}' });
  });

  it('isError becomes { error }', async () => {
    expect(await run({ isError: true, content: [{ type: 'text', text: 'page not found' }] })).toEqual({ error: 'page not found' });
  });

  it('cuts very long results with a note', async () => {
    const out = await run({ content: [{ type: 'text', text: 'z'.repeat(20000) }] });
    expect(out.result).toHaveLength(12000);
    expect(out.note).toMatch(/cut to 12,000/);
  });

  it('a 401 marks the connection as needing sign-in and tells the model, without throwing', async () => {
    stubMcp({ requireToken: 'secret' });
    const connection = await storeConnection();
    const [t] = connectionTools([{ ...connection, tools: [tool('search')] }]);
    const out = JSON.parse(await runConnectionTool(t, {}, new AbortController().signal));
    expect(out.error).toMatch(/needs the student to sign in again/);
    expect(await getConnection('conn-1')).toMatchObject({ status: 'needs-auth', authIssuer: 'https://auth.test', authScope: 'read write' });
  });
});

describe('managing connections', () => {
  it('parseServerUrl accepts https only and drops the fragment', () => {
    expect(parseServerUrl(' https://mcp.notion.com/mcp#x ')).toBe('https://mcp.notion.com/mcp');
    expect(() => parseServerUrl('http://mcp.test/mcp')).toThrow(/Only https/);
    expect(() => parseServerUrl('not a url')).toThrow(/full URL/);
  });

  it('adding lists the tools and covers the host with the Origin rule', async () => {
    stubMcp({ tools: [{ name: 'search', annotations: { readOnlyHint: true } }] });
    const added = await addConnection(MCP_URL, '');
    expect(added).toMatchObject({ name: 'test', slug: 'test', status: 'ok' });
    expect(added.tools.map((t) => t.name)).toEqual(['search']);
    const [rule] = chromeState.dynamicRules;
    expect(rule.condition).toMatchObject({ requestDomains: ['mcp.test'], initiatorDomains: ['test-extension-uuid'] });
    expect(rule.action).toMatchObject({ type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] });
    await expect(addConnection(MCP_URL, 'Again')).rejects.toThrow(/already connected/);
  });

  it('a server that wants sign-in is recorded with its authorization server, which the Origin rule then covers', async () => {
    stubMcp({ requireToken: 'secret' });
    const added = await addConnection(MCP_URL, 'Notion');
    expect(added).toMatchObject({ status: 'needs-auth', authIssuer: 'https://auth.test' });
    expect(chromeState.dynamicRules[0].condition.requestDomains).toEqual(['mcp.test', 'auth.test']);
  });

  it('records token and registration endpoints on another origin, so Sign in can ask for it', async () => {
    stubMcp({ requireToken: 'secret', endpointOrigin: 'https://login.test' });
    const added = await addConnection(MCP_URL, 'Composio');
    expect(added.authEndpoints).toEqual(['https://login.test/token', 'https://login.test/register']);
    expect(chromeState.dynamicRules[0].condition.requestDomains).toEqual(['mcp.test', 'auth.test', 'login.test']);
  });

  it('switching a tool off and on', async () => {
    stubMcp({ tools: [{ name: 'search' }] });
    const added = await addConnection(MCP_URL, 'Notion');
    await setToolEnabled(added.id, 'search', false);
    expect((await getConnection(added.id))?.disabledTools).toEqual(['search']);
    await setToolEnabled(added.id, 'search', true);
    expect((await getConnection(added.id))?.disabledTools).toEqual([]);
  });

  it('refreshConnection records a failure the user can act on', async () => {
    stubMcp({ failWith: 404 });
    await storeConnection({ id: 'conn-9' });
    expect(await refreshConnection('conn-9')).toMatchObject({ status: 'error', error: expect.stringMatching(/does not answer MCP requests/) });
  });
});

describe('lazy loading', () => {
  // Descriptions are clipped to 1,500 chars, so each tool is ~400 tokens
  const big = (name: string, readOnly = false) => tool(name, { readOnly, description: `${name} ${'d'.repeat(3400)}` });
  const live = connectionTools([record({ tools: ['search', 'fetch', 'create-pages', 'update-page', 'move-pages', 'create-comment', 'get-comments', 'get-users'].map((n) => big(n, n.startsWith('get') || n === 'search' || n === 'fetch')) })]);
  const limits = { max: 8, tokenBudget: 6000 };
  const names = (tools: ConnectionTool[]) => tools.map((t) => t.tool.name);
  const loadedNames = (loaded: LoadedTool[]) => loaded.map((l) => l.tool);

  it('switches from sending everything to loading on demand past the eager limit', () => {
    const small = connectionTools([record()]);
    expect(toolTokens(small)).toBeLessThanOrEqual(EAGER_CONNECTION_TOKENS);
    expect(toolLoading(small)).toBe('eager');
    expect(toolLoading(live)).toBe('lazy');
    expect(toolLoading([])).toBe('none');
  });

  it('the find tool lists every tool name per service, capped', () => {
    const config = findToolConfig(live);
    expect(config.name).toBe('find_connection_tools');
    expect(config.description).toContain('Notion: search, fetch, create-pages, update-page, move-pages, create-comment, get-comments, get-users');
    expect(config.parameters.properties.service.enum).toEqual(['Notion']);
    const many = connectionTools([record({ tools: Array.from({ length: 70 }, (_, i) => tool(`t${i}`)) })]);
    expect(findToolConfig(many).description).toContain('…and 10 more; search by what you need');
  });

  it('a search loads the named tool and reports it', () => {
    const out = runFindConnectionTools(live, [], { query: 'create-pages' }, limits);
    expect(names(out.load)).toEqual(['create-pages']);
    expect(JSON.parse(out.result)).toEqual({
      loaded: [{ name: 'notion__create-pages', summary: expect.stringMatching(/^create-pages d+…$/), changes_something: true }],
      note: 'Loaded tools can be called from your next step.',
    });
  });

  it('a hit already loaded is reported as such and not loaded again', () => {
    const loaded = applyLoad([], [live[2]], live, limits, 1);
    const out = JSON.parse(runFindConnectionTools(live, loaded, { query: 'create-pages' }, limits).result);
    expect(out).toMatchObject({ loaded: [], already_loaded: ['notion__create-pages'] });
  });

  it('a miss loads nothing and returns an index to search again from', () => {
    const out = runFindConnectionTools(live, [], { query: 'xyzzy' }, limits);
    expect(out.load).toEqual([]);
    const parsed = JSON.parse(out.result);
    expect(parsed.index.map((i: any) => i.name)).toEqual(names(live));
    expect(parsed.note).toMatch(/Search again with an exact name/);
    expect(JSON.parse(runFindConnectionTools(live, [], { query: '' }, limits).result).error).toMatch(/Pass query/);
  });

  it('an unknown function lists the callable names, scoped to the service its prefix names', () => {
    const both = connectionTools([
      record(),
      record({ id: 'conn-2', name: 'Composio', slug: 'composio', tools: [tool('COMPOSIO_SEARCH_TOOLS'), tool('COMPOSIO_MULTI_EXECUTE_TOOL')] }),
    ]);
    // An action name from inside a result, called as `<app>__<action>`: every service is listed
    const guessed = JSON.parse(unknownToolResult('googlecalendar__GOOGLECALENDAR_CREATE_EVENT', both));
    expect(guessed.error).toMatch(/^No tool is named googlecalendar__GOOGLECALENDAR_CREATE_EVENT\./);
    expect(guessed.tools).toEqual({
      Notion: ['notion__search', 'notion__create-pages'],
      Composio: ['composio__COMPOSIO_SEARCH_TOOLS', 'composio__COMPOSIO_MULTI_EXECUTE_TOOL'],
    });
    expect(guessed.note).toMatch(/inside a tool's result .* is not a function you can call/);
    // A real service's prefix narrows the list to it
    expect(JSON.parse(unknownToolResult('composio__GOOGLECALENDAR_CREATE_EVENT', both)).tools).toEqual({
      Composio: ['composio__COMPOSIO_SEARCH_TOOLS', 'composio__COMPOSIO_MULTI_EXECUTE_TOOL'],
    });
    expect(unknownToolResult('nope', [])).toBe('{"error":"Tool not found: nope"}');
  });

  it('applyLoad appends in load order and marks re-used tools', () => {
    let loaded = applyLoad([], [live[0], live[1]], live, limits, 1);
    loaded = applyLoad(loaded, [live[2]], live, limits, 2);
    loaded = applyLoad(loaded, [live[0]], live, limits, 3);
    expect(loadedNames(loaded)).toEqual(['search', 'fetch', 'create-pages']);
    expect(loaded[0].lastUsed).toBe(3);
  });

  it('evicts the least recently used past the count or the token budget, never the tools just loaded', () => {
    let loaded = applyLoad([], [live[0]], live, limits, 1);
    loaded = applyLoad(loaded, [live[1]], live, limits, 2);
    loaded = applyLoad(loaded, [live[0]], live, limits, 3); // search used again
    loaded = applyLoad(loaded, [live[2]], live, { max: 2, tokenBudget: 99999 }, 4);
    expect(loadedNames(loaded)).toEqual(['search', 'create-pages']);

    const tight = { max: 8, tokenBudget: live[0].tokens * 3 };
    const budgeted = applyLoad([], live.slice(0, 5), live, tight, 5);
    expect(budgeted).toHaveLength(5); // the current load is kept whole, even over budget
    const next = applyLoad(budgeted, [live[7]], live, tight, 6);
    expect(toolTokens(resolveLoaded(live, next))).toBeLessThanOrEqual(tight.tokenBudget);
    expect(loadedNames(next)).toContain('get-users');
  });

  it('resolveLoaded skips entries whose tool is switched off, and they come back', () => {
    const loaded = applyLoad([], [live[0], live[2]], live, limits, 1);
    const withoutCreate = connectionTools([record({ tools: live.map((t) => t.tool), disabledTools: ['create-pages'] })]);
    expect(names(resolveLoaded(withoutCreate, loaded))).toEqual(['search']);
    expect(names(resolveLoaded(live, loaded))).toEqual(['search', 'create-pages']);
  });
});
