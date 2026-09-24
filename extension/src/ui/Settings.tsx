import { useRef, useState } from 'react';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import type { AppModel, AppSettings, FreshnessSettings, ProviderId, ProviderInfo } from './model';
import { DEFAULT_FRESHNESS, DEFAULT_SETTINGS, FRESHNESS_FIELDS, PROVIDERS, isKnown768Embedding, modelInfo, providerInfo } from './model';
import { formatMinutes, formatTokens } from './format';
import { Disclosure, FieldLabel, NumberInput, SectionHeading, Sheet, StatusLine, UnderlineInput } from './primitives';
import { ConnectionsSection } from './Connections';

const numberInput =
  'w-20 border-0 border-b border-(--line) bg-transparent py-1 text-right text-[13px] outline-none focus:border-(--accent)';

const selectInput =
  'w-full border-0 border-b border-(--line) bg-transparent py-1.5 text-[13px] outline-none focus:border-(--accent)';

/** Key and base URL for one provider in use. Keys are per provider, so switching back keeps them. */
function ProviderFields({ info, settings, commit }: { info: ProviderInfo; settings: AppSettings; commit: (next: AppSettings) => void }) {
  const [showKey, setShowKey] = useState(false);
  const current = settings.providers[info.id] ?? { apiKey: '' };
  const setField = (field: 'apiKey' | 'baseUrl', value: string) =>
    commit({ ...settings, providers: { ...settings.providers, [info.id]: { ...current, [field]: value } } });
  const key = current.apiKey.trim();
  const keyHint = key && info.keyPrefix && !key.startsWith(info.keyPrefix) ? `${info.label} keys usually start with "${info.keyPrefix}"` : null;

  return (
    <div className="space-y-3 border-l-2 border-(--line) pl-3">
      <div className="text-[12px] font-medium text-(--ink-soft)">{info.label}</div>
      <div>
        <FieldLabel hint={info.keyRequired ? undefined : 'Optional'}>API key</FieldLabel>
        <div className="flex items-center gap-1.5">
          <UnderlineInput
            type={showKey ? 'text' : 'password'}
            value={current.apiKey}
            onChange={(e) => setField('apiKey', e.target.value)}
            placeholder={info.keyRequired ? 'Paste your API key' : 'Not needed unless the server asks for one'}
          />
          <button
            type="button"
            aria-label={showKey ? 'Hide key' : 'Show key'}
            onClick={() => setShowKey((v) => !v)}
            className="shrink-0 rounded-full p-1.5 text-(--ink-mute) hover:bg-(--bg-sunken)"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {keyHint && <p className="mt-0.5 text-[11px] text-(--warn)">{keyHint}</p>}
      </div>
      <div>
        <FieldLabel hint={info.defaultBaseUrl ? 'Leave empty for the default' : 'Required'}>Base URL</FieldLabel>
        <UnderlineInput
          value={current.baseUrl ?? ''}
          onChange={(e) => setField('baseUrl', e.target.value)}
          placeholder={info.defaultBaseUrl || 'https://…/v1'}
        />
      </div>
    </div>
  );
}

