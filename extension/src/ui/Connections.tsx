import { useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { CatalogEntry, ConnectionView, ConnectionsModel } from './model';
import { formatTokens } from './format';
import { Pill, SectionHeading, Spinner, UnderlineInput } from './primitives';

function ToolRow({ connection, tool, model }: { connection: ConnectionView; tool: ConnectionView['tools'][number]; model: ConnectionsModel }) {
  return (
    <li className={`flex items-start justify-between gap-2 ${tool.enabled ? '' : 'opacity-50'}`}>
      <input
        type="checkbox"
        aria-label={`Let the assistant use ${tool.title}`}
        title="Let the assistant use this tool"
        checked={tool.enabled}
        onChange={(e) => model.setToolEnabled(connection.id, tool.name, e.target.checked)}
        className="mt-0.5 h-3 w-3 shrink-0 accent-(--accent)"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-(--ink-soft)">
          {tool.title} <span className="text-[10.5px] text-(--ink-mute)">{formatTokens(tool.tokens)}</span>
        </div>
        {tool.description && <div className="line-clamp-2 text-[11px] text-(--ink-mute)">{tool.description}</div>}
      </div>
      <div className="shrink-0 pt-0.5 text-[10.5px]">
        {tool.readOnly ? (
          <span className="text-(--ink-mute)">reads only</span>
        ) : tool.alwaysAllowed ? (
          <button
            type="button"
            title="Ask again before it runs"
            onClick={() => model.setAlwaysAllow(connection.id, tool.name, false)}
            className="text-(--accent) hover:underline"
          >
            always allowed ×
          </button>
        ) : (
          <span className="text-(--warn)">asks first</span>
        )}
      </div>
    </li>
  );
}

function ConnectionRow({ connection: c, model }: { connection: ConnectionView; model: ConnectionsModel }) {
  const [open, setOpen] = useState(false);
  const busy = model.busy === c.id;
  const pill =
    c.status === 'ok' ? (
      <Pill tone={c.enabled ? 'ok' : 'muted'} label={c.enabled ? `${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}` : 'off'} />
    ) : c.status === 'needs-auth' ? (
      <Pill tone="warn" label="sign-in needed" />
    ) : (
      <Pill tone="error" label="not working" />
    );

  return (
    <li className="rounded-(--radius) border border-(--line) px-3 py-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5 text-[13px] text-(--ink)">
            <ChevronRight size={13} className={`shrink-0 text-(--ink-mute) transition-transform ${open ? 'rotate-90' : ''}`} />
            <span className="truncate">{c.name}</span>
            {pill}
          </div>
          <div className="truncate pl-[19px] text-[11px] text-(--ink-mute)">
            {c.host}
            {c.status === 'ok' && c.toolTokens > 0 ? ` · ${formatTokens(c.toolTokens)} of tools` : ''}
          </div>
        </button>
        {busy && (
          <span className="text-(--ink-mute)">
            <Spinner size={12} />
          </span>
        )}
        <input
          type="checkbox"
          aria-label={`Let the assistant use ${c.name}`}
          title="Let the assistant use it"
          checked={c.enabled}
          onChange={(e) => model.setEnabled(c.id, e.target.checked)}
          className="h-3.5 w-3.5 shrink-0 accent-(--accent)"
        />
      </div>

      {c.status === 'needs-auth' && (
        <div className="mt-2 pl-[19px]">
          <button
            type="button"
            disabled={busy}
            onClick={() => model.signIn(c.id)}
            className="rounded-full bg-(--accent) px-3 py-1 text-[12px] text-(--accent-ink) disabled:opacity-50"
          >
            Sign in{c.authHost ? ` with ${c.authHost}` : ''}
          </button>
        </div>
      )}
      {c.status === 'error' && c.error && <p className="mt-1 pl-[19px] text-[11px] break-words text-(--error)">{c.error}</p>}

      {open && (
        <div className="mt-2 space-y-2.5 pl-[19px]">
          {c.tools.length > 0 ? (
            <ul className="space-y-1.5">
              {c.tools.map((t) => (
                <ToolRow key={t.name} connection={c} tool={t} model={model} />
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-(--ink-mute)">No tools listed yet.</p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => model.reconnect(c.id)}
              className="rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--ink-soft) hover:bg-(--bg-sunken) disabled:opacity-50"
            >
              Reconnect
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => model.remove(c.id)}
              className="rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--error) hover:bg-(--error-soft) disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Settings → Connections: remote MCP servers whose tools the assistant may use. Adding asks Chrome
 * for the server's origin; a server that wants a sign-in shows a Sign in button.
 */
export function ConnectionsSection({ connections: model }: { connections: ConnectionsModel }) {
  return (
    <section>
      <SectionHeading>Connections</SectionHeading>
      <p className="mb-3 text-[11.5px] text-(--ink-mute)">
        Other services the assistant can use through their MCP servers. It asks before changing anything there. Your Canvas site itself can't be added.
      </p>

      {model.list.length > 0 && (
        <ul className="mb-4 space-y-2">
          {model.list.map((c) => (
            <ConnectionRow key={c.id} connection={c} model={model} />
          ))}
        </ul>
      )}

      {/* A new row means an add went through: the form starts over (a new key remounts it) */}
      <AddConnection key={model.list.length} model={model} />
      {model.error && <p className="mt-2 text-[11.5px] break-words text-(--error)">{model.error}</p>}
    </section>
  );
}

/** Catalog chips, then URL + optional name + Connect. */
function AddConnection({ model }: { model: ConnectionsModel }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const adding = model.busy === 'new';

  const connectedHosts = new Set(model.list.map((c) => c.host));
  const suggestions = model.catalog.filter((e) => !e.url || !connectedHosts.has(new URL(e.url).host));

  const pick = (entry: CatalogEntry) => {
    setPicked(entry);
    setName(entry.name);
    setUrl(entry.url ?? '');
  };

  return (
    <>
      {suggestions.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {suggestions.map((e) => (
            <button
              key={e.id}
              type="button"
              title={e.description}
              onClick={() => pick(e)}
              className={`rounded-full border px-3 py-1 text-[12px] ${
                picked?.id === e.id ? 'border-(--accent) bg-(--accent-soft) text-(--accent)' : 'border-(--line) text-(--ink-soft) hover:bg-(--bg-sunken)'
              }`}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}
      {picked && (
        <p className="mb-2 text-[11.5px] text-(--ink-mute)">
          {picked.description}
          {picked.setup && (
            <>
              {' '}
              {picked.setup}{' '}
              {picked.setupUrl && (
                <a href={picked.setupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-(--accent) hover:underline">
                  Open {new URL(picked.setupUrl).host} <ExternalLink size={10} />
                </a>
              )}
            </>
          )}
        </p>
      )}

      <div className="space-y-2">
        <UnderlineInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
        <div className="flex items-center gap-2">
          <UnderlineInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
          <button
            type="button"
            disabled={!url.trim() || adding}
            onClick={() => model.add(url, name)}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-(--accent) px-3 py-1.5 text-[12.5px] text-(--accent-ink) disabled:opacity-40"
          >
            {adding && <Spinner size={11} />} Connect
          </button>
        </div>
      </div>
    </>
  );
}
