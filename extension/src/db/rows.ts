/**
 * Rows the read functions of `db/graph.ts` and `db/rag.ts` return: what their SQL projects, typed
 * the way PGlite hands it back — `TIMESTAMPTZ` columns as `Date`, `COUNT(*)`, `INT`, `BIGINT` and
 * `DOUBLE PRECISION` as `number`, Canvas's own timestamps stored as `TEXT` (`updated_at`) as string.
 */

export interface CourseListRow {
  course_id: string;
  name: string;
  course_code: string | null;
  term: string | null;
  /** What the course's Home shows ("front page \"Home\" (page home)", "modules", …). */
  home_view: string | null;
  /** The nav bar as one line, external tools with their launch URL. */
  nav: string | null;
  module_count: number;
  assignment_count: number;
  indexed_document_count: number;
  /** 'unavailable' when the course hides the area, else null. */
  files_status: string | null;
  pages_status: string | null;
  has_syllabus: boolean;
}

export interface ModuleListRow {
  module_id: string;
  course_id: string;
  name: string;
  position: number;
  item_count: number;
}

export interface ModuleItemListRow {
  item_id: string;
  module_id: string;
  module_name: string;
  course_id: string;
  item_type: string;
  title: string;
  position: number;
  content_ref: string | null;
  html_url: string | null;
  indexed: boolean;
}

/** The student's submission, joined onto an assignment or quiz row when asked for. */
export interface SubmissionColumns {
  submission_state?: string | null;
  submitted_at?: Date | null;
  score?: number | null;
  grade?: string | null;
  late?: boolean | null;
  missing?: boolean | null;
  excused?: boolean | null;
}

export interface AssignmentListRow extends SubmissionColumns {
  assignment_id: string;
  course_id: string;
  name: string;
  due_at: Date | null;
  points_possible: number | null;
  submission_types: string | null;
  group_name: string | null;
  html_url: string | null;
  has_description: boolean;
  description_indexed: boolean;
}

export interface FileListRow {
  file_id: string;
  course_id: string | null;
  filename: string;
  display_name: string | null;
  content_type: string | null;
  size: number | null;
  html_url: string | null;
  indexed: boolean;
}

export interface PageListRow {
  page_url: string;
  course_id: string;
  title: string;
  updated_at: string | null;
  html_url: string | null;
  front_page: boolean;
  indexed: boolean;
}

/** A file of the course however it was found (`listCourseFiles`). */
export interface CourseFileRow {
  file_id: string;
  name: string;
  /** The real filename when it differs from the display name. */
  filename: string | null;
  content_type: string | null;
  size: number | null;
  html_url: string | null;
  indexed: boolean;
  /** "home page; module: Week 3". */
  linked_from: string | null;
}

/** A page of the course however it was found (`listCoursePages`). */
export interface CoursePageRow {
  page_url: string;
  title: string;
  updated_at: string | null;
  html_url: string | null;
  front_page: boolean;
  indexed: boolean;
  linked_from: string | null;
}

/** One node of `getCourseHierarchy`'s flat tree: modules at depth 0, their items at depth 1. */
export interface TreeNodeRow {
  node_id: string;
  node_type: 'module' | 'module_item';
  label: string;
  pos: number;
  parent_module_id: string;
  item_type: string | null;
  content_ref: string | null;
  html_url: string | null;
  depth: number;
}

export interface GraphEdgeRow {
  edge_id: number;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
}

export interface CourseHierarchy {
  course: { course_id: string; name: string; course_code: string | null; term: string | null } | null;
  treeNodes: TreeNodeRow[];
  assignments: Array<Pick<AssignmentListRow, 'assignment_id' | 'course_id' | 'name' | 'due_at' | 'points_possible' | 'html_url' | 'group_name'>>;
  prerequisites: GraphEdgeRow[];
}

/** One assignment in full (`assignments.*`) with the student's submission. */
export interface AssignmentDetailRow extends SubmissionColumns {
  assignment_id: string;
  course_id: string;
  name: string;
  due_at: Date | null;
  points_possible: number | null;
  html_url: string | null;
  description: string | null;
  description_version: string | null;
  updated_at: string | null;
  submission_types: string | null;
  group_name: string | null;
  description_indexed: boolean;
}

export interface AnnouncementListRow {
  announcement_id: string;
  title: string;
  posted_at: Date | null;
  author: string | null;
  text: string | null;
  html_url: string | null;
}

export interface DiscussionListRow {
  discussion_id: string;
  title: string;
  author: string | null;
  posted_at: Date | null;
  last_reply_at: Date | null;
  reply_count: number;
  message: string | null;
  html_url: string | null;
  pinned: boolean;
  locked: boolean;
  assignment_id: string | null;
  /** The thread document exists (its replies were read). */
  replies_read: boolean;
}

/** `discussions.*`. */
export interface DiscussionRecord extends Omit<DiscussionListRow, 'replies_read'> {
  course_id: string;
  replies_synced_for: string | null;
}

export interface QuizListRow extends SubmissionColumns {
  quiz_id: string;
  title: string;
  quiz_type: string | null;
  time_limit: number | null;
  allowed_attempts: number | null;
  question_count: number | null;
  points_possible: number | null;
  due_at: Date | null;
  unlock_at: Date | null;
  lock_at: Date | null;
  published: boolean;
  description: string | null;
  assignment_id: string | null;
  html_url: string | null;
  lock_explanation: string | null;
}

export interface PlannerListRow {
  plannable_type: string;
  plannable_id: string | null;
  course_id: string | null;
  context_name: string | null;
  title: string;
  date: Date | null;
  points: number | null;
  submitted: boolean | null;
  late: boolean | null;
  missing: boolean | null;
  graded: boolean | null;
  new_activity: boolean | null;
  html_url: string | null;
}

export interface ConversationListRow {
  conversation_id: string;
  subject: string | null;
  context_name: string | null;
  /** JSON `[{ id, name }]`. */
  participants: string | null;
  last_message: string | null;
  last_message_at: Date | null;
  workflow_state: string | null;
  message_count: number | null;
  starred: boolean | null;
  /** With a search: the newest stored message that matched. */
  matching_message?: string | null;
}

export interface MessageRow {
  message_id: string;
  author_name: string | null;
  created_at: Date | null;
  body: string;
}

/** `files.*`: a document, indexed or merely known. */
export interface DocumentRecord {
  file_id: string;
  course_id: string | null;
  filename: string;
  display_name: string | null;
  version: string;
  extracted_at: Date | null;
  total_chunks: number;
  source_type: string;
  page_kind: string | null;
  embedding_model: string | null;
  html_url: string | null;
  content_type: string | null;
  size: number | null;
}

export interface ChunkRow {
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  page_end: number | null;
  page_kind: string | null;
  content: string;
  token_count: number | null;
}