export function SettingsSheet({ model, onClose }: { model: AppModel; onClose: () => void }) {
  const { settings, updateSettings, currentContextTokens, contextTokensMeasured, connection, disconnect, deleteAccountData, providerAccess } = model;
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commit = (next: AppSettings) => {
    updateSettings(next);
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1500);
  };
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => commit({ ...settings, [key]: value });
  const setFreshness = (key: keyof FreshnessSettings, minutes: number) =>
    commit({ ...settings, freshness: { ...settings.freshness, [key]: minutes } });

  const setModel = (role: 'chat' | 'embedding', patch: Partial<AppSettings['chat']>) =>
    commit({ ...settings, [role]: { ...settings[role], ...patch } });
  /** A new provider starts from its suggested model; local and custom servers have no id worth guessing. */
  const switchProvider = (role: 'chat' | 'embedding', provider: ProviderId) => {
    const info = providerInfo(provider);
    const suggested = role === 'chat' ? info.chatPlaceholder : info.embedPlaceholder;
    setModel(role, { provider, model: info.local || provider === 'custom' ? '' : (suggested ?? '') });
  };

  const chatInfo = providerInfo(settings.chat.provider);
  const embedInfo = providerInfo(settings.embedding.provider);
  const inUse = [...new Set<ProviderId>([settings.chat.provider, settings.embedding.provider])].map(providerInfo);
  const chatModel = settings.chat.model.trim();
  const thinking = chatModel ? modelInfo(chatInfo.id, chatModel).thinking : 'unknown';
  const embedModel = settings.embedding.model.trim();
  const embedHint =
    embedModel && !isKnown768Embedding(embedInfo.id, embedModel)
      ? 'Not a model known to give 768-dimensional vectors; indexing will say so if it does not.'
      : null;

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="space-y-7 px-4 pt-5 pb-16">
        <section>
          <SectionHeading>Canvas</SectionHeading>
          {connection.status === 'connected' ? (
            <div className="space-y-2">
              <p className="text-[13px] text-(--ink-soft)">
                {connection.host} · {connection.profileName} · <span className="text-(--ink-mute)">{connection.memoryName}</span>
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={deleteAccountData}
                  className="rounded-full border border-(--line) px-3 py-1.5 text-[12.5px] text-(--error) hover:bg-(--error-soft)"
                >
                  Delete this account's data
                </button>
                <button
                  type="button"
                  onClick={disconnect}
                  className="rounded-full border border-(--line) px-3 py-1.5 text-[12.5px] text-(--ink-soft) hover:bg-(--bg-sunken)"
                >
                  Switch Canvas
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-(--ink-mute)">Not connected — close Settings to connect.</p>
          )}
        </section>

        <section>
          <SectionHeading>Assistant</SectionHeading>
          <div className="space-y-4">
            <div>
              <FieldLabel>Chat provider</FieldLabel>
              <select
                value={settings.chat.provider}
                onChange={(e) => switchProvider('chat', e.target.value as ProviderId)}
                className={selectInput}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <FieldLabel>Chat model</FieldLabel>
              <UnderlineInput value={settings.chat.model} onChange={(e) => setModel('chat', { model: e.target.value })} placeholder={chatInfo.chatPlaceholder} />
              {settings.showReasoning && thinking === 'none' && (
                <p className="mt-0.5 text-[11px] text-(--ink-mute)">This model does not share its reasoning.</p>
              )}
            </div>

            <div>
              <FieldLabel hint="Used to search course files">Embeddings provider</FieldLabel>
              <select
                value={settings.embedding.provider}
                onChange={(e) => switchProvider('embedding', e.target.value as ProviderId)}
                className={selectInput}
              >
                {PROVIDERS.filter((p) => p.embeddings).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <FieldLabel>Embedding model</FieldLabel>
              <UnderlineInput
                value={settings.embedding.model}
                onChange={(e) => setModel('embedding', { model: e.target.value })}
                placeholder={embedInfo.embedPlaceholder ?? 'model id'}
              />
              <p className="mt-1 text-[11px] text-(--ink-mute)">Must give 768-dimensional vectors. Changing it re-indexes documents as they are searched.</p>
              {embedHint && <p className="mt-0.5 text-[11px] text-(--warn)">{embedHint}</p>}
            </div>

            {inUse.map((info) => (
              <ProviderFields key={info.id} info={info} settings={settings} commit={commit} />
            ))}
            <p className="text-[11px] text-(--ink-mute)">Keys are stored locally and sent only to their provider.</p>

            {providerAccess.origins.length > 0 && providerAccess.granted === false && (
              <div className="rounded-lg bg-(--bg-sunken) px-3 py-2">
                <p className="text-[11.5px] text-(--ink-soft)">
                  CanvasBuddy needs permission to reach {providerAccess.origins.map((o) => o.replace(/\/\*$/, '')).join(' and ')}.
                </p>
                <button
                  type="button"
                  onClick={providerAccess.grant}
                  className="mt-1.5 rounded-full border border-(--line) px-3 py-1 text-[12px] text-(--accent) hover:bg-(--bg)"
                >
                  Allow access
                </button>
              </div>
            )}

            <label className="flex cursor-pointer items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-(--ink)">Show the assistant's reasoning</div>
                <div className="text-[11px] text-(--ink-mute)">For models that share it. Off stops requesting thoughts and saves their tokens.</div>
              </div>
              <input
                type="checkbox"
                checked={settings.showReasoning}
                onChange={(e) => set('showReasoning', e.target.checked)}
                className="mt-1 h-3.5 w-3.5 shrink-0 accent-(--accent)"
              />
            </label>

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-(--ink)">Tool rounds before asking</div>
                <div className="text-[11px] text-(--ink-mute)">Rounds of tool calls in one reply before it asks whether to keep going.</div>
              </div>
              <NumberInput
                min={1}
                max={100}
                integer
                value={settings.toolRoundsBeforeAsking}
                onCommit={(n) => set('toolRoundsBeforeAsking', n)}
                className={numberInput}
              />
            </div>
          </div>
        </section>

        <ConnectionsSection connections={model.connections} />

        <Disclosure title="Connection tools" hint="how many stay loaded">
          <p className="mb-3 text-[11.5px] text-(--ink-mute)">
            {model.connections.toolLoading === 'none'
              ? 'Nothing connected.'
              : model.connections.toolLoading === 'eager'
                ? `All connection tools (${formatTokens(model.connections.totalToolTokens)}) are sent with every message, since they fit in ${formatTokens(model.connections.eagerLimit)}.`
                : `Connection tools (${formatTokens(model.connections.totalToolTokens)}) load on demand: the assistant searches for what it needs, and a chat keeps what it loaded within these limits.`}
          </p>
          <ul className="divide-y divide-(--line)">
            <li className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] text-(--ink)">Loaded tools per chat</div>
                <div className="text-[11px] text-(--ink-mute)">most tools kept loaded at once</div>
              </div>
              <NumberInput
                min={1}
                max={40}
                integer
                value={settings.loadedToolsMax}
                onCommit={(n) => set('loadedToolsMax', n)}
                className={numberInput}
              />
            </li>
            <li className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] text-(--ink)">Loaded tools budget</div>
                <div className="text-[11px] text-(--ink-mute)">tokens of tool definitions sent with each call</div>
              </div>
              <NumberInput
                min={500}
                step={500}
                integer
                value={settings.loadedToolsTokenBudget}
                onCommit={(n) => set('loadedToolsTokenBudget', n)}
                className={numberInput}
              />
            </li>
          </ul>
          <button
            type="button"
            onClick={() => commit({ ...settings, loadedToolsMax: DEFAULT_SETTINGS.loadedToolsMax, loadedToolsTokenBudget: DEFAULT_SETTINGS.loadedToolsTokenBudget })}
            className="mt-2 flex items-center gap-1 text-[11.5px] text-(--ink-mute) hover:text-(--accent)"
          >
            <RotateCcw size={12} /> Reset to defaults
          </button>
        </Disclosure>

        <Disclosure title="Freshness" hint="how long remembered Canvas data counts as current">
          <ul className="divide-y divide-(--line)">
            {FRESHNESS_FIELDS.map((f) => {
              const value = settings.freshness?.[f.key] ?? DEFAULT_FRESHNESS[f.key];
              return (
                <li key={f.key} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px] text-(--ink)">{f.label}</div>
                    {f.hint && <div className="truncate text-[11px] text-(--ink-mute)">{f.hint}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <NumberInput
                      min={0}
                      value={value}
                      onCommit={(n) => setFreshness(f.key, n)}
                      className="w-16 border-0 border-b border-(--line) bg-transparent py-1 text-right text-[13px] outline-none focus:border-(--accent)"
                    />
                    <span className="w-9 text-[11px] text-(--ink-mute)">{formatMinutes(value)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => commit({ ...settings, freshness: { ...DEFAULT_FRESHNESS } })}
            className="mt-2 flex items-center gap-1 text-[11.5px] text-(--ink-mute) hover:text-(--accent)"
          >
            <RotateCcw size={12} /> Reset to defaults
          </button>
        </Disclosure>

        <section>
          <SectionHeading>Max context before summarization</SectionHeading>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5000}
              max={1000000}
              step={500}
              value={settings.contextThreshold}
              onChange={(e) => set('contextThreshold', Number(e.target.value))}
              className="min-w-0 flex-1"
            />
            <NumberInput
              min={5000}
              max={1000000}
              step={500}
              integer
              value={settings.contextThreshold}
              onCommit={(n) => set('contextThreshold', n)}
              className="w-24 border-0 border-b border-(--line) bg-transparent py-1 text-right text-[13px] outline-none focus:border-(--accent)"
            />
          </div>
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-(--bg-sunken)">
              <div
                className="h-full rounded-full bg-(--accent)"
                style={{ width: `${Math.min(100, (currentContextTokens / settings.contextThreshold) * 100)}%` }}
              />
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <p className="text-[11px] text-(--ink-mute)">
                {contextTokensMeasured ? '' : '≈'}{currentContextTokens.toLocaleString()} / {settings.contextThreshold.toLocaleString()} tokens
                {contextTokensMeasured ? ' · counted by the provider' : ''}
              </p>
              {model.canCompact && (
                <button type="button" onClick={model.compactNow} className="shrink-0 text-[11.5px] text-(--accent) hover:underline" title="Summarize this chat into memory now (/compact)">
                  Compact now
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
      {/* Pinned to the sheet's foot (not the scrolled content), so it shows wherever the change was made */}
      <StatusLine message={saved ? 'Settings saved' : null} />
    </Sheet>
  );
}
