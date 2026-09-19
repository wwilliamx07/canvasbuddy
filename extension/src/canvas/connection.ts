import { configureCanvas } from './http';
import { profileFor, KNOWN_HOSTS, type CanvasProfile } from './profiles';

/**
 * Connecting the panel to a Canvas deployment. Known instances (`profiles.ts`) are granted in the
 * manifest and connect silently; any other origin is requested at runtime (a user gesture) from
 * the Connect screen. The host is remembered in `settings.canvasHost`. Chrome can revoke optional
 * permissions, so the check runs on every start.
 */

export interface ConnectionCheck {
  ok: boolean;
  /** Why not: permission missing, not signed in, unreachable. */
  reason?: string;
}

export async function hasOriginPermission(host: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: profileFor(host).origins(host) });
  } catch {
    return false;
  }
}

/** Must run from a user gesture (a click handler); Chrome shows its permission prompt. */
export async function requestOriginPermission(host: string): Promise<boolean> {
  return chrome.permissions.request({ origins: profileFor(host).origins(host) });
}

export async function releaseOriginPermission(host: string): Promise<void> {
  try {
    await chrome.permissions.remove({ origins: profileFor(host).origins(host) });
  } catch {
    // nothing to release
  }
}

/**
 * Confirms the browser session reaches this Canvas. A login page comes back as HTML with 200,
 * so the content type is checked, not just the status.
 */
export async function verifyCanvasSession(host: string): Promise<ConnectionCheck> {
  let response: Response;
  try {
    response = await fetch(`https://${host}/api/v1/users/self`, { credentials: 'include' });
  } catch (e) {
    return { ok: false, reason: `Could not reach ${host}: ${e instanceof Error ? e.message : 'network error'}` };
  }
  const isJson = /application\/json/i.test(response.headers.get('content-type') || '');
  if (response.status === 401 || (response.ok && !isJson)) {
    return { ok: false, reason: `Not signed in to ${host}. Open it in a tab, sign in, then try again.` };
  }
  if (!response.ok) return { ok: false, reason: `${host} answered ${response.status} ${response.statusText}.` };
  try {
    const self = await response.json();
    if (!self?.id) return { ok: false, reason: `${host} does not look like a Canvas site.` };
  } catch {
    return { ok: false, reason: `${host} does not look like a Canvas site.` };
  }
  return { ok: true };
}

/** Points every Canvas request at this host and returns its profile. */
export function activateCanvas(host: string): CanvasProfile {
  configureCanvas(host);
  return profileFor(host);
}

/**
 * A Canvas to connect to without asking: the tab the panel was opened on, then the known
 * instances — the first that already has permission and a live session. Null means the Connect
 * screen has to ask.
 */
export async function findConnectableHost(): Promise<{ host: string | null; tabHost: string | null }> {
  const tabHost = await activeTabHost();
  const candidates = [...new Set([tabHost, ...KNOWN_HOSTS].filter((h): h is string => Boolean(h)))];
  for (const host of candidates) {
    if (!(await hasOriginPermission(host))) continue;
    if ((await verifyCanvasSession(host)).ok) return { host, tabHost };
  }
  return { host: null, tabHost };
}

/** Host of the tab the panel was opened on, when Chrome lets us see it (activeTab after an action click). */
export async function activeTabHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const url = new URL(tab.url);
    return url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}
