/**
 * The contract the UI is written against. `App.tsx` builds one `AppModel` from its state and
 * handlers and hands it to `Shell`; nothing under `src/ui` reaches past this object (no direct
 * data access, no Canvas calls). New data reaches the UI by extending this type (and the hook or
 * `App` code that fills it) first, then the component.
 */

import type { CollectionKind, FreshnessSettings } from '../canvas/freshness';
import type { AppSettings } from '../settings';
import type { Usage } from '../providers/types';
import type { CommandInfo } from '../commands';
import type { CatalogEntry } from '../connections/catalog';
import type { ActiveTab } from '../canvas/connection';
import type { GraphStats } from '../types/canvas';

export type { CollectionKind, FreshnessSettings } from '../canvas/freshness';
export { DEFAULT_FRESHNESS } from '../canvas/freshness';
export type { AppSettings } from '../settings';
export { DEFAULT_SETTINGS } from '../settings';
// The provider and model catalogs are static data the Settings sheet renders from
export type { ProviderId, Usage } from '../providers/types';
export type { CommandInfo } from '../commands';
export { PROVIDERS, providerInfo, type ProviderInfo } from '../providers/registry';
export { isKnown768Embedding, modelInfo } from '../providers/models';

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * One thing the assistant did while working on an answer: a model thought (Gemini, when the
 * reasoning setting is on) or a tool call. Persisted with the chat, text fields capped.
 */
export interface Step {
  /** `notice`: a line from the loop itself, e.g. a rate-limit wait. */
  kind: 'thought' | 'tool' | 'notice';
  /** Thought: the thought text (Markdown). Tool: one line, e.g. `Listing assignments "CSC263"`. */
  label: string;
  /** Tool: the call's arguments as compact JSON. */
  detail?: string;
  /** Tool: the first ~300 characters of the result, or the error message. */
  result?: string;
  /** `awaiting`: a connection tool that changes something is waiting for the student's approval. */
  status?: 'running' | 'awaiting' | 'done' | 'error';
}

/** The answer to an approval request: run it once, run this tool from now on without asking, or don't. */
export type ApprovalDecision = 'allow' | 'always' | 'deny';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** The assistant is still working on this bubble (typing dots while empty, caret while text grows). Transient: never persisted. */
  streaming?: boolean;
  /** A user message sent mid-run, waiting in the steering slot until the loop reads it. Transient: never persisted. */
  queued?: boolean;
  /** Assistant: thoughts and tool calls of the run that produced this bubble, in order. Persisted. */
  steps?: Step[];
  /** Assistant: tokens the provider reported for this turn's model calls (and digests it triggered). Persisted. */
  usage?: Usage;
  /** A command's outcome ("Compacted 42 messages …"): shown as a muted line, persisted, never sent to the model. */
  notice?: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The rows of the Freshness section, in display order. */
export const FRESHNESS_FIELDS: Array<{ key: keyof FreshnessSettings; label: string; hint: string }> = [
  { key: 'courses', label: 'Courses', hint: 'enrolled course list' },
  { key: 'modules', label: 'Modules & items', hint: 'course structure' },
  { key: 'assignments', label: 'Assignments', hint: 'names, due dates, points' },
  { key: 'files', label: 'Files', hint: 'course Files list' },
  { key: 'pages', label: 'Pages', hint: 'wiki page list' },
  { key: 'home', label: 'Home page', hint: 'course front page and what it links to' },
  { key: 'submissions', label: 'Submissions', hint: 'your grades & submission status' },
  { key: 'announcements', label: 'Announcements', hint: '' },
  { key: 'discussions', label: 'Discussions', hint: 'forum topics; replies are read on demand' },
  { key: 'quizzes', label: 'Quizzes', hint: 'time limits, attempts, availability' },
  { key: 'syllabus', label: 'Syllabus', hint: 'the Syllabus tab body' },
  { key: 'planner', label: 'Planner', hint: 'cross-course to-do window' },
  { key: 'inbox', label: 'Inbox', hint: 'conversations & messages' },
  { key: 'probeDebounce', label: 'Probe debounce', hint: 'skip re-checking a collection checked this recently' },
  { key: 'unavailableRetry', label: 'Unavailable retry', hint: 'how long to remember a course hides a collection' },
];

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type Connection =
  | { status: 'checking'; host?: string }
  | { status: 'disconnected'; host?: string; reason?: string }
  | { status: 'connected'; host: string; profileName: string; memoryName: string };

/** The current tab as the Connect screen sees it (`canvas/connection.ts` → `inspectActiveTab`). */
export interface TabInspection extends ActiveTab {
  /** Profile name when the host is a known deployment ("Quercus"), else null. */
  profileName: string | null;
}

