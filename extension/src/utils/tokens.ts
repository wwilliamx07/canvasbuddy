import type { Usage } from '../providers/types';

/**
 * ~4 characters per token: a provider-neutral estimate, good enough for budgets, meters and the
 * context threshold. Never used for anything that must match the provider's count exactly.
 */
export function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 380, 4.1k, 18k */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}

/** "4.1k in (3.2k cached) · 380 out (120 thinking)" */
export function formatUsage(usage: Usage): string {
  const input = `${compactNumber(usage.input)} in${usage.cachedInput ? ` (${compactNumber(usage.cachedInput)} cached)` : ''}`;
  const output = `${compactNumber(usage.output)} out${usage.reasoning ? ` (${compactNumber(usage.reasoning)} thinking)` : ''}`;
  return `${input} · ${output}`;
}
