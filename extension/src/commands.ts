import type { ChatUsage } from './agent/history';
import type { ToolLoading } from './connections/tools';
import type { Message } from './ui/model';
import { compactNumber, formatUsage } from './utils/tokens';

/**
 * Composer commands: a message starting with `/name` is handled by the app and never sent to the
 * model. Each command's outcome is a `notice` in the transcript (display-only, never part of the
 * model-facing history). The registry is pure; `App.tsx` supplies the context. There is
 * deliberately no refresh / sync / index command: memory is engine-managed.
 */

export interface CommandInfo {
  name: string;
  /** "/tools [unload <name>]" */
  usage: string;
  description: string;
  /** Takes arguments the student has to type (completion adds a space instead of running it). */
  needsArgs?: boolean;
}

/** A connection tool as `/tools` shows it. */
export interface ToolLine {
  name: string;
  label: string;
}

/** What commands can do; `App.tsx` implements it over its state. */
export interface CommandContext {
  notice(text: string): void;
  newChat(): void;
  /** Digest every un-digested turn now; `focus` is what the summary must keep. */
  compact(focus: string): Promise<void>;
  canCompact(): boolean;
  exportChat(): void;
  hasChat(): boolean;
  usage(): ChatUsage;
  tools(): { mode: ToolLoading; loaded: ToolLine[]; total: number; max: number };
  /** Drops a loaded tool; its label, or null when none matches. */
  unloadTool(query: string): string | null;
}

interface CommandSpec extends CommandInfo {
  /** Allowed while an answer is being written (only what leaves the transcript alone: the run repaints it). */
  duringRun?: boolean;
  /** Why it cannot run (shown under the composer, the text kept), or null. */
  check?(args: string, ctx: CommandContext): string | null;
  run(args: string, ctx: CommandContext): void | Promise<void>;
}

function usageLine(label: string, usage: ChatUsage['answers'], calls = 0): string {
  return `${label}: ${calls} call${calls === 1 ? '' : 's'}${usage ? ` · ${formatUsage(usage)}` : ''}`;
}

const SPECS: CommandSpec[] = [
  {
    name: 'compact',
    usage: '/compact [what to keep]',
    description: 'Summarize the conversation so far into memory now',
    check: (_args, ctx) => (ctx.canCompact() ? null : 'Nothing to compact yet.'),
    run: (args, ctx) => ctx.compact(args),
  },
  {
    name: 'new',
    usage: '/new',
    description: 'Start a new chat',
    duringRun: true,
    run: (_args, ctx) => ctx.newChat(),
  },
  {
    name: 'usage',
    usage: '/usage',
    description: "Tokens this chat has used, as the provider counted them",
    run: (_args, ctx) => {
      const u = ctx.usage();
      if (!u.answerCalls && !u.digestCalls) return ctx.notice('No model calls in this chat yet.');
      const lines = [usageLine('Answers', u.answers, u.answerCalls), ...(u.digestCalls ? [usageLine('Summaries', u.digests, u.digestCalls)] : [])];
      ctx.notice(lines.join('\n'));
    },
  },
  {
    name: 'export',
    usage: '/export',
    description: 'Download this chat as Markdown',
    check: (_args, ctx) => (ctx.hasChat() ? null : 'Nothing to export yet.'),
    run: (_args, ctx) => ctx.exportChat(),
  },
  {
    name: 'tools',
    usage: '/tools [unload <name>]',
    description: 'Connection tools this chat has loaded',
    check: (args, ctx) => {
      if (!args) return null;
      const m = /^unload\s+(.+)$/i.exec(args);
      if (!m) return 'Usage: /tools [unload <name>]';
      if (ctx.tools().mode !== 'lazy') return 'Connection tools are not loaded on demand, so there is nothing to unload.';
      return null;
    },
    run: (args, ctx) => {
      const m = /^unload\s+(.+)$/i.exec(args);
      if (m) {
        const label = ctx.unloadTool(m[1].trim());
        return ctx.notice(label ? `Unloaded ${label}.` : `No loaded tool matches “${m[1].trim()}”.`);
      }
      const { mode, loaded, total, max } = ctx.tools();
      if (mode === 'none') return ctx.notice('No connections are on.');
      if (mode === 'eager') return ctx.notice(`All ${total} connection tools are sent with every message.`);
      ctx.notice(
        loaded.length
          ? `Loaded in this chat (${loaded.length} of at most ${max}):\n${loaded.map((t) => `${t.label} (${t.name})`).join('\n')}`
          : `No connection tools loaded in this chat yet; the assistant loads them as it needs them (${total} available).`
      );
    },
  },
  {
    name: 'help',
    usage: '/help',
    description: 'List the commands',
    run: (_args, ctx) => ctx.notice(SPECS.map((c) => `${c.usage} — ${c.description}`).join('\n')),
  },
];

export const COMMANDS: CommandInfo[] = SPECS.map(({ name, usage, description }) => ({ name, usage, description, needsArgs: usage.includes('<') && !usage.includes('[') }));

/** `/name args` → its parts; null for anything else ("/courses/123" is text, not a command). */
export function parseCommand(input: string): { name: string; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

/**
 * Runs `input` if it is a command. `handled: false` → send it to the model as usual. `refused` →
 * show it under the composer and keep the text.
 */
export function dispatchCommand(input: string, ctx: CommandContext, running: boolean): { handled: false } | { handled: true; refused?: string; done?: Promise<void> } {
  const parsed = parseCommand(input);
  if (!parsed) return { handled: false };
  const spec = SPECS.find((c) => c.name === parsed.name);
  if (!spec) return { handled: true, refused: `Unknown command /${parsed.name} · /help lists them.` };
  if (running && !spec.duringRun) return { handled: true, refused: `/${spec.name} runs once the answer is finished.` };
  const reason = spec.check?.(parsed.args, ctx);
  if (reason) return { handled: true, refused: reason };
  const outcome = spec.run(parsed.args, ctx);
  return { handled: true, ...(outcome ? { done: outcome } : {}) };
}

/** The chat as Markdown for notes: text, each step as one line, notices in italics. */
export function chatMarkdown(title: string, messages: Message[]): string {
  const out = [`# ${title}`, ''];
  for (const m of messages) {
    if (m.queued) continue;
    const time = m.timestamp.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    if (m.notice) {
      out.push(`*${m.content.replace(/\n/g, ' · ')}*`, '');
      continue;
    }
    out.push(`**${m.role === 'user' ? 'You' : 'CanvasBuddy'}** · ${time}`, '');
    for (const s of m.steps ?? []) {
      if (s.kind === 'tool') out.push(`> ${s.label}${s.status === 'error' && s.result ? ` — ${s.result}` : ''}`);
    }
    if (m.steps?.some((s) => s.kind === 'tool')) out.push('');
    if (m.content) out.push(m.content, '');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** "Compacted 42 messages · ≈18k → ≈1.3k tokens" */
export function compactionNotice(messages: number, before: number, after: number): string {
  return `Compacted ${messages} message${messages === 1 ? '' : 's'} · ≈${compactNumber(before)} → ≈${compactNumber(after)} tokens`;
}
