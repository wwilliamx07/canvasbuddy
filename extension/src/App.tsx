import { useEffect, useMemo, useRef, useState } from 'react';
import { Shell } from './ui/Shell';
import type { AppModel, ApprovalDecision, Message } from './ui/model';
import { useConnectFlow } from './ui/useConnectFlow';
import { useMemoryExplorer } from './ui/useMemoryExplorer';
import { useConnections } from './ui/useConnections';
import { useProviderAccess } from './ui/useProviderAccess';
import { connectionTools, findToolConfig, resolveLoaded, toolLoading, toolTokens, type LoadedTool } from './connections/tools';
import { estimateTokenCount } from './utils/tokens';
import { setAlwaysAllow } from './connections/manage';
import { normalizeSettings, type AppSettings } from './settings';
import { getGraphOverviewText } from './db/graph';
import { buildSystemPrompt } from './agent/prompt';
import { activateCanvas, hasOriginPermission, releaseOriginPermission, findConnectableHost } from './canvas/connection';
import { resolveIdentity, memorySlotFor, forgetMemory, type MemorySlot } from './canvas/identity';
import { onSessionLost } from './canvas/http';
import { configureDatabase, closeDB } from './db/pglite';
import { profileFor, type CanvasProfile } from './canvas/profiles';
import { TOOL_CONFIG, toolFunctions } from './agent/tools';
import { chatMarkdown, COMMANDS, compactionNotice, dispatchCommand, type CommandContext } from './commands';
import { isAbortError } from './providers/http';
import type { ToolSpec, Usage } from './providers/types';
import { countUsage, getConversationCoverageIndex, type ChatUsage, type ContextDigest } from './agent/history';
import { contextSize, generateDigestText } from './agent/digest';
import { runAgent, type RunTools } from './agent/run';
import { newChat, readChats, snapshotOf, withSnapshot, writeStorage, type Chat, type ChatSnapshot } from './chats';

type Connection =
  | { status: 'checking'; host?: string }
  | { status: 'disconnected'; host?: string; reason?: string }
  | { status: 'connected'; host: string; profile: CanvasProfile; memory: MemorySlot; live: boolean };

const SETTINGS_KEY = 'canvas-buddy-settings';

/**
 * The app's state owner: the Canvas connection, settings, the chats and the chat on screen, and
 * the handlers the UI calls. The agent run itself is `agent/run.ts`; this file hands it a `RunHost`
 * and builds the `AppModel` the UI is written against.
 */
