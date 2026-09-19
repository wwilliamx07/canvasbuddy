/**
 * Deployment profiles. Canvas is the same API everywhere, but a deployment has a name the
 * student uses ("Quercus"), a set of hosts its links live on, and origins the extension must be
 * allowed to reach (the Canvas host, plus wherever it serves file downloads from). The profile is
 * chosen by host at connect time; the generic one covers any Canvas.
 *
 * A profile's `knownHosts` are instances the extension connects to without asking: their origins
 * are granted in `manifest.json` (`host_permissions`) so no permission prompt is needed. Adding
 * one means adding its origin pattern there too.
 */
export interface CanvasProfile {
  id: 'quercus' | 'generic';
  /** What the student calls it. */
  name: string;
  /** Instances whose origins the manifest grants up front; tried for auto-connect at startup. */
  knownHosts: string[];
  matches(host: string): boolean;
  /** Hostnames whose links point inside this Canvas (parsed into file/page/… references). */
  isInternalHost(hostname: string, host: string): boolean;
  /** Origin patterns to request at connect time. */
  origins(host: string): string[];
  /** First sentence of the system prompt; stable per profile so the prompt prefix stays cacheable. */
  promptIntro(host: string): string;
}

const QUERCUS: CanvasProfile = {
  id: 'quercus',
  name: 'Quercus',
  knownHosts: ['q.utoronto.ca'],
  matches: (host) => /(^|\.)utoronto\.ca$/.test(host),
  isInternalHost: (hostname) => /(^|\.)utoronto\.ca$/.test(hostname),
  origins: () => ['https://*.utoronto.ca/*'],
  promptIntro: () => 'You are a helpful student assistant integrated into Canvas (Quercus at the University of Toronto).',
};

const GENERIC: CanvasProfile = {
  id: 'generic',
  name: 'Canvas',
  knownHosts: [],
  matches: () => true,
  // Instructure-hosted deployments answer on their own host and on *.instructure.com
  isInternalHost: (hostname, host) => hostname === host || /\.instructure\.com$/.test(hostname),
  origins: (host) => [`https://${host}/*`],
  promptIntro: (host) =>
    host
      ? `You are a helpful student assistant integrated into Canvas (the course site at ${host}).`
      : 'You are a helpful student assistant integrated into Canvas.',
};

const PROFILES: CanvasProfile[] = [QUERCUS, GENERIC];

/** Every known instance, in profile order — the auto-connect candidates after the active tab. */
export const KNOWN_HOSTS: string[] = PROFILES.flatMap((p) => p.knownHosts);

export function profileFor(host: string): CanvasProfile {
  return PROFILES.find((p) => p.matches(host)) ?? GENERIC;
}

/** "q.utoronto.ca" from whatever the user typed or the tab reported. */
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
