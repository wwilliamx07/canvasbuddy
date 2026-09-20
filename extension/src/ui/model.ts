/**
 * The contract the UI is written against. `App.tsx` builds one `AppModel` from its state and
 * handlers and hands it to `Shell`; nothing under `src/ui` reaches past this object (no direct
 * data access, no Canvas calls). Extend the extension first, then this file.
 */

import type { CollectionKind, FreshnessSettings } from '../canvas/freshness';
import type { AppSettings } from '../settings';

export type { CollectionKind, FreshnessSettings } from '../canvas/freshness';
export { DEFAULT_FRESHNESS } from '../canvas/freshness';
export type { AppSettings } from '../settings';
export { DEFAULT_BASE_URLS } from '../settings';

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Tokens are still arriving for this bubble (typing dots while empty, caret while text grows). Transient: never persisted. */
  streaming?: boolean;
  /** What the assistant did after this text, one short line per tool call, e.g. `Listing assignments "CSC263"`. Persisted. */
  activity?: string[];
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

export interface TabInspection {
  /** Host of the active tab, when it is an https page the panel may see. */
  host: string | null;
  /** Whether that page is Canvas; null when it could not be inspected. */
  isCanvas: boolean | null;
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

export interface GraphStats {
  courseCount: number;
  moduleCount: number;
  itemCount: number;
  assignmentCount: number;
  fileCount: number;
  chunkCount: number;
}

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
  isForgetting: boolean;
  /** Transient (~4 s) result line of the last action. */
  statusMessage: string | null;
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
  sendMessage: (content: string) => void;
  stop: () => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;

  // settings (auto-saved on every change; there is no save button)
  settings: AppSettings;
  updateSettings: (next: AppSettings) => void;
  /** Live estimate of the conversation's token count, shown against `settings.contextThreshold`. */
  currentContextTokens: number;

  // connection
  connection: Connection;
  /** Banner text ("Not signed in to …; showing what's remembered for …") with a Reload action, or null. */
  notice: string | null;
  reload: () => void;
  connect: ConnectModel;
  /** "Switch Canvas": drop the host, show the Connect screen (memory is kept). */
  disconnect: () => void;
  /** "Forget this memory": confirm, delete database + chats for this account, reload. */
  forgetMemory: () => void;

  memory: MemoryModel;
}

export interface ShellProps {
  model: AppModel;
}
