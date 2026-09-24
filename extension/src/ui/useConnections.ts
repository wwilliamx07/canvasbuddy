import { useEffect, useRef, useState } from 'react';
import { CONNECTION_CATALOG } from '../connections/catalog';
import {
  addConnection,
  setToolEnabled,
  originPattern,
  parseServerUrl,
  refreshConnection,
  removeConnection,
  setAlwaysAllow,
  setConnectionEnabled,
  signInConnection,
} from '../connections/manage';
import { loadConnections, onConnectionsChanged, type ConnectionRecord } from '../connections/store';
import { syncOriginRule } from '../connections/originRule';
import { connectionTools, EAGER_CONNECTION_TOKENS, toolDefinitionTokens, toolLoading, toolTokens } from '../connections/tools';
import type { ConnectionView, ConnectionsModel } from './model';

function toView(c: ConnectionRecord): ConnectionView {
  const disabled = c.disabledTools ?? [];
  const tools = c.tools.map((t) => ({
    name: t.name,
    title: t.title || t.name,
    description: t.description,
    readOnly: t.readOnly,
    alwaysAllowed: c.alwaysAllow.includes(t.name),
    enabled: !disabled.includes(t.name),
    tokens: toolDefinitionTokens(c, t),
  }));
  return {
    id: c.id,
    name: c.name,
    host: new URL(c.url).host,
    enabled: c.enabled,
    status: c.status,
    error: c.error,
    authHost: c.status === 'needs-auth' && c.authIssuer ? new URL(c.authIssuer).host : undefined,
    signedIn: Boolean(c.auth?.accessToken),
    tools,
    toolTokens: tools.reduce((sum, t) => sum + (t.enabled ? t.tokens : 0), 0),
  };
}

/**
 * The Connections section's state, plus the records themselves for `App` (which turns them into
 * tools). Records live in `chrome.storage.local` and are re-read whenever they change, including
 * when a tool call refreshes a token or finds that a server wants a new sign-in. Each action that
 * reaches a new origin asks Chrome for it first, while the click's gesture is still fresh.
 */
export function useConnections(canvasHost: string | undefined): { model: ConnectionsModel; records: ConnectionRecord[] } {
  const [records, setRecords] = useState<ConnectionRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => void loadConnections().then((list) => alive && setRecords(list));
    load();
    const unsubscribe = onConnectionsChanged(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Servers change their tools; re-list each working connection once per panel session, one at a time
  const relisted = useRef(false);
  useEffect(() => {
    if (relisted.current) return;
    relisted.current = true;
    void (async () => {
      const list = await loadConnections();
      await syncOriginRule(list); // dynamic rules persist, but connections stored before the rule existed need it too
      for (const c of list) {
        if (c.enabled && c.status === 'ok') await refreshConnection(c.id);
      }
    })();
  }, []);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const requestOrigins = async (urls: Array<string | undefined>) => {
    const origins = [...new Set(urls.filter((u): u is string => Boolean(u)).map(originPattern))];
    if (!(await chrome.permissions.request({ origins }))) {
      throw new Error('Permission was not granted. CanvasBuddy needs access to the server to use it.');
    }
  };

  const live = connectionTools(records);
  const model: ConnectionsModel = {
    list: records.map(toView),
    catalog: CONNECTION_CATALOG,
    toolLoading: toolLoading(live),
    totalToolTokens: toolTokens(live),
    eagerLimit: EAGER_CONNECTION_TOKENS,
    busy,
    error,
    add: (input, name) =>
      void run('new', async () => {
        const url = parseServerUrl(input, canvasHost);
        await requestOrigins([url]);
        const added = await addConnection(url, name);
        if (added.status === 'error') setError(added.error || 'The server could not be reached.');
      }),
    signIn: (id) =>
      void run(id, async () => {
        const c = records.find((r) => r.id === id);
        if (!c) return;
        await requestOrigins([c.url, c.authIssuer, ...(c.authEndpoints ?? [])]);
        await signInConnection(id);
      }),
    reconnect: (id) =>
      void run(id, async () => {
        const c = records.find((r) => r.id === id);
        if (!c) return;
        await requestOrigins([c.url, c.auth?.tokenEndpoint]); // Chrome may have revoked them; refreshing the token needs its endpoint
        await refreshConnection(id);
      }),
    setEnabled: (id, enabled) => void setConnectionEnabled(id, enabled),
    setAlwaysAllow: (id, tool, allow) => void setAlwaysAllow(id, tool, allow),
    setToolEnabled: (id, tool, enabled) => void setToolEnabled(id, tool, enabled),
    remove: (id) => {
      const c = records.find((r) => r.id === id);
      if (c && !window.confirm(`Remove ${c.name}? Its tools will no longer be available to the assistant.`)) return;
      void run(id, () => removeConnection(id));
    },
  };

  return { model, records };
}
