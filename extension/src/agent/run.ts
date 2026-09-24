import type { AppSettings } from '../settings';
import type { ApprovalDecision, Message, Step } from '../ui/model';
import type { ChatSnapshot } from '../chats';
import { callModel } from '../providers';
import { isAbortError } from '../providers/http';
import type { ToolSpec, Usage } from '../providers/types';
import {
  applyLoad,
  FIND_TOOL_NAME,
  runConnectionTool,
  runFindConnectionTools,
  runsWithoutAsking,
  unknownToolResult,
  type ConnectionTool,
} from '../connections/tools';
import type { ToolFn } from './tools';
import { digestToThreshold } from './digest';
import {
  addUsage,
  buildApiHistory,
  capHistory,
  clip,
  countUsage,
  describeToolCall,
  getConversationCoverageIndex,
  joinText,
  MAX_OUTPUT_TOKENS,
  STEP_DETAIL_MAX,
  toolStepOutcome,
  type ToolResult,
} from './history';

/**
 * One run of the agent: the student's message, then model calls and tool rounds until the answer.
 * A message queued mid-run (steering) is injected after the current step's tool results — never
 * between a tool-call turn and its results; one queued while the model writes its final answer
 * becomes the next turn of the same run. Everything the run needs from the app comes through
 * `RunHost`, so the loop has no React state and is tested with fakes (`test/agent/run.test.ts`).
 * See `reference/02-agent-loop.md`.
 */

/** The tools a run declares and dispatches. */
export interface RunTools {
  /** Built-in tools by name (`toolFunctions`). */
  builtIn: Record<string, ToolFn>;
  /** Connection tools that are live (enabled, working, switched on). */
  live: ConnectionTool[];
  /** `find_connection_tools` when connection tools load on demand; null when all are declared (or none). */
  findTool: ToolSpec | null;
  loadLimits: { max: number; tokenBudget: number };
  /** What one model call declares, given the chat's loaded set. */
  declared(loaded: ChatSnapshot['loaded']): ToolSpec[];
  /** Estimated tokens of the connection-tool part of that declaration. */
  declaredTokens(loaded: ChatSnapshot['loaded']): number;
}

export interface RunHost {
  settings: AppSettings;
  systemPrompt: string;
  tools: RunTools;
  signal: AbortSignal;
  /** Shows the chat's transcript (the host adds the queued message, and paints nothing while another chat is on screen). */
  paint(messages: Message[]): void;
  /** Saves the chat (and mirrors it into the view while it is on screen). */
  save(snapshot: ChatSnapshot): void;
  /** Empties the steering slot; its message, or null. */
  takeQueued(): Message | null;
  /** Waits for the student's answer to a connection tool that changes something. */
  awaitApproval(): Promise<ApprovalDecision>;
  /** Waits after `rounds` rounds of tool calls without an answer: keep going, or end the turn. */
  awaitContinue(rounds: number): Promise<boolean>;
  /** "Always allow": stored with the tool's connection. */
  allowAlways(tool: ConnectionTool): void;
  /** The course roster that rides on the latest user turn; null when unavailable. */
  courseOverview(): Promise<string | null>;
  /** Paint scheduling while text streams; one paint per animation frame by default. */
  frame?: { request(paint: () => void): number; cancel(handle: number): void };
}

const stopped = () => new DOMException('Stopped by the user', 'AbortError');

const animationFrame = {
  request: (paint: () => void) => requestAnimationFrame(paint),
  cancel: (handle: number) => cancelAnimationFrame(handle),
};

