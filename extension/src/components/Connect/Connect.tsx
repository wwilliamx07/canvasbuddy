import React, { useEffect, useState } from 'react';
import { Link2, AlertCircle } from 'lucide-react';
import { activeTabHost, requestOriginPermission, verifyCanvasSession } from '../../canvas/connection';
import { normalizeHost, profileFor, KNOWN_HOSTS } from '../../canvas/profiles';

interface ConnectProps {
  /** Host to prefill (a previous connection whose permission is gone), if any. */
  initialHost?: string;
  /** Why the previous connection did not come back (e.g. signed out). */
  initialError?: string;
  onConnected: (host: string) => void;
}

/**
 * First-run (and permission-lost) screen. The origin permission can only be requested from a
 * user gesture, so the whole flow hangs off the Connect button: request → verify the session
 * reaches Canvas → hand the host up.
 */
export const Connect: React.FC<ConnectProps> = ({ initialHost, initialError, onConnected }) => {
  const [hostInput, setHostInput] = useState(initialHost || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);

  // Prefill from the tab the panel was opened on, else the first known instance
  useEffect(() => {
    if (initialHost) return;
    activeTabHost().then((h) => {
      setHostInput(h || KNOWN_HOSTS[0] || '');
    });
  }, [initialHost]);

  const host = normalizeHost(hostInput);
  const profile = host ? profileFor(host) : null;

  const handleConnect = async () => {
    if (!host) {
      setError('Enter the address of your Canvas site, e.g. q.utoronto.ca');
      return;
    }
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
        site in a tab and sign in, then connect.
      </p>

      <form
        className="w-full max-w-xs space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void handleConnect();
        }}
      >
        <input
          type="text"
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          placeholder="q.utoronto.ca"
          disabled={busy}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100"
        />
        <button
          type="submit"
          disabled={busy || !host}
          className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors font-medium"
        >
          <Link2 size={16} />
          {busy ? 'Connecting…' : host ? `Connect to ${host}` : 'Connect'}
        </button>
        {profile && profile.id !== 'generic' && (
          <p className="text-xs text-gray-500">Recognized as {profile.name}.</p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-red-600 text-left">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}
      </form>
    </div>
  );
};