function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  // The chat on screen: what the UI shows and what the next run starts from
  const [view, setView] = useState<ChatSnapshot>(() => snapshotOf(null));
  const { messages, history: apiHistory, digests: contextDigests, loaded: loadedTools, usage: chatUsage, measure: contextMeasure } = view;
  const setMessages = (update: (prev: Message[]) => Message[]) => setView((v) => ({ ...v, messages: update(v.messages) }));
  const [isLoading, setIsLoading] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => normalizeSettings(null));
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connection, setConnection] = useState<Connection>({ status: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [connectNonce, setConnectNonce] = useState(0); // bumps on Connect so the same host re-resolves
  // Known instances are granted in the manifest, so Disconnect cannot release them; it just stops
  // auto-connecting for this session so the user can pick another Canvas.
  const autoConnectRef = useRef(true);
  // Chats live under the connected identity's key (canvas/identity.ts), known only once connected
  const chatsKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The chat on screen, readable from async work that outlives a render (a run, a compaction)
  const viewChatIdRef = useRef<string | null>(null);

  const loadChatIntoView = (chat: Chat | null) => {
    viewChatIdRef.current = chat?.id ?? null;
    setCurrentChatId(chat?.id ?? null);
    setView(snapshotOf(chat));
  };

  const loadChats = (key: string) => {
    chatsKeyRef.current = key;
    const loaded = readChats(key);
    setChats(loaded);
    loadChatIntoView(loaded.length > 0 ? loaded[loaded.length - 1] : null);
  };

  // Chats and settings are mirrored to localStorage whenever they change. A write can fail (the
  // origin's storage is full); that is said in the banner rather than thrown from a render.
  useEffect(() => {
    if (chatsKeyRef.current) setStorageError(writeStorage(chatsKeyRef.current, chats, 'your chats'));
  }, [chats]);

  useEffect(() => {
    const savedSettings = localStorage.getItem(SETTINGS_KEY);
    if (savedSettings) {
      try {
        setSettings(normalizeSettings(JSON.parse(savedSettings)));
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    }
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (settingsLoaded) setStorageError(writeStorage(SETTINGS_KEY, settings, 'settings'));
  }, [settings, settingsLoaded]);

  // The origin permission is optional and Chrome can revoke it, so a remembered host is
  // re-checked on every start; the Connect screen comes back whenever it is missing.
  useEffect(() => {
    if (!settingsLoaded) return;
    const host = settings.canvasHost;
    let cancelled = false;
    if (!host) {
      chatsKeyRef.current = null;
      setChats([]);
      loadChatIntoView(null);
      if (!autoConnectRef.current) {
        setConnection({ status: 'disconnected' });
        return;
      }
      // No remembered host: connect silently to the tab's Canvas or a known instance if possible
      setConnection({ status: 'checking' });
      findConnectableHost().then(({ host: found, tabHost }) => {
        if (cancelled) return;
        if (found) setCanvasHost(found);
        else setConnection({ status: 'disconnected', host: tabHost ?? undefined });
      });
      return () => {
        cancelled = true;
      };
    }
    setConnection({ status: 'checking', host });
    (async () => {
      if (!(await hasOriginPermission(host))) return { status: 'disconnected', host } as Connection;
      const profile = activateCanvas(host);
      const resolved = await resolveIdentity(host);
      if (!resolved) return { status: 'disconnected', host, reason: `Not signed in to ${host}. Sign in there, then connect again.` } as Connection;
      const memory = memorySlotFor(resolved.identity);
      configureDatabase(memory.dbName);
      return { status: 'connected', host, profile, memory, live: resolved.live } as Connection;
    })()
      .then((next) => {
        if (cancelled) return;
        if (next.status === 'connected') {
          loadChats(next.memory.chatsKey);
          setNotice(next.live ? null : `Not signed in to ${host}; showing what's remembered for ${next.memory.name}.`);
        }
        setConnection(next);
      })
      .catch((e) => {
        if (!cancelled) setConnection({ status: 'disconnected', host, reason: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // loadChats / loadChatIntoView / setCanvasHost only set state and refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, settings.canvasHost, connectNonce]);

  // A sign-in page mid-session means the session ended or another account signed in. The
  // database stays that of the identity it was opened for; a different account is never mixed in.
  useEffect(() => {
    if (connection.status !== 'connected') {
      onSessionLost(null);
      return;
    }
    const { host, memory } = connection;
    let checking = false;
    onSessionLost(() => {
      if (checking) return;
      checking = true;
      resolveIdentity(host)
        .then((resolved) => {
          if (!resolved || !resolved.live) setNotice(`Not signed in to ${host}; showing what's remembered for ${memory.name}.`);
          else if (resolved.identity.userId !== memory.userId) setNotice(`Signed in as ${resolved.identity.name}. Reload to switch memory.`);
        })
        .finally(() => {
          checking = false;
        });
    });
    return () => onSessionLost(null);
  }, [connection]);

  const setCanvasHost = (host: string) => setSettings((prev) => ({ ...prev, canvasHost: host }));

  const handleConnected = (host: string) => {
    // The effect above resolves the identity and opens its memory
    autoConnectRef.current = true;
    setCanvasHost(host);
    setConnectNonce((n) => n + 1);
  };

  const handleDeleteAccountData = async () => {
    if (connection.status !== 'connected') return;
    const { memory } = connection;
    if (!window.confirm(`Delete everything CanvasBuddy has for ${memory.name} (${memory.host})? Courses, documents and chats for this account will be removed from this browser.`)) return;
    await closeDB();
    await forgetMemory(memory);
    window.location.reload();
  };

  const handleDisconnect = () => {
    if (connection.status === 'connected') void releaseOriginPermission(connection.host);
    autoConnectRef.current = false;
    setCanvasHost('');
  };

  const connect = useConnectFlow(handleConnected, {
    enabled: connection.status === 'disconnected',
    initialError: connection.status === 'disconnected' ? connection.reason : undefined,
  });
  const memory = useMemoryExplorer(connection.status === 'connected');
  const connections = useConnections();
  const providerAccess = useProviderAccess(settings);

  // Tools of the enabled, working connections. Small setups declare them all on every call; past
  // EAGER_CONNECTION_TOKENS they load on demand through find_connection_tools (connections/tools.ts).
  // Recomputed only when a connection record changes, not on every paint of a streaming answer.
  const toolSetup = useMemo(() => {
    const live = connectionTools(connections.records);
    const loadingMode = toolLoading(live);
    const findTool = loadingMode === 'lazy' ? findToolConfig(live) : null;
    return {
      live,
      loadingMode,
      findTool,
      findToolTokens: findTool ? estimateTokenCount(JSON.stringify(findTool)) : 0,
      services: [...new Set(live.map((t) => t.connection.name))],
    };
  }, [connections.records]);
  const { live: liveTools, loadingMode, findTool, findToolTokens } = toolSetup;
  const loadLimits = { max: Math.max(1, settings.loadedToolsMax), tokenBudget: Math.max(500, settings.loadedToolsTokenBudget) };

  /** The connection tools one model call declares, given the chat's loaded set, in load order. */
  const declaredConnectionTools = (loaded: LoadedTool[]) => (findTool ? resolveLoaded(liveTools, loaded) : liveTools);
  const runTools: RunTools = {
    builtIn: toolFunctions,
    live: liveTools,
    findTool,
    loadLimits,
    declared: (loaded): ToolSpec[] => [
      ...TOOL_CONFIG,
      ...(findTool ? [findTool] : []),
      ...declaredConnectionTools(loaded).map(({ name, description, parameters }) => ({ name, description, parameters })),
    ],
    declaredTokens: (loaded) => findToolTokens + toolTokens(declaredConnectionTools(loaded)),
  };

  // Fixed for the session (until a connection changes), so the prompt + tool schemas stay a cacheable prefix
  const promptIntro = connection.status === 'connected' ? connection.profile.promptIntro(connection.host) : profileFor('').promptIntro('');
  const systemPrompt = useMemo(
    () => buildSystemPrompt(promptIntro, toolSetup.services, loadingMode === 'lazy' ? 'lazy' : 'eager'),
    [promptIntro, toolSetup.services, loadingMode]
  );

  const saveCurrentChat = (chatId: string, snapshot: ChatSnapshot) => {
    setChats((prev) => prev.map((chat) => (chat.id === chatId ? withSnapshot(chat, snapshot) : chat)));
  };

  const createNewChat = (): string => {
    const chat = newChat();
    setChats((prev) => [...prev, chat]);
    loadChatIntoView(chat);
    return chat.id;
  };

  /**
   * Leaving the chat a run (or compaction) works on stops it: a run belongs to one chat, and a
   * second one cannot start until it has ended. The run then saves itself and paints nothing more.
   */
  const leaveBusyChat = (): boolean => {
    const busy = runningRef.current || compactingRef.current;
    if (busy) handleStop();
    return busy;
  };

  const startNewChat = () => {
    leaveBusyChat();
    createNewChat();
  };

  const switchChat = (chatId: string) => {
    if (chatId === currentChatId) return;
    // A run saves its own chat; the view of a running chat may be mid-step
    if (!leaveBusyChat() && currentChatId) saveCurrentChat(currentChatId, view);
    const chat = chats.find((c) => c.id === chatId);
    if (chat) loadChatIntoView(chat);
  };

  const deleteChat = (chatId: string) => {
    if (chatId === runChatIdRef.current) leaveBusyChat();
    const remaining = chats.filter((c) => c.id !== chatId);
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    if (currentChatId === chatId) loadChatIntoView(remaining.length > 0 ? remaining[remaining.length - 1] : null);
  };

  // The context meter; estimating walks the whole history, so not on every paint of a streaming answer
  const viewToolTokens = runTools.declaredTokens(loadedTools);
  const currentContext = useMemo(
    () => (currentChatId ? contextSize(apiHistory, contextDigests, contextMeasure, systemPrompt, viewToolTokens) : { tokens: 0, measured: false }),
    [currentChatId, apiHistory, contextDigests, contextMeasure, systemPrompt, viewToolTokens]
  );

  // The steering slot: one message sent mid-run, shown at the end of the transcript until the loop
  // reads it. Refs, because the running loop and the composer belong to different renders.
  const queuedRef = useRef<Message | null>(null);
  const runningRef = useRef(false);
  // The chat the run (or compaction) in flight belongs to; it paints only while that chat is on screen
  const runChatIdRef = useRef<string | null>(null);

  const withQueued = (msgs: Message[]): Message[] => (queuedRef.current ? [...msgs, queuedRef.current] : msgs);

  const queueMessage = (content: string) => {
    const queued: Message = { id: queuedRef.current?.id ?? Date.now().toString(), role: 'user', content, timestamp: new Date(), queued: true };
    queuedRef.current = queued;
    setMessages((prev) => [...prev.filter((m) => !m.queued), queued]);
    if (continueRef.current) respondToContinue(true); // a message sent while asked to continue means go on, with it
  };

  /** Empties the slot; its message comes back as an ordinary user message. */
  const takeQueued = (): Message | null => {
    const queued = queuedRef.current;
    if (!queued) return null;
    queuedRef.current = null;
    setMessages((prev) => prev.filter((m) => !m.queued));
    const { queued: _queued, ...message } = queued;
    return message;
  };

  // A connection tool that changes something waits here for the student's answer
  const approvalRef = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const awaitApproval = () => new Promise<ApprovalDecision>((resolve) => (approvalRef.current = resolve));
  const respondToApproval = (decision: ApprovalDecision) => {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    resolve?.(decision);
  };

  // After settings.toolRoundsBeforeAsking rounds without an answer the loop waits here: keep going or stop
  const continueRef = useRef<((keepGoing: boolean) => void) | null>(null);
  const [continuePrompt, setContinuePrompt] = useState<{ rounds: number } | null>(null);
  const awaitContinue = (rounds: number) =>
    new Promise<boolean>((resolve) => {
      continueRef.current = resolve;
      setContinuePrompt({ rounds });
    });
  const respondToContinue = (keepGoing: boolean) => {
    const resolve = continueRef.current;
    continueRef.current = null;
    setContinuePrompt(null);
    resolve?.(keepGoing);
  };

  const handleStop = () => {
    takeQueued();
    abortRef.current?.abort();
    respondToApproval('deny'); // the loop sees the abort once the approval wait returns
    respondToContinue(false); // likewise
  };

  // ---------------------------------------------------------------------------
  // Commands (src/commands.ts): run by the app, never sent to the model
  // ---------------------------------------------------------------------------

  const compactingRef = useRef(false);

  /** A command's outcome as a muted transcript line; saved with the chat when there is one. */
  const appendNotice = (text: string, extra: { digests?: ContextDigest[]; usage?: ChatUsage; noticeUsage?: Usage } = {}) => {
    const notice: Message = { id: `notice-${Date.now()}`, role: 'assistant', content: text, timestamp: new Date(), notice: true, ...(extra.noticeUsage ? { usage: extra.noticeUsage } : {}) };
    const next: ChatSnapshot = {
      ...view,
      messages: [...messages.filter((m) => !m.queued), notice],
      digests: extra.digests ?? contextDigests,
      usage: extra.usage ?? chatUsage,
    };
    setView(next);
    if (currentChatId) saveCurrentChat(currentChatId, next); // no chat yet: shown, not kept
  };

  const canCompact = Boolean(currentChatId) && apiHistory.length - 1 > getConversationCoverageIndex(contextDigests);

  /**
   * /compact: one digest over every un-digested turn, the latest included, so the next turn starts
   * from the digests alone. Stop aborts it; messages are refused (not queued) meanwhile.
   */
  const compactChat = async (focus: string) => {
    const chatId = currentChatId!;
    const covered = getConversationCoverageIndex(contextDigests);
    const remaining = apiHistory.slice(covered + 1);
    const before = contextSize(apiHistory, contextDigests, contextMeasure, systemPrompt, viewToolTokens).tokens;
    const abort = new AbortController();
    abortRef.current = abort;
    compactingRef.current = true;
    runChatIdRef.current = chatId;
    setIsLoading(true);
    try {
      const digest = await generateDigestText(remaining, settings, focus, abort.signal);
      const usage = countUsage(chatUsage, 'digest', digest.usage);
      if (viewChatIdRef.current !== chatId) return; // the student moved to another chat meanwhile
      if (!digest.text) {
        appendNotice('The model returned an empty summary; nothing was compacted.', { usage, noticeUsage: digest.usage });
        return;
      }
      const digests: ContextDigest[] = [
        ...contextDigests,
        { id: `digest-${Date.now()}`, kind: 'conversation', content: digest.text, createdAt: new Date(), coversUpToIndex: apiHistory.length - 1 },
      ];
      const after = contextSize(apiHistory, digests, contextMeasure, systemPrompt, viewToolTokens).tokens;
      appendNotice(compactionNotice(remaining.length, before, after), { digests, usage, noticeUsage: digest.usage });
    } catch (error) {
      if (viewChatIdRef.current === chatId && !isAbortError(error)) {
        appendNotice(`Compaction failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    } finally {
      abortRef.current = null;
      compactingRef.current = false;
      runChatIdRef.current = null;
      setIsLoading(false);
    }
  };

  const exportChat = () => {
    const title = chats.find((c) => c.id === currentChatId)?.title ?? 'CanvasBuddy chat';
    const url = URL.createObjectURL(new Blob([chatMarkdown(title, messages)], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'chat'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const commandContext: CommandContext = {
    notice: (text) => appendNotice(text),
    newChat: startNewChat,
    compact: compactChat,
    canCompact: () => canCompact,
    exportChat,
    hasChat: () => messages.some((m) => !m.queued && !m.notice),
    usage: () => chatUsage,
    tools: () => ({
      mode: loadingMode,
      loaded: declaredConnectionTools(loadedTools).map((t) => ({ name: t.name, label: t.label })),
      total: liveTools.length,
      max: loadLimits.max,
    }),
    unloadTool: (query) => {
      const q = query.toLowerCase();
      const match = resolveLoaded(liveTools, loadedTools).find(
        (t) => t.name.toLowerCase() === q || t.tool.name.toLowerCase() === q || t.label.toLowerCase() === q
      );
      if (!match) return null;
      const next: ChatSnapshot = { ...view, loaded: loadedTools.filter((l) => !(l.connectionId === match.connection.id && l.tool === match.tool.name)) };
      setView(next);
      if (currentChatId) saveCurrentChat(currentChatId, next);
      return match.label;
    },
  };

  /** A `/command` runs here; anything else starts a run or waits in the steering slot. */
  const handleSendMessage = (content: string): string | null => {
    if (compactingRef.current) return 'Compacting… send once it is done.';
    // The run of the chat just left is still winding down (it was stopped)
    if (runningRef.current && runChatIdRef.current !== viewChatIdRef.current) return 'Stopping the previous answer… send again in a moment.';
    const command = dispatchCommand(content, commandContext, runningRef.current);
    if (command.handled) return command.refused ?? null;
    if (runningRef.current) queueMessage(content);
    else void runConversation(content);
    return null;
  };

  /** Starts a run of the agent on the chat on screen (a new chat when there is none). */
  const runConversation = async (content: string) => {
    runningRef.current = true;
    setIsLoading(true);
    const start = currentChatId ? view : snapshotOf(null);
    const chatId = currentChatId ?? createNewChat();
    runChatIdRef.current = chatId;
    const abort = new AbortController();
    abortRef.current = abort;
    // Leaving the chat stops the run (leaveBusyChat), but its last steps still land after that:
    // they are saved to this chat and painted only while it is the one on screen
    const inView = () => viewChatIdRef.current === chatId;
    try {
      await runAgent(
        {
          settings,
          systemPrompt,
          tools: runTools,
          signal: abort.signal,
          paint: (msgs) => {
            if (inView()) setMessages(() => withQueued(msgs));
          },
          save: (snapshot) => {
            saveCurrentChat(chatId, snapshot);
            if (inView()) setView({ ...snapshot, messages: withQueued(snapshot.messages) });
          },
          takeQueued,
          awaitApproval,
          awaitContinue,
          allowAlways: (tool) => void setAlwaysAllow(tool.connection.id, tool.tool.name, true),
          courseOverview: () =>
            getGraphOverviewText().catch((e) => {
              console.warn('Course overview unavailable:', e);
              return null;
            }),
        },
        start,
        { id: Date.now().toString(), role: 'user', content, timestamp: new Date() }
      );
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      runChatIdRef.current = null;
      setIsLoading(false);
      memory.reload(); // the Memory sheet shows what this run brought in
    }
  };

  // Everything the UI sees; nothing under src/ui reaches past this object
  const model: AppModel = {
    chats: chats.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    currentChatId,
    messages,
    isLoading,
    sendMessage: handleSendMessage,
    commands: COMMANDS,
    editQueued: () => takeQueued()?.content ?? null,
    stop: handleStop,
    respondToApproval,
    continuePrompt,
    respondToContinue,
    newChat: startNewChat,
    selectChat: switchChat,
    deleteChat,

    settings,
    updateSettings: setSettings,
    currentContextTokens: currentContext.tokens,
    contextTokensMeasured: currentContext.measured,
    canCompact: canCompact && !isLoading,
    compactNow: () => void handleSendMessage('/compact'),

    connection:
      connection.status === 'connected'
        ? { status: 'connected', host: connection.host, profileName: connection.profile.name, memoryName: connection.memory.name }
        : connection,
    notice: storageError ? { text: storageError, reload: false } : notice ? { text: notice, reload: true } : null,
    reload: () => window.location.reload(),
    connect,
    disconnect: handleDisconnect,
    deleteAccountData: () => void handleDeleteAccountData(),

    memory,
    connections: connections.model,
    providerAccess,
  };

  return <Shell model={model} />;
}

export default App;