/** The Connect screen's state machine. */
export interface ConnectModel {
  /** null while inspecting the current tab. */
  tab: TabInspection | null;
  busy: boolean;
  error: string | null;
  /** Re-inspect the current tab ("Check again"). */
  inspect: () => void;
  /** "Grant access to <host>": request the origin, verify the session, connect. */
  grant: () => void;
}

// ---------------------------------------------------------------------------
// Memory — a view of what the engine has remembered. The user can only forget.
// ---------------------------------------------------------------------------

export type { GraphStats } from '../types/canvas';

export interface CourseSummary {
  course_id: string;
  name: string;
  course_code: string | null;
  term: string | null;
  module_count: number;
  assignment_count: number;
  indexed_document_count: number;
}

/** One line of "what is remembered" for a course: a collection, its size, and its sync state. */
export interface CollectionStatus {
  kind: CollectionKind;
  label: string;
  /** Rows remembered locally; null when the collection has no countable rows (home, syllabus). */
  count: number | null;
  /** 'never' = no sync_state row yet; 'unavailable' = the course hides it (403/404). */
  status: 'ok' | 'unavailable' | 'never' | 'error';
  syncedAt: Date | null;
  error?: string;
}

export type ModuleItemType = 'File' | 'Page' | 'Assignment' | 'Discussion' | 'Quiz' | 'ExternalUrl' | 'ExternalTool' | 'SubHeader';

export interface ModuleItemNode {
  node_type: 'module_item';
  node_id: string;
  label: string;
  item_type: ModuleItemType;
  /** file id / page slug / assignment id, depending on item_type. */
  content_ref: string | null;
  html_url: string | null;
  indexed: boolean;
}

export interface ModuleNode {
  node_type: 'module';
  node_id: string;
  label: string;
  items: ModuleItemNode[];
}

export interface AssignmentRow {
  node_type: 'assignment';
  assignment_id: string;
  name: string;
  due_at: string | null;
  points_possible: number | null;
  html_url: string | null;
  submission_state?: 'submitted' | 'graded' | 'unsubmitted' | null;
  score?: number | null;
  indexed: boolean;
}

export interface PageRow {
  node_type: 'page';
  page_url: string;
  title: string;
  front_page: boolean;
  html_url: string | null;
  indexed: boolean;
}

export interface FileRow {
  node_type: 'file';
  file_id: string;
  display_name: string;
  content_type: string | null;
  size: number | null;
  total_chunks: number;
  html_url: string | null;
  indexed: boolean;
}

export interface AnnouncementRow {
  announcement_id: string;
  title: string;
  posted_at: string | null;
  author: string | null;
}

export interface DiscussionRow {
  discussion_id: string;
  title: string;
  reply_count: number;
  last_reply_at: string | null;
  replies_read: boolean;
}

export interface QuizRow {
  quiz_id: string;
  title: string;
  due_at: string | null;
  points_possible: number | null;
  question_count: number | null;
}

/** Anything the inspector can show. */
export type MemoryNode = ModuleNode | ModuleItemNode | AssignmentRow | PageRow | FileRow;

export interface Chunk {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  page_end: number | null;
  /** What page_number counts: page, slide or section */
  page_kind: string;
  content: string;
}

export interface CourseMemory {
  course: CourseSummary;
  collections: CollectionStatus[];
  modules: ModuleNode[];
  assignments: AssignmentRow[];
  pages: PageRow[];
  /** Files known for this course that sit in no module. */
  looseFiles: FileRow[];
  announcements: AnnouncementRow[];
  discussions: DiscussionRow[];
  quizzes: QuizRow[];
  /** Whether a syllabus body is remembered. */
  hasSyllabus: boolean;
}

export interface MemoryModel {
  stats: GraphStats;
  courses: CourseSummary[];
  selectedCourseId: string | null;
  selectCourse: (id: string | null) => void;
  /** null until a course is selected and loaded. */
  course: CourseMemory | null;
  loadingCourse: boolean;
  loadError: string | null;

  selectedNode: MemoryNode | null;
  selectNode: (node: MemoryNode | null) => void;
  /** Whether the selected node has document text of its own (file / page / assignment) that can be forgotten. */
  selectedIsIndexable: boolean;
  /** Chunks of the selected node's document, empty when not indexed. */
  nodeChunks: Chunk[];

  /** Forget one collection of the selected course; the engine fetches it again when next needed. */
  forgetCollection: (kind: CollectionKind) => void;
  /** Forget the selected node's document text; it is indexed again when next searched or read. */
  forgetSelected: () => void;
  /** Forget the selected course and everything remembered under it. */
  forgetCourse: () => void;
  /** Forget the whole graph (every course, document, planner, inbox). Chats are kept. */
  forgetEverything: () => void;
  isForgetting: boolean;
  /** Transient (~4 s) result line of the last action. */
  statusMessage: string | null;
}

