import type { ConnectionRecord } from './store';

/**
 * MCP servers must validate `Origin` (the spec's DNS-rebinding defence), and some — Notion — reject
 * every browser origin they do not know, including the `chrome-extension://<id>` Chrome puts on
 * each fetch from the panel. `fetch()` cannot change that header, so one declarativeNetRequest rule
 * removes it from this extension's own requests to connection hosts, which is what desktop MCP
 * clients send (no Origin at all). The check guards against a web page driving a local server; it
 * does not apply to an extension calling a remote server with its own token. Page requests are
 * untouched (`initiatorDomains` is this extension only: its URL host, which is the id in Chrome and
 * the per-install UUID of `moz-extension://` in Firefox). The rule is written with string values:
 * Firefox has no `RuleActionType` / `HeaderOperation` enum objects, and reading one would throw.
 */

const RULE_ID = 1;

export async function syncOriginRule(connections: ConnectionRecord[]): Promise<void> {
  const urls = connections.flatMap((c) => [c.url, c.authIssuer, ...(c.authEndpoints ?? []), c.auth?.tokenEndpoint]);
  const hosts = [...new Set(urls.filter((u): u is string => Boolean(u)).map((u) => new URL(u).hostname))];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: hosts.length
        ? [
            {
              id: RULE_ID,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'origin', operation: 'remove' }],
              },
              condition: {
                requestDomains: hosts,
                initiatorDomains: [new URL(chrome.runtime.getURL('')).hostname],
                resourceTypes: ['xmlhttprequest'],
              },
            },
          ]
        : [],
    });
  } catch (e) {
    console.warn('Could not update the Origin rule for connections:', e);
  }
}
