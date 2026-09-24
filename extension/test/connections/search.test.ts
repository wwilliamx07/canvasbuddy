import { describe, expect, it } from 'vitest';
import { pickToLoad, searchConnectionTools, tokenize } from '../../src/connections/search';
import { connectionTools } from '../../src/connections/tools';
import type { ConnectionRecord, McpToolInfo } from '../../src/connections/store';

/** Shaped after Notion's hosted MCP server: every name prefixed, descriptions in its own words. */
const NOTION: Array<[string, string, string[]]> = [
  ['notion-search', 'Perform a search over your Notion workspace and connected sources such as Slack and Google Drive.', ['query', 'query_type', 'filters']],
  ['notion-fetch', 'Retrieves details about a Notion entity (page or database) by URL or ID.', ['id']],
  ['notion-create-pages', 'Creates one or more Notion pages with the specified properties and content.', ['pages', 'parent']],
  ['notion-update-page', "Update a Notion page's properties or content.", ['data']],
  ['notion-move-pages', 'Move one or more Notion pages or databases to a new parent.', ['page_or_database_ids', 'new_parent']],
  ['notion-duplicate-page', 'Duplicate a Notion page.', ['page_id']],
  ['notion-create-database', 'Creates a new Notion database with the specified properties schema.', ['parent', 'title', 'properties']],
  ['notion-update-database', "Update a Notion database's properties, name, description.", ['database_id', 'title', 'properties']],
  ['notion-create-comment', 'Add a comment to a page.', ['parent', 'rich_text']],
  ['notion-get-comments', 'Get all comments of a page.', ['page_id']],
  ['notion-get-users', 'List all users in the workspace.', ['query']],
  ['notion-get-self', "Retrieve your token's bot user.", []],
];

const tools = (defs: typeof NOTION, over: Partial<ConnectionRecord> = {}) =>
  connectionTools([
    {
      id: 'c1',
      name: 'Notion',
      slug: 'notion',
      url: 'https://mcp.notion.test/mcp',
      enabled: true,
      status: 'ok',
      alwaysAllow: [],
      addedAt: 0,
      tools: defs.map(([name, description, props]): McpToolInfo => ({
        name,
        description,
        inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) },
        readOnly: false,
      })),
      ...over,
    },
  ]);

const notion = tools(NOTION);
const load = (query: string, service?: string, limits = { max: 5, tokenBudget: 6000 }) =>
  pickToLoad(searchConnectionTools(notion, query, service), limits).map((t) => t.tool.name);

describe('tokenize', () => {
  it('splits camelCase, kebab-case and snake_case and drops stopwords', () => {
    expect(tokenize('getUserComments for the page_id in notion-create-pages')).toEqual(['user', 'comment', 'page', 'id', 'notion', 'creat', 'page']);
  });

  it('stems so that create / creating / created / creates meet, and pages / page, entries / entry', () => {
    expect(new Set(tokenize('create creating created creates'))).toEqual(new Set(['creat']));
    expect(tokenize('pages entries updating')).toEqual(['page', 'entry', 'updat']);
    expect(tokenize('class note')).toEqual(['class', 'note']); // -ss kept, short words kept
  });
});

describe('searchConnectionTools on a Notion-like server', () => {
  it.each([
    ['notion-create-pages', ['notion-create-pages']],
    ['notion__notion-create-pages', ['notion-create-pages']],
    ['create-pages', ['notion-create-pages']],
    ['create pages', ['notion-create-pages']],
  ])('an exact name (%s) loads only that tool', (query, expected) => {
    expect(load(query)).toEqual(expected);
  });

  it('a single word never counts as naming a tool by its end', () => {
    const hits = searchConnectionTools(notion, 'comment on the page');
    expect(hits.some((h) => h.exact)).toBe(false);
    expect(load('comment on the page')).toEqual(expect.arrayContaining(['notion-get-comments', 'notion-create-comment']));
  });

  it.each([
    ['add a page to my notes', 'notion-create-pages'],
    ['write my lecture notes into a new page', 'notion-create-pages'],
    ['find my study plan', 'notion-search'],
    ['search notion for CSC263', 'notion-search'],
    ['make a table of assignments', 'notion-create-database'],
    ['edit the page', 'notion-update-page'],
    ['read that page', 'notion-fetch'],
  ])('paraphrase %j reaches %s', (query, expected) => {
    expect(load(query)).toContain(expected);
  });

  it('nothing loads for a query that matches nothing', () => {
    expect(load('xyzzy plugh')).toEqual([]);
  });

  it('respects the per-search cap and the token budget after the first tool', () => {
    expect(load('page', undefined, { max: 2, tokenBudget: 99999 })).toHaveLength(2);
    const first = searchConnectionTools(notion, 'page')[0].tool;
    expect(load('page', undefined, { max: 5, tokenBudget: 1 })).toEqual([first.tool.name]);
  });

  it('keeps only hits within 30 % of the best score', () => {
    const hits = searchConnectionTools(notion, 'duplicate a page');
    const picked = pickToLoad(hits, { max: 5, tokenBudget: 99999 });
    const best = hits[0].score;
    for (const t of picked) expect(hits.find((h) => h.tool === t)!.score).toBeGreaterThanOrEqual(0.3 * best);
    expect(picked[0].tool.name).toBe('notion-duplicate-page');
  });

  it('service narrows the search; an unknown service searches everything', () => {
    const both = [...notion, ...tools([['create-event', 'Create a calendar event.', ['title']]], { id: 'c2', name: 'Calendar', slug: 'calendar' })];
    expect(searchConnectionTools(both, 'create', 'Calendar').map((h) => h.tool.connection.name)).toEqual(['Calendar']);
    expect(searchConnectionTools(both, 'create', 'calendar').length).toBe(1);
    expect(new Set(searchConnectionTools(both, 'create', 'Nope').map((h) => h.tool.connection.name))).toEqual(new Set(['Notion', 'Calendar']));
  });
});
