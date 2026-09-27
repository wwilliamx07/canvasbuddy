import { describe, expect, it } from 'vitest';
import { currentTimeLine, localDayOf, localTimes, localTimestamp } from '../../src/utils/time';

// test/setup.ts pins the zone to America/Toronto

describe('local times', () => {
  it('writes an instant with the local offset, so a UTC-midnight deadline lands on the previous local day', () => {
    expect(localTimestamp(new Date('2026-10-01T03:59:00Z'))).toBe('2026-09-30T23:59:00-04:00');
    expect(localTimestamp(new Date('2026-01-15T05:00:00Z'))).toBe('2026-01-15T00:00:00-05:00'); // standard time
    // The same instant: a connected service's API can take it unchanged
    expect(new Date(localTimestamp(new Date('2026-10-01T03:59:00Z'))).toISOString()).toBe('2026-10-01T03:59:00.000Z');
  });

  it('gives the local day of a stored or Canvas timestamp', () => {
    expect(localDayOf('2026-09-02T00:00:00Z')).toBe('2026-09-01');
    expect(localDayOf(new Date('2026-09-02T12:00:00Z'))).toBe('2026-09-02');
    expect(localDayOf(null)).toBe('');
    expect(localDayOf('not a date')).toBe('');
  });

  it('converts every timestamp in a tool result and leaves other strings alone', () => {
    const payload = {
      due_at: new Date('2026-10-01T03:59:00Z'),
      posted_at: '2026-09-04T12:00:00Z',
      nested: [{ submitted_at: '2026-09-30T16:00:00.000Z' }],
      missing: null,
      broken: new Date('nope'),
      updated_at: 'T1',
      text: 'Due 2026-10-01T03:59:00Z, see the syllabus',
    };
    expect(JSON.parse(JSON.stringify(payload, localTimes))).toEqual({
      due_at: '2026-09-30T23:59:00-04:00',
      posted_at: '2026-09-04T08:00:00-04:00',
      nested: [{ submitted_at: '2026-09-30T12:00:00-04:00' }],
      missing: null,
      broken: null,
      updated_at: 'T1',
      text: 'Due 2026-10-01T03:59:00Z, see the syllabus',
    });
  });

  it('names the weekday, the local time and the zone', () => {
    expect(currentTimeLine(new Date('2026-09-27T18:05:00Z'))).toBe(
      'Current time: Sunday 2026-09-27T14:05:00-04:00 (America/Toronto). Times in tool results are in this zone.'
    );
  });
});