export async function runAgent(host: RunHost, start: ChatSnapshot, first: Message): Promise<void> {
  const { settings, systemPrompt, tools, signal } = host;
  const frame = host.frame ?? animationFrame;
  const liveByName = new Map(tools.live.map((t) => [t.name, t]));

  let { messages, history, digests, loaded, usage, measure } = start;
  const snapshot = (): ChatSnapshot => ({ messages, history, digests, loaded, usage, measure });
  const show = () => host.paint(messages);
  const save = () => host.save(snapshot());

  /** Adds tools to the chat's loaded set (or marks them used); a no-op when every tool is declared anyway. */
  const load = (found: ConnectionTool[]) => {
    if (!tools.findTool || !found.length) return;
    loaded = applyLoad(loaded, found, tools.live, tools.loadLimits);
  };

  // The assistant bubble of the current user turn collects the steps and text of every model
  // call until the answer; while open it is the last message.
  let bubbleId: string | null = null;
  let bubbleTime = new Date();
  let doneText = ''; // visible text of the bubble's finished model calls
  let callText = ''; // text of the model call in flight, kept so an interrupted call is not lost
  let steps: Step[] = [];
  let paintHandle = 0;
  // Tokens of the open bubble's model calls; digests run before a bubble opens (pending) or after
  // it closed (added to that bubble), and count toward the turn that triggered them
  let bubbleUsage: Usage | undefined;
  let pendingUsage: Usage | undefined;
  let lastBubbleId: string | null = null;

  const paint = () => {
    paintHandle = 0;
    if (!bubbleId) return;
    const bubble: Message = {
      id: bubbleId,
      role: 'assistant',
      content: joinText(doneText, callText),
      timestamp: bubbleTime,
      streaming: true,
      ...(steps.length ? { steps: [...steps] } : {}),
    };
    messages = [...messages.slice(0, -1), bubble];
    show();
  };
  const schedulePaint = () => {
    if (!paintHandle) paintHandle = frame.request(paint);
  };
  const cancelPaint = () => {
    if (paintHandle) frame.cancel(paintHandle);
    paintHandle = 0;
  };
  const openBubble = () => {
    bubbleId = (Date.now() + Math.random()).toString();
    bubbleTime = new Date();
    doneText = '';
    callText = '';
    steps = [];
    bubbleUsage = pendingUsage;
    pendingUsage = undefined;
    messages = [...messages, { id: bubbleId, role: 'assistant', content: '', timestamp: bubbleTime, streaming: true }];
    show();
  };
  /** Ends the bubble with whatever text arrived and its steps settled; an empty one is dropped. */
  const closeBubble = (interrupted: boolean) => {
    cancelPaint();
    if (!bubbleId) return;
    const text = joinText(doneText, callText);
    const settled = steps.map((s): Step =>
      s.status !== 'running' && s.status !== 'awaiting'
        ? s
        : interrupted && s.kind === 'tool'
          ? { ...s, status: 'error', result: 'Interrupted before it finished.' }
          : { ...s, status: 'done' }
    );
    const kept = Boolean(text || settled.length);
    messages = kept
      ? [
          ...messages.slice(0, -1),
          {
            id: bubbleId,
            role: 'assistant',
            content: text,
            timestamp: bubbleTime,
            ...(settled.length ? { steps: settled } : {}),
            ...(bubbleUsage ? { usage: bubbleUsage } : {}),
          },
        ]
      : messages.slice(0, -1);
    lastBubbleId = kept ? bubbleId : null;
    bubbleId = null;
    bubbleUsage = undefined;
    show();
  };
  /** Digest calls of this turn: they count toward the chat and toward the turn's bubble. */
  const countDigests = (calls: Array<Usage | undefined>) => {
    for (const u of calls) {
      usage = countUsage(usage, 'digest', u);
      if (bubbleId) bubbleUsage = addUsage(bubbleUsage, u);
      else if (lastBubbleId) messages = messages.map((m) => (m.id === lastBubbleId ? { ...m, usage: addUsage(m.usage, u) } : m));
      else pendingUsage = addUsage(pendingUsage, u);
    }
    if (calls.length) show();
  };
  const digest = async () => {
    const result = await digestToThreshold({
      history,
      digests,
      measure,
      systemPrompt,
      connectionToolTokens: tools.declaredTokens(loaded),
      settings,
      signal,
    });
    digests = result.digests;
    countDigests(result.usage);
  };

  /** Runs one call the model made; like every tool, the result is a JSON string and nothing throws. */
  const allowedThisRun = new Set<string>(); // "Always allow" applies at once, before the stored record updates
  const runTool = async (call: { name: string; args: Record<string, unknown> }, stepIndex: number): Promise<string> => {
    const stringArgs = () => Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, value == null ? '' : String(value)]));
    if (call.name === FIND_TOOL_NAME && tools.findTool) {
      const found = runFindConnectionTools(tools.live, loaded, stringArgs(), tools.loadLimits);
      load(found.load);
      return found.result;
    }
    const connectionTool = liveByName.get(call.name);
    if (connectionTool) {
      // Called directly (loaded, or named without a search): it is used, so it stays / becomes loaded
      load([connectionTool]);
      if (!runsWithoutAsking(connectionTool) && !allowedThisRun.has(call.name)) {
        steps[stepIndex] = { ...steps[stepIndex], status: 'awaiting' };
        paint();
        const decision = await host.awaitApproval();
        if (signal.aborted) throw stopped();
        steps[stepIndex] = { ...steps[stepIndex], status: 'running' };
        paint();
        if (decision === 'deny') return JSON.stringify({ error: 'The student declined this action.' });
        if (decision === 'always') {
          allowedThisRun.add(call.name);
          host.allowAlways(connectionTool);
        }
      }
      return runConnectionTool(connectionTool, call.args, signal);
    }
    const builtIn = tools.builtIn[call.name];
    if (!builtIn) return unknownToolResult(call.name, tools.live);
    try {
      return await builtIn(stringArgs(), settings);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  };

  let next: Message | null = first;
  while (next) {
    const userMessage: Message = next;
    next = null;
    messages = [...messages, userMessage];
    history = [...history, { role: 'user', content: userMessage.content }];
    lastBubbleId = null; // digests from here on belong to this turn
    show();

    try {
      await digest();
      save();
      const courseOverview = await host.courseOverview();

      /** Steering: a queued message is read between steps as an ordinary user turn; the answer after it gets its own bubble. */
      const readSteer = (): boolean => {
        const steer = host.takeQueued();
        if (!steer) return false;
        closeBubble(false);
        messages = [...messages, steer];
        history = [...history, { role: 'user', content: steer.content }];
        show();
        return true;
      };

      let toolRounds = 0; // since the last user turn or "keep going"
      let totalRounds = 0;
      while (true) {
        if (toolRounds >= Math.max(1, settings.toolRoundsBeforeAsking)) {
          const keepGoing = await host.awaitContinue(totalRounds);
          if (signal.aborted) throw stopped();
          if (!keepGoing) break; // ends the turn like an answer would, keeping the tool turns
          toolRounds = 0;
          readSteer(); // a message sent while asked is what continued the run
        }

        if (!bubbleId) openBubble();
        callText = '';
        let thoughtIndex = -1; // this call's thought step
        const onThought = (text: string) => {
          if (thoughtIndex < 0) {
            thoughtIndex = steps.length;
            steps = [...steps, { kind: 'thought', label: '', status: 'running' }];
          }
          steps[thoughtIndex] = { ...steps[thoughtIndex], label: steps[thoughtIndex].label + text };
          schedulePaint();
        };
        const settleNotices = () => {
          steps = steps.map((s): Step => (s.kind === 'notice' && s.status === 'running' ? { ...s, status: 'done' } : s));
        };

        const sentHistoryLength = history.length;
        const result = await callModel(
          settings,
          {
            messages: buildApiHistory(history, digests, systemPrompt, courseOverview),
            // Recomputed per call: a search in the previous step may have loaded tools
            tools: tools.declared(loaded),
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinking: settings.showReasoning,
          },
          {
            signal,
            onRetry: (seconds) => {
              settleNotices();
              steps = [...steps, { kind: 'notice', label: `Rate limited — retrying in ${seconds} s`, status: 'running' }];
              paint();
            },
            onDelta: (text) => {
              callText += text;
              schedulePaint();
            },
            ...(settings.showReasoning ? { onThought } : {}),
          }
        );
        cancelPaint();
        if (thoughtIndex >= 0) steps[thoughtIndex] = { ...steps[thoughtIndex], status: 'done' };
        settleNotices();
        usage = countUsage(usage, 'answer', result.usage);
        bubbleUsage = addUsage(bubbleUsage, result.usage);
        if (result.usage) {
          measure = { input: result.usage.input, historyLength: sentHistoryLength, coverage: getConversationCoverageIndex(digests) };
        }

        const calls = result.toolCalls;
        doneText = joinText(doneText, result.text);
        callText = '';
        const firstToolStep = steps.length;
        steps = [
          ...steps,
          ...calls.map((c): Step => ({
            kind: 'tool',
            label: liveByName.get(c.name)?.label ?? describeToolCall(c.name, c.args),
            detail: clip(JSON.stringify(c.args), STEP_DETAIL_MAX),
            status: 'running',
          })),
        ];
        paint();

        history = [
          ...history,
          {
            role: 'assistant',
            content: result.text || '',
            ...(calls.length > 0 ? { toolCalls: calls } : {}),
            ...(result.thoughtSignature ? { thoughtSignature: result.thoughtSignature } : {}),
            ...(result.replay ? { replay: result.replay } : {}),
          },
        ];

        if (calls.length === 0) break;

        toolRounds += 1;
        totalRounds += 1;
        const toolResults: ToolResult[] = [];
        for (const [i, call] of calls.entries()) {
          if (signal.aborted) throw stopped();
          const output = await runTool(call, firstToolStep + i);
          toolResults.push({ id: call.id, name: call.name, result: output });
          steps[firstToolStep + i] = { ...steps[firstToolStep + i], ...toolStepOutcome(output) };
          paint();
        }
        history = [...history, { role: 'user', content: '', toolResults }];

        // A message queued during this step is read now, next to the results it may correct
        if (readSteer()) toolRounds = 0;
      }
      closeBubble(false);

      // Persist real tool turns (results capped) so the next turn has them without a digest call
      ({ history, measure } = capHistory(history, measure));
      await digest();
      save();
    } catch (error) {
      const aborted = isAbortError(error);
      if (!aborted) console.error('Error calling API:', error);
      const partialText = callText;
      closeBubble(true); // keeps the interrupted call's text
      callText = '';
      if (!aborted) {
        const text = `Error: ${error instanceof Error ? error.message : 'Failed to get response from AI'}`;
        messages = [...messages, { id: (Date.now() + 1).toString(), role: 'assistant', content: text, timestamp: new Date() }];
      }
      // A tool-call turn without results would make the next request malformed: keep its text as
      // a plain turn (what the user saw) and drop the calls. An interrupted turn keeps its text.
      const capped = capHistory(history, measure);
      measure = capped.measure;
      const last = capped.history[capped.history.length - 1];
      history = last?.toolCalls?.length
        ? [...capped.history.slice(0, -1), ...(last.content ? [{ role: 'assistant' as const, content: last.content }] : [])]
        : capped.history;
      if (partialText) history = [...history, { role: 'assistant', content: partialText }];
      show();
      save();
      if (aborted) return; // Stop also emptied the slot
    }

    // A message queued while the model wrote its final answer is the next turn
    next = host.takeQueued();
  }
}
