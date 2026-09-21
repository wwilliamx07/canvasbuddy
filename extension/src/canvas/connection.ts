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
  /** The host answered, but not like Canvas — a granted permission should be released. */
  notCanvas?: boolean;
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
  if (response.status === 404 || (!response.ok && !isJson)) {
    return { ok: false, notCanvas: true, reason: `${host} does not look like a Canvas site.` };
  }
  if (!response.ok) return { ok: false, reason: `${host} answered ${response.status} ${response.statusText}.` };
  try {
    const self = await response.json();
    if (!self?.id) return { ok: false, notCanvas: true, reason: `${host} does not look like a Canvas site.` };
  } catch {
    return { ok: false, notCanvas: true, reason: `${host} does not look like a Canvas site.` };
  }
  return { ok: true };
}

export interface TabInspection {
  /** Host of the active tab, when it is an https page whose URL the panel may see. */
  host: string | null;
  /** Whether the page is Canvas; null when the page could not be inspected. */
  isCanvas: boolean | null;
}

/**
 * Looks at the active tab before asking for anything: its host, and whether the page is Canvas.
 * Canvas LMS exposes a global `ENV` (current user, root account) on every page and wraps the app
 * in `#application.ic-app`, so both are checked in the page's main world. Inspecting needs the
 * `activeTab` grant that clicking the action gives for that tab; when it is missing (the panel was
 * open while the user switched tabs) the result is `isCanvas: null` and the caller verifies
 * through the API after the permission request instead.
 */
export async function inspectActiveTab(): Promise<TabInspection> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return { host: null, isCanvas: null };
  }
  if (!tab?.url || tab.id === undefined) return { host: null, isCanvas: null };
  let host: string;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'https:') return { host: null, isCanvas: null };
    host = url.hostname;
  } catch {
    return { host: null, isCanvas: null };
  }
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: looksLikeCanvasPage });
    return { host, isCanvas: Boolean(result?.result) };
  } catch {
    return { host, isCanvas: null };
  }
}

// Serialized into the page, so it must be self-contained: no references to this module.
function looksLikeCanvasPage(): boolean {
  const env = (window as any).ENV;
  const envHit =
    !!env && typeof env === 'object' && ('current_user_id' in env || 'DOMAIN_ROOT_ACCOUNT_ID' in env || 'ACCOUNT_ID' in env);
  const domHit = !!document.querySelector('#application.ic-app, .ic-app-header, .ic-Login, #global_nav_tray_container');
  return envHit || domHit;
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
