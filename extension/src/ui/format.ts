import type { CollectionStatus } from './model';

/** "just now", "3 min ago", "2 h ago", "yesterday", "Sep 12" */
export function timeAgo(date: Date | string | null | undefined, now: Date = new Date()): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "in 3 h", "tomorrow 22:00", "Thu 22:00", "Oct 15", "3 d ago" — for due dates. */
export function formatDue(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'no due date';
  const d = new Date(iso);
  const ms = d.getTime() - now.getTime();
  const days = Math.floor((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ms < 0) {
    if (days === 0) return `today ${time} (past)`;
    if (days === -1) return 'yesterday';
    return `${-days} d ago`;
  }
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Freshness field display: 1440 → "1 d", 90 → "1.5 h", 15 → "15 min". */
export function formatMinutes(min: number): string {
  if (min % (24 * 60) === 0) return `${min / (24 * 60)} d`;
  if (min % 60 === 0) return `${min / 60} h`;
  if (min > 60) return `${(min / 60).toFixed(1)} h`;
  return `${min} min`;
}

export type PillTone = 'ok' | 'muted' | 'warn' | 'error';

/** The sync-status pill for a collection row: label + tone, derived the same way in every shell. */
export function syncPill(c: CollectionStatus, now: Date = new Date()): { label: string; tone: PillTone } {
  switch (c.status) {
    case 'unavailable':
      return { label: 'hidden by course', tone: 'muted' };
    case 'never':
      return { label: 'not yet', tone: 'muted' };
    case 'error':
      return { label: c.error ? `failed · ${c.error}` : 'failed', tone: 'error' };
    default:
      return { label: c.syncedAt ? `synced ${timeAgo(c.syncedAt, now)}` : 'synced', tone: 'ok' };
  }
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
