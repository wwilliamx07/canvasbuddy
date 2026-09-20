import type { AppModel } from './model';
import { Logo, Spinner } from './primitives';

function Mark() {
  return <Logo size={64} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <Mark />
      {children}
    </div>
  );
}

export function CheckingPlaceholder({ host }: { host?: string }) {
  return (
    <Frame>
      <div className="serif text-[17px] text-(--ink)">{host ? `Connecting to ${host}…` : 'Loading…'}</div>
      <Spinner size={18} />
    </Frame>
  );
}

export function ConnectScreen({ model }: { model: AppModel }) {
  const { connect, connection } = model;
  const tab = connect.tab;
  const initialError = connection.status === 'disconnected' ? (connection.reason ?? null) : null;
  const error = connect.error ?? initialError;

  return (
    <Frame>
      <div>
        <div className="serif text-[19px] text-(--ink)">Connect to your Canvas</div>
        <p className="mx-auto mt-2 max-w-[30ch] text-[13px] text-(--ink-mute)">
          CanvasBuddy reads your courses through the browser session you already have. Open your Canvas site in this tab, sign in, and
          grant access.
        </p>
      </div>

      <div className="flex w-full max-w-[280px] flex-col items-center gap-3">
        {tab === null && (
          <div className="flex items-center gap-2 text-[13px] text-(--ink-mute)">
            <Spinner size={14} /> Checking the current tab…
          </div>
        )}

        {tab && tab.host === null && (
          <>
            <p className="text-[13px] text-(--ink-soft)">
              The current tab isn't a page CanvasBuddy can see. Open your Canvas site, then click the CanvasBuddy icon again.
            </p>
            <button type="button" onClick={connect.inspect} className="rounded-full border border-(--line) px-4 py-1.5 text-[13px] text-(--ink) hover:bg-(--bg-sunken)">
              Check again
            </button>
          </>
        )}

        {tab && tab.host !== null && tab.isCanvas === false && (
          <>
            <p className="text-[13px] text-(--ink-soft)">
              <span className="font-medium">{tab.host}</span> doesn't look like a Canvas site.
            </p>
            <button type="button" onClick={connect.inspect} className="rounded-full border border-(--line) px-4 py-1.5 text-[13px] text-(--ink) hover:bg-(--bg-sunken)">
              Check again
            </button>
          </>
        )}

        {tab && tab.host !== null && tab.isCanvas !== false && (
          <>
            <p className="text-[13px] text-(--ink-soft)">
              Current tab: <span className="font-medium text-(--ink)">{tab.host}</span>
              {tab.profileName && (
                <>
                  {' '}
                  · recognized as <span className="font-medium text-(--ink)">{tab.profileName}</span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={connect.grant}
              disabled={connect.busy}
              className="w-full rounded-full bg-(--accent) px-4 py-2 text-[13px] font-medium text-(--accent-ink) transition-opacity disabled:opacity-60"
            >
              {connect.busy ? 'Connecting…' : `Grant access to ${tab.host}`}
            </button>
          </>
        )}

        {error && <p className="text-[12.5px] text-(--error)">{error}</p>}
      </div>
    </Frame>
  );
}
