import { describe, expect, it } from 'vitest';
import { compactNumber, formatUsage } from '../../src/ui/format';

describe('usage formatting', () => {
  it('compactNumber', () => {
    expect([380, 1000, 4130, 18_400, 120_000].map(compactNumber)).toEqual(['380', '1k', '4.1k', '18k', '120k']);
  });

  it('formatUsage shows cached input and thinking only when present', () => {
    expect(formatUsage({ input: 4130, output: 380 })).toBe('4.1k in · 380 out');
    expect(formatUsage({ input: 4130, output: 380, cachedInput: 3200, reasoning: 120 })).toBe('4.1k in (3.2k cached) · 380 out (120 thinking)');
  });
});
