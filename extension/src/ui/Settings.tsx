import { useRef, useState } from 'react';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import type { AppModel, AppSettings, FreshnessSettings } from './model';
import { DEFAULT_BASE_URLS, DEFAULT_FRESHNESS, FRESHNESS_FIELDS } from './model';
import { formatMinutes } from './format';
import { FieldLabel, SavedPill, SectionHeading, Sheet, UnderlineInput } from './primitives';

const MODEL_PLACEHOLDER: Record<AppSettings['llmProvider'], string> = { google: 'gemini-3.5-flash-lite', openai: 'gpt-4o-mini' };
const EMBED_PLACEHOLDER: Record<AppSettings['llmProvider'], string> = { google: 'gemini-embedding-2', openai: 'text-embedding-3-small' };

export function SettingsSheet({ model, onClose }: { model: AppModel; onClose: () => void }) {
  const { settings, updateSettings, currentContextTokens, connection, disconnect, forgetMemory } = model;
  const [showKey, setShowKey] = useState(false);
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

  const keyHint =
    settings.apiKey && settings.llmProvider === 'google' && !settings.apiKey.startsWith('AIza')
      ? 'Google AI keys usually start with "AIza"'
      : settings.apiKey && settings.llmProvider === 'openai' && !settings.baseUrl && !settings.apiKey.startsWith('sk-')
        ? 'OpenAI keys usually start with "sk-"'
        : null;

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="space-y-7 px-4 py-5">
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
                  onClick={forgetMemory}
                  className="rounded-full border border-(--line) px-3 py-1.5 text-[12.5px] text-(--error) hover:bg-(--error-soft)"
                >
                  Forget this memory
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
              <FieldLabel>Provider</FieldLabel>
              <select
                value={settings.llmProvider}
                onChange={(e) => set('llmProvider', e.target.value as AppSettings['llmProvider'])}
                className="w-full border-0 border-b border-(--line) bg-transparent py-1.5 text-[13px] outline-none focus:border-(--accent)"
              >
                <option value="google">Google AI</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>

            <div>
              <FieldLabel>API key</FieldLabel>
              <div className="flex items-center gap-1.5">
                <UnderlineInput
                  type={showKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder="Paste your API key"
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
              <p className="mt-1 text-[11px] text-(--ink-mute)">Your API key is stored locally and never shared.</p>
              {keyHint && <p className="mt-0.5 text-[11px] text-(--warn)">{keyHint}</p>}
            </div>

            <div>
              <FieldLabel hint="Leave empty for the provider default">Base URL</FieldLabel>
              <UnderlineInput
                value={settings.baseUrl}
                onChange={(e) => set('baseUrl', e.target.value)}
                placeholder={DEFAULT_BASE_URLS[settings.llmProvider]}
              />
            </div>

            <div>
              <FieldLabel>Model</FieldLabel>
              <UnderlineInput value={settings.model} onChange={(e) => set('model', e.target.value)} placeholder={MODEL_PLACEHOLDER[settings.llmProvider]} />
            </div>

            <div>
              <FieldLabel>Embedding model</FieldLabel>
              <UnderlineInput
                value={settings.embeddingModel ?? ''}
                onChange={(e) => set('embeddingModel', e.target.value)}
                placeholder={EMBED_PLACEHOLDER[settings.llmProvider]}
              />
            </div>
          </div>
        </section>

        <section>
          <SectionHeading>Max context before summarization</SectionHeading>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5000}
              max={100000}
              step={500}
              value={settings.contextThreshold}
              onChange={(e) => set('contextThreshold', Number(e.target.value))}
              className="flex-1"
            />
            <input
              type="number"
              min={5000}
              max={100000}
              step={500}
              value={settings.contextThreshold}
              onChange={(e) => set('contextThreshold', Number(e.target.value))}
              className="w-20 border-0 border-b border-(--line) bg-transparent py-1 text-right text-[13px] outline-none focus:border-(--accent)"
            />
          </div>
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-(--bg-sunken)">
              <div
                className="h-full rounded-full bg-(--accent)"
                style={{ width: `${Math.min(100, (currentContextTokens / settings.contextThreshold) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-(--ink-mute)">
              {currentContextTokens.toLocaleString()} / {settings.contextThreshold.toLocaleString()} tokens
            </p>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionHeading>Freshness</SectionHeading>
            <button
              type="button"
              onClick={() => commit({ ...settings, freshness: { ...DEFAULT_FRESHNESS } })}
              className="flex items-center gap-1 text-[11.5px] text-(--ink-mute) hover:text-(--accent)"
            >
              <RotateCcw size={12} /> Reset to defaults
            </button>
          </div>
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
                    <input
                      type="number"
                      min={0}
                      value={value}
                      onChange={(e) => setFreshness(f.key, Number(e.target.value))}
                      className="w-16 border-0 border-b border-(--line) bg-transparent py-1 text-right text-[13px] outline-none focus:border-(--accent)"
                    />
                    <span className="w-9 text-[11px] text-(--ink-mute)">{formatMinutes(value)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="flex items-center justify-between border-t border-(--line) pt-3">
          <p className="text-[11.5px] text-(--ink-mute)">Changes save automatically</p>
          <SavedPill show={saved} />
        </div>
      </div>
    </Sheet>
  );
}
