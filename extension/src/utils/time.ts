/**
 * Times as the model sees them. Canvas answers in UTC and a model asked to convert gets the day
 * wrong around midnight, so everything model-facing is already in the student's zone (the
 * browser's). A timestamp stays a full RFC 3339 instant with its offset
 * (`2026-09-30T23:59:00-04:00`), so it can be passed unchanged to a connected service's API.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/** "2026-09-30": the student's day of an instant. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day of a stored or Canvas timestamp; '' when there is none. */
export function localDayOf(t: Date | string | null | undefined): string {
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? localDay(d) : '';
}

/** 2026-10-01T03:59:00Z → "2026-09-30T23:59:00-04:00" in Toronto. */
export function localTimestamp(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

export function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}

/** Rides on the latest user turn with the roster: the model has no clock of its own. */
export function currentTimeLine(now: Date): string {
  return `Current time: ${WEEKDAYS[now.getDay()]} ${localTimestamp(now)} (${timeZoneName()}). Times in tool results are in this zone.`;
}

/**
 * `JSON.stringify` replacer for tool results: a `Date` from the database or a UTC string from
 * Canvas becomes the same instant in local time. It reads the holder, because `Date#toJSON` has
 * already turned the value into a UTC string by the time a replacer sees it.
 */
export function localTimes(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : localTimestamp(raw);
  if (typeof value === 'string' && UTC_TIMESTAMP.test(value)) return localTimestamp(new Date(value));
  return value;
}