// ---------------------------------------------------------------------------
// Connections (remote MCP servers the student added)
// ---------------------------------------------------------------------------

export type { CatalogEntry } from '../connections/catalog';

export interface ConnectionToolView {
  name: string;
  title: string;
  description?: string;
  /** The server marks it as changing nothing; it runs without asking. */
  readOnly: boolean;
  /** The student chose "Always allow" for it. */
  alwaysAllowed: boolean;
  /** Switched on: the assistant may search, load and call it. */
  enabled: boolean;
  /** Estimated tokens of its definition as sent to the model. */
  tokens: number;
}

export interface ConnectionView {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
  /** `ok`: tools listed. `needs-auth`: the server wants a sign-in. `error`: see `error`. */
  status: 'ok' | 'needs-auth' | 'error';
  error?: string;
  /** Where the sign-in happens ("auth.example.com") while `needs-auth`. */
  authHost?: string;
  signedIn: boolean;
  tools: ConnectionToolView[];
  /** Estimated tokens of the definitions of its switched-on tools. */
  toolTokens: number;
}

/** The Connections section of Settings. Every action is meant to run from a click: Chrome asks for the server's origin first. */
export interface ConnectionsModel {
  list: ConnectionView[];
  catalog: CatalogEntry[];
  /**
   * How connection tools reach the model: `eager` = all declared on every call (small setups),
   * `lazy` = loaded on demand through a search, `none` = nothing connected and enabled.
   */
  toolLoading: 'none' | 'eager' | 'lazy';
  /** Estimated tokens of every enabled connection tool together, and the size below which they are all sent. */
  totalToolTokens: number;
  eagerLimit: number;
  /** Id of the connection an action is running on, or `'new'` while one is being added. */
  busy: string | null;
  error: string | null;
  add: (url: string, name: string) => void;
  signIn: (id: string) => void;
  /** Re-open the session and list the server's tools again. */
  reconnect: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  setAlwaysAllow: (id: string, tool: string, allow: boolean) => void;
  setToolEnabled: (id: string, tool: string, enabled: boolean) => void;
  remove: (id: string) => void;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface AppModel {
  // chat
  chats: ChatSummary[];
  currentChatId: string | null;
  messages: Message[];
  isLoading: boolean;
  /**
   * Idle: starts a run. While a run is in flight: fills the steering slot (replacing a message already
   * queued there). A `/command` is run instead of sent (see `commands`). Returns null when accepted, or
   * why not (shown under the composer, the text kept).
   */
  sendMessage: (content: string) => string | null;
  /** Composer commands, for the suggestion list that opens on `/`. */
  commands: CommandInfo[];
  /** Takes the queued message back out of the slot and returns its text for the composer; null when nothing is queued. */
  editQueued: () => string | null;
  /** Aborts the run and discards the queued message. */
  stop: () => void;
  /** Answers the tool step that is `awaiting` approval. */
  respondToApproval: (decision: ApprovalDecision) => void;
  /**
   * Set while the run has made `rounds` rounds of tool calls without an answer and waits for the
   * student: keep going, or end the turn there. A message sent meanwhile also keeps it going.
   */
  continuePrompt: { rounds: number } | null;
  respondToContinue: (keepGoing: boolean) => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;

  // settings (auto-saved on every change; there is no save button)
  settings: AppSettings;
  updateSettings: (next: AppSettings) => void;
  /** Live estimate of the conversation's token count, shown against `settings.contextThreshold`. */
  currentContextTokens: number;
  /** "Compact now" next to the meter: runs `/compact`. False when nothing is un-digested or a run is in flight. */
  canCompact: boolean;
  compactNow: () => void;
  /** True when that figure starts from the provider's count of the last call; false when it is all estimate. */
  contextTokensMeasured: boolean;
  /** Host access for a local or custom provider (Settings asks for it from a click). */
  providerAccess: ProviderAccessModel;

  // connection
  connection: Connection;
  /**
   * Banner under the header, or null: a session problem ("Not signed in to …; showing what's
   * remembered for …") that a Reload fixes (`reload: true`), or a storage failure that it does not.
   */
  notice: { text: string; reload: boolean } | null;
  reload: () => void;
  connect: ConnectModel;
  /** "Switch Canvas": drop the host, show the Connect screen (memory is kept). */
  disconnect: () => void;
  /** "Delete this account's data" (Settings): confirm, delete the database, chats and memory slot for this account, reload. */
  deleteAccountData: () => void;

  memory: MemoryModel;
  connections: ConnectionsModel;
}

/** Origins the chosen providers need; empty for hosted providers, which answer CORS themselves. */
export interface ProviderAccessModel {
  origins: string[];
  /** null while checking. */
  granted: boolean | null;
  /** Must run from a click. */
  grant: () => void;
}

export interface ShellProps {
  model: AppModel;
}
