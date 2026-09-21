/**
 * Canvas LMS API entity types and local Graph representations
 */

export interface CanvasCourse {
  id: number | string;
  course_id?: number | string;
  name: string;
  course_code?: string;
  workflow_state?: string;
  term?: {
    name?: string;
    start_at?: string;
    end_at?: string;
  };
  /** What the course "Home" nav item shows: 'wiki' (front page) | 'modules' | 'syllabus' | 'assignments' | 'feed' */
  default_view?: string;
  synced_at?: string;
}

/** One entry of a course's navigation bar (Tabs API). Students only receive visible tabs. */
export interface CanvasTab {
  id: string;
  label: string;
  type?: 'internal' | 'external';
  html_url?: string;
  full_url?: string;
  position?: number;
  hidden?: boolean;
}

/** A hyperlink found in Canvas HTML (front page, wiki page, assignment description, announcement). */
export interface ContentLink {
  to_type: 'file' | 'page' | 'assignment' | 'quiz' | 'discussion' | 'module' | 'external';
  /** file id / page slug / assignment id / … / absolute URL for external */
  to_ref: string;
  label: string | null;
  /** The anchor's title attribute; Canvas puts the real filename there on file links */
  title?: string | null;
  /** Course the link points into when it names one (may differ from the page's course) */
  course_id?: string | null;
  position: number;
}

export interface CanvasModule {
  id: number | string;
  course_id?: number | string;
  name: string;
  position?: number;
  unlock_at?: string | null;
  require_sequential_progress?: boolean;
  prerequisite_module_ids?: (number | string)[];
  items_count?: number;
  items_url?: string;
  items?: CanvasModuleItem[];
  synced_at?: string;
}

export interface CanvasModuleItem {
  id: number | string;
  module_id: number | string;
  position?: number;
  title: string;
  type: 'File' | 'Assignment' | 'Page' | 'Discussion' | 'Quiz' | 'SubHeader' | 'ExternalUrl' | 'ExternalTool' | string;
  content_id?: number | string;
  page_url?: string;        // wiki pages are addressed by slug, not content_id
  external_url?: string;    // destination of ExternalUrl / ExternalTool items
  html_url?: string;
  url?: string;
  content_ref?: string;
  synced_at?: string;
}

export interface CanvasAssignment {
  id: number | string;
  course_id: number | string;
  name: string;
  description?: string;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  updated_at?: string;
  synced_at?: string;
  /** Set by the assignment_groups listing (not a Canvas field on the assignment itself) */
  group_name?: string;
}

export interface CanvasPage {
  url: string;              // slug used in API paths
  page_id?: number | string;
  title: string;
  body?: string;            // only present when fetching a single page
  updated_at?: string;
  html_url?: string;
  published?: boolean;
  front_page?: boolean;
}

export interface CanvasFile {
  id: number | string;
  course_id?: number | string;
  folder_id?: number | string;
  display_name?: string;
  filename: string;
  content_type?: string;
  url?: string;
  size?: number;
  created_at?: string;
  updated_at?: string;
  modified_at?: string;
  total_chunks?: number;
  extracted_at?: string;
}

export interface GraphStats {
  courseCount: number;
  moduleCount: number;
  itemCount: number;
  assignmentCount: number;
  fileCount: number;
  chunkCount: number;
}

export interface RetrievedChunk {
  chunk_id: string;
  chunk_index: number;
  page_number?: number;
  /** last page/slide covered by the chunk (merged small pages); equals page_number otherwise */
  page_end?: number;
  content: string;
  similarity: number;
  filename: string;
  display_name?: string;
  file_id: string;
  course_id?: string;
  course_name?: string;
  module_name?: string;
  source_type?: 'file' | 'page' | 'assignment' | string;
  html_url?: string;
}


// ---------------------------------------------------------------------------
// Shaped rows: what collections store (and what tools return). Nothing raw from Canvas.
// ---------------------------------------------------------------------------

export interface ShapedSubmission {
  assignment_id: string;
  workflow_state: string | null;
  submitted_at: string | null;
  graded_at: string | null;
  score: number | null;
  grade: string | null;
  late: boolean;
  missing: boolean;
  excused: boolean;
}

export interface ShapedAnnouncement {
  announcement_id: string;
  title: string;
  posted_at: string | null;
  author: string | null;
  text: string;
  html_url: string | null;
}

export interface ShapedPlannerItem {
  item_key: string;
  plannable_type: string;
  plannable_id: string | null;
  course_id: string | null;
  context_name: string | null;
  title: string;
  date: string | null;
  points: number | null;
  submitted: boolean | null;
  late: boolean | null;
  missing: boolean | null;
  graded: boolean | null;
  new_activity: boolean;
  html_url: string | null;
}

export interface ShapedConversation {
  conversation_id: string;
  subject: string | null;
  context_name: string | null;
  course_id: string | null;
  participants: Array<{ id: string; name: string }>;
  last_message: string | null;
  last_message_at: string | null;
  workflow_state: string | null;
  message_count: number | null;
  starred: boolean;
}

export interface ShapedMessage {
  message_id: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string | null;
  body: string;
}

// ---------------------------------------------------------------------------
// Discussions (course forums), quizzes, syllabus
// ---------------------------------------------------------------------------

/** GET /courses/:c/discussion_topics — announcements are the same object with only_announcements */
export interface CanvasDiscussionTopic {
  id: number | string;
  title?: string;
  message?: string | null;
  posted_at?: string | null;
  last_reply_at?: string | null;
  discussion_subentry_count?: number;
  html_url?: string;
  author?: { display_name?: string };
  user_name?: string;
  pinned?: boolean;
  locked?: boolean;
  assignment_id?: number | string | null; // set for graded discussions
  published?: boolean;
}

/** GET /courses/:c/discussion_topics/:id/view — the whole reply tree in one response */
export interface CanvasDiscussionView {
  participants?: Array<{ id: number | string; display_name?: string }>;
  view?: CanvasDiscussionEntry[];
}

export interface CanvasDiscussionEntry {
  id: number | string;
  user_id?: number | string;
  message?: string | null;
  created_at?: string;
  deleted?: boolean;
  replies?: CanvasDiscussionEntry[];
}

export interface ShapedDiscussion {
  discussion_id: string;
  title: string;
  author: string | null;
  posted_at: string | null;
  last_reply_at: string | null;
  reply_count: number;
  /** Topic message as text with link markers, clipped */
  message: string;
  html_url: string | null;
  pinned: boolean;
  locked: boolean;
  assignment_id: string | null;
}

/** GET /courses/:c/quizzes */
export interface CanvasQuiz {
  id: number | string;
  title?: string;
  html_url?: string;
  quiz_type?: string; // practice_quiz | assignment | graded_survey | survey
  time_limit?: number | null; // minutes
  allowed_attempts?: number | null; // -1 = unlimited
  question_count?: number | null;
  points_possible?: number | string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  published?: boolean;
  description?: string | null;
  assignment_id?: number | string | null;
  locked_for_user?: boolean;
  lock_explanation?: string | null;
}

export interface ShapedQuiz {
  quiz_id: string;
  title: string;
  quiz_type: string | null;
  time_limit: number | null;
  allowed_attempts: number | null;
  question_count: number | null;
  points_possible: number | null;
  due_at: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  published: boolean;
  /** Description as text with link markers, clipped */
  description: string | null;
  assignment_id: string | null;
  html_url: string | null;
  lock_explanation: string | null;
}
