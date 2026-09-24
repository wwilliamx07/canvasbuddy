/**
 * Suggested connections in Settings. A server with a fixed URL connects in one click (Composio's
 * shared server included: its sign-in picks the account); aggregators that hand each user their own
 * URL (Zapier) say where to get it. Anything else is added by URL. Keep this list short and to
 * servers that implement Streamable HTTP and MCP authorization.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Fixed server URL; absent when each user has their own. */
  url?: string;
  /** How to get a personal URL, shown when `url` is absent. */
  setup?: string;
  setupUrl?: string;
}

export const CONNECTION_CATALOG: CatalogEntry[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and write your Notion pages and databases.',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Google Calendar, Gmail, Todoist and thousands more, through your Zapier account.',
    setup: 'Create an MCP server in Zapier, pick the actions to allow, then paste its URL below.',
    setupUrl: 'https://mcp.zapier.com',
  },
  {
    id: 'composio',
    name: 'Composio',
    description: 'Google Calendar, Gmail, Slack and hundreds more, through your Composio account.',
    // Composio Connect, one server for every account. The per-server dashboard URLs are for app
    // builders and want an `x-api-key` header, which a connection cannot send.
    url: 'https://connect.composio.dev/mcp',
  },
];
