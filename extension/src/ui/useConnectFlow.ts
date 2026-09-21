import { useEffect, useState } from 'react';
import { inspectActiveTab, releaseOriginPermission, requestOriginPermission, verifyCanvasSession } from '../canvas/connection';
import { profileFor } from '../canvas/profiles';
import type { ConnectModel, TabInspection } from './model';

/**
 * The Connect screen's state. The Canvas is whatever the current tab shows: the page is inspected
 * for Canvas's signature, and the origin permission — which Chrome only grants from a click — is
 * requested for that host. The request is the first thing the click does, so the gesture is still
 * fresh; verification through the API follows, and a permission granted for something that turns
 * out not to be Canvas is released again. The tab is only watched while `enabled` (disconnected).
 */
export function useConnectFlow(onConnected: (host: string) => void, opts: { enabled: boolean; initialError?: string }): ConnectModel {
  const { enabled, initialError } = opts;
  const [tab, setTab] = useState<TabInspection | null>(null); // null while inspecting
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    setTab(null);
    const t = await inspectActiveTab();
    const profile = t.host ? profileFor(t.host) : null;
    setTab({ host: t.host, isCanvas: t.isCanvas, profileName: profile && profile.id !== 'generic' ? profile.name : null });
  };

  useEffect(() => {
    setError(initialError || null);
  }, [initialError, enabled]);

  // Inspect on open and whenever the user lands on another page
  useEffect(() => {
    if (!enabled) return;
    void inspect();
    const onActivated = () => void inspect();
    const onUpdated = (_tabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.status === 'complete') void inspect();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [enabled]);

  const grant = async () => {
    const host = tab?.host;
    if (!host) return;
    setBusy(true);
    setError(null);
    try {
      const granted = await requestOriginPermission(host);
      if (!granted) {
        setError('Permission was not granted. CanvasBuddy needs access to your Canvas site to read your courses.');
        return;
      }
      const check = await verifyCanvasSession(host);
      if (!check.ok) {
        if (check.notCanvas) await releaseOriginPermission(host);
        setError(check.reason || 'Could not verify the connection.');
        return;
      }
      onConnected(host);
    } finally {
      setBusy(false);
    }
  };

  return { tab, busy, error, inspect: () => void inspect(), grant: () => void grant() };
}
