/**
 * Who is signed in, and which memory belongs to them. One browser profile can hold sessions for
 * several Canvas accounts over time; each `<host>/<userId>` gets its own PGlite database and chat
 * list so courses, inbox and chats never mix. Settings (API key, model, TTLs) stay global.
 */

export interface CanvasIdentity {
  host: string;
  userId: string;
  name: string;
}

export interface MemorySlot extends CanvasIdentity {
  /** PGlite data dir name (`idb://<dbName>`). */
  dbName: string;
  /** localStorage key of this identity's chat list. */
  chatsKey: string;
  since: string;
}

const LAST_IDENTITY_KEY = 'canvas-buddy-identity';
const MEMORIES_KEY = 'canvas-buddy-memories';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Asks Canvas who the session belongs to. When the session is gone (login page, network), the
 * last identity seen on this host is returned with `live: false` so the panel can still show
 * what it remembers instead of a blank screen.
 */
export async function resolveIdentity(host: string): Promise<{ identity: CanvasIdentity; live: boolean } | null> {
  const remembered = readJson<Record<string, CanvasIdentity>>(LAST_IDENTITY_KEY, {});
  try {
    const response = await fetch(`https://${host}/api/v1/users/self`, { credentials: 'include' });
    const isJson = /application\/json/i.test(response.headers.get('content-type') || '');
    if (response.ok && isJson) {
      const self = await response.json();
      if (self?.id) {
        const identity: CanvasIdentity = { host, userId: String(self.id), name: self.short_name || self.name || `user ${self.id}` };
        localStorage.setItem(LAST_IDENTITY_KEY, JSON.stringify({ ...remembered, [host]: identity }));
        return { identity, live: true };
      }
    }
  } catch {
    // unreachable: fall back below
  }
  return remembered[host] ? { identity: remembered[host], live: false } : null;
}

export function memoryKey(identity: CanvasIdentity): string {
  return `${identity.host}/${identity.userId}`;
}

/** The memory slot for an identity, created on first sight; names derive from host and user id. */
export function memorySlotFor(identity: CanvasIdentity): MemorySlot {
  const registry = readJson<Record<string, MemorySlot>>(MEMORIES_KEY, {});
  const key = memoryKey(identity);
  const existing = registry[key];
  if (existing) {
    // keep the display name current
    if (existing.name !== identity.name) {
      registry[key] = { ...existing, name: identity.name };
      localStorage.setItem(MEMORIES_KEY, JSON.stringify(registry));
    }
    return registry[key];
  }
  const safeHost = identity.host.replace(/[^a-z0-9.-]/gi, '_');
  const slot: MemorySlot = {
    ...identity,
    dbName: `canvas-buddy-${safeHost}-${identity.userId}`,
    chatsKey: `canvas-buddy-chats:${key}`,
    since: new Date().toISOString(),
  };
  registry[key] = slot;
  localStorage.setItem(MEMORIES_KEY, JSON.stringify(registry));
  return slot;
}

/**
 * Deletes a slot's database and chats and drops it from the registry. The database must be
 * closed first (`closeDB`); PGlite's IndexedDB name carries an internal prefix, so every
 * database whose name ends with the slot's data dir is removed.
 */
export async function forgetMemory(slot: MemorySlot): Promise<void> {
  localStorage.removeItem(slot.chatsKey);
  const registry = readJson<Record<string, MemorySlot>>(MEMORIES_KEY, {});
  delete registry[memoryKey(slot)];
  localStorage.setItem(MEMORIES_KEY, JSON.stringify(registry));

  const names = (await indexedDB.databases?.())?.map((d) => d.name).filter((n): n is string => Boolean(n)) ?? [];
  const targets = names.filter((n) => n === slot.dbName || n.endsWith(`/${slot.dbName}`));
  await Promise.all(
    targets.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        })
    )
  );
}
