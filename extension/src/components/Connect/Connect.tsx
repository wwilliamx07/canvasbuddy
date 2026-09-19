import React, { useEffect, useState } from 'react';
import { ShieldCheck, AlertCircle, RefreshCw } from 'lucide-react';
import {
  inspectActiveTab,
  releaseOriginPermission,
  requestOriginPermission,
  verifyCanvasSession,
  type TabInspection,
} from '../../canvas/connection';
import { profileFor } from '../../canvas/profiles';

interface ConnectProps {
  /** Why the previous connection did not come back (e.g. signed out). */
  initialError?: string;
  onConnected: (host: string) => void;
}

/**
 * Shown when nothing auto-connected. The Canvas is whatever the current tab shows: the page is
 * inspected for Canvas's signature first, and the origin permission — which Chrome only grants
 * from a click — is requested for that host. The request is the first thing the click does, so
 * the gesture is still fresh; verification through the API follows, and a permission granted for
 * something that turns out not to be Canvas is released again.
 */
export const Connect: React.FC<ConnectProps> = ({ initialError, onConnected }) => {
  const [tab, setTab] = useState<TabInspection | null>(null); // null while inspecting
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);

  const inspect = async () => {
    setTab(null);
    setTab(await inspectActiveTab());
  };

  // Inspect on open and whenever the user lands on another page
  useEffect(() => {
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
  }, []);

  const host = tab?.host ?? null;
  const profile = host ? profileFor(host) : null;
  const canGrant = Boolean(host) && tab?.isCanvas !== false;

  const handleGrant = async () => {
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

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full bg-gray-50 p-6 text-center">
      <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4 overflow-hidden">
        <img src="/logo.png" alt="Logo" className="w-full h-full object-contain" />
      </div>
      <h2 className="text-xl font-semibold text-gray-800 mb-1">Connect to your Canvas</h2>
      <p className="text-sm text-gray-500 max-w-xs mb-5">
        CanvasBuddy reads your courses through the browser session you already have. Open your Canvas
        site in this tab, sign in, and grant access.
      </p>

      <div className="w-full max-w-xs space-y-3">
        {tab === null ? (
          <p className="text-xs text-gray-500">Checking the current tab…</p>
        ) : !host ? (
          <p className="text-xs text-gray-500">
            The current tab isn't a page CanvasBuddy can see. Open your Canvas site, then click the
            CanvasBuddy icon again.
          </p>
        ) : tab.isCanvas === false ? (
          <p className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">{host}</span> doesn't look like a Canvas site. Open your
            Canvas, then check again.
          </p>
        ) : (
          <p className="text-xs text-gray-500">
            Current tab: <span className="font-medium text-gray-700">{host}</span>
            {profile && profile.id !== 'generic' && <> · recognized as {profile.name}</>}
          </p>
        )}

        {canGrant ? (
          <button
            type="button"
            onClick={() => void handleGrant()}
            disabled={busy}
            className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors font-medium"
          >
            <ShieldCheck size={16} />
            {busy ? 'Connecting…' : `Grant access to ${host}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void inspect()}
            disabled={tab === null}
            className="w-full bg-gray-200 hover:bg-gray-300 disabled:opacity-50 text-gray-800 py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors font-medium"
          >
            <RefreshCw size={16} />
            Check again
          </button>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-xs text-red-600 text-left">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  );
};
