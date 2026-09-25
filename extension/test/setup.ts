import nodeConsole from 'node:console';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Global test setup. Nothing here reaches a network, an account or IndexedDB:
 * - pdf.js is replaced (its worker cannot run under Node; real PDF parsing is out of scope);
 * - `chrome.*` is an in-memory stand-in for the extension APIs the code touches;
 * - `fetch` is left undefined-by-default per test: each test stubs it (helpers/canvas.ts,
 *   helpers/llm.ts, helpers/mcp.ts) and `vi.unstubAllGlobals()` removes the stub afterwards.
 */

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => {
    throw new Error('PDF parsing is not available in tests');
  },
}));

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

const storage = new Map<string, unknown>();
const storageListeners = new Set<Listener>();
const granted = new Set<string>();

export const chromeState = {
  storage,
  granted,
  /** When false, `permissions.request` refuses (the user dismissed the prompt). */
  grantOnRequest: true,
  dynamicRules: [] as chrome.declarativeNetRequest.Rule[],
  /** What `identity.launchWebAuthFlow` resolves with; set by OAuth tests. */
  authFlow: null as null | ((url: string) => string | undefined),
};

const chromeStub = {
  runtime: {
    id: 'testextensionid',
    // Firefox's shape: the page host is a per-install UUID, not the id (Chrome uses the id for both).
    getURL: (path: string) => `moz-extension://test-extension-uuid/${path}`,
    getManifest: () => ({ version: '0.0.0-test' }),
  },
  storage: {
    local: {
      async get(key: string) {
        return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: storage.get(key), newValue: value };
          storage.set(key, structuredClone(value));
        }
        for (const listener of storageListeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener: (l: Listener) => storageListeners.add(l),
      removeListener: (l: Listener) => storageListeners.delete(l),
    },
  },
  permissions: {
    async contains({ origins = [] }: { origins?: string[] }) {
      return origins.every((o) => granted.has(o));
    },
    async request({ origins = [] }: { origins?: string[] }) {
      if (!chromeState.grantOnRequest) return false;
      origins.forEach((o) => granted.add(o));
      return true;
    },
    async remove({ origins = [] }: { origins?: string[] }) {
      origins.forEach((o) => granted.delete(o));
      return true;
    },
  },
  // No enum objects (`RuleActionType`, `HeaderOperation`): Firefox does not have them.
  declarativeNetRequest: {
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }: chrome.declarativeNetRequest.UpdateRuleOptions) {
      chromeState.dynamicRules = [...chromeState.dynamicRules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
    },
  },
  identity: {
    getRedirectURL: (path = '') => `https://testextensionid.chromiumapp.org/${path}`,
    async launchWebAuthFlow({ url }: { url: string }) {
      if (!chromeState.authFlow) throw new Error('The user did not approve access.');
      return chromeState.authFlow(url);
    },
  },
};

(globalThis as any).chrome = chromeStub;

// happy-dom reports every iframe it was told not to load (vitest.config.ts turns loading off, so
// parsed Canvas HTML never reaches the network); that is the setting working, not an error. It
// logs through Node's own console, captured before Vitest wraps `console`, which `node:console` is.
const nodeConsoleError = nodeConsole.error.bind(nodeConsole);
nodeConsole.error = (...args: unknown[]) => {
  if (args.some((a) => /(Iframe page|file) loading is disabled/.test(String((a as Error)?.message ?? a)))) return;
  nodeConsoleError(...args);
};

beforeEach(() => {
  storage.clear();
  storageListeners.clear();
  granted.clear();
  chromeState.grantOnRequest = true;
  chromeState.dynamicRules = [];
  chromeState.authFlow = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
