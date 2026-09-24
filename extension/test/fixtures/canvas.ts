import { reply, type Route } from '../helpers/canvas';

/**
 * Hand-written Canvas payloads, shaped after the fields the code reads (`src/types/canvas.ts`).
 * Nothing here comes from a real account. Course 1 is like the UofT courses the app was built
 * against: Home is a front page, the Files and Pages areas are hidden (403/404), and content is
 * reached through modules and links. Course 2 has none of that.
 */

export const COURSES = [
  { id: 1, name: 'Algorithms', course_code: 'CSC263', term: { name: 'Fall 2026' }, default_view: 'wiki' },
  { id: 2, name: 'Biology', course_code: 'BIO120', term: { name: 'Fall 2026' }, default_view: 'modules' },
];

export const TABS_1 = [
  { id: 'home', label: 'Home', type: 'internal', position: 1 },
  { id: 'modules', label: 'Modules', type: 'internal', position: 2 },
  { id: 'context_external_tool_9', label: 'Piazza', type: 'external', full_url: 'https://canvas.test/courses/1/external_tools/9', position: 3 },
  { id: 'files', label: 'Files', type: 'internal', hidden: true, position: 4 },
];

export const MODULE_11_ITEMS = [{ id: 110, module_id: 11, title: 'A1', type: 'Assignment', content_id: 31, position: 1 }];

export const MODULES_1 = [
  {
    id: 10,
    name: 'Week 1',
    position: 1,
    items_count: 2,
    items: [
      { id: 100, module_id: 10, title: 'Lecture 1.pdf', type: 'File', content_id: 500, position: 1 },
      { id: 101, module_id: 10, title: 'Course intro', type: 'Page', page_url: 'intro', position: 2 },
    ],
  },
  // Canvas omits inline items for large modules: the sync falls back to the items endpoint
  { id: 11, name: 'Week 2', position: 2, items_count: 1 },
];

export const ASSIGNMENT_GROUPS_1 = [
  {
    id: 1,
    name: 'Homework',
    assignments: [
      { id: 31, course_id: 1, name: 'A1', due_at: '2026-10-01T23:59:00Z', points_possible: 10, updated_at: 'T1', description: '<p>should not be stored</p>' },
    ],
  },
  { id: 2, name: 'Exams', assignments: [{ id: 32, course_id: 1, name: 'Midterm', due_at: null, points_possible: 50, updated_at: 'T1' }] },
];

/** The plain listing (fallback when assignment groups are restricted) carries HTML descriptions. */
export const ASSIGNMENTS_1 = [
  { id: 31, course_id: 1, name: 'A1', updated_at: 'T1', description: '<p>See the <a href="/courses/1/files/501">starter code</a>.</p>' },
];

export const ASSIGNMENT_31 = {
  id: 31,
  course_id: 1,
  name: 'A1',
  updated_at: 'T1',
  due_at: '2026-10-01T23:59:00Z',
  points_possible: 10,
  submission_types: ['online_upload'],
  description: '<h3>Task</h3><p>Implement a heap. Starter: <a href="/courses/1/files/501">starter.zip</a></p>',
};

export const FRONT_PAGE_1 = {
  url: 'home',
  title: 'Welcome',
  updated_at: 'P1',
  body:
    '<h2>Welcome to CSC263</h2><p><a href="/courses/1/files/502" title="syllabus-2026.pdf">Syllabus</a> · ' +
    '<a href="/courses/1/pages/week-1">Week 1 notes</a> · <a href="https://zoom.us/j/1">https://zoom.us/j/1</a></p>',
};

export const ANNOUNCEMENTS_1 = [
  { id: 70, title: 'Slides for today', message: '<p>Slides: <a href="/courses/1/files/505">lecture2.pdf</a></p>', posted_at: '2026-09-04T12:00:00Z', author: { display_name: 'Prof' } },
];

export const DISCUSSIONS_1 = [
  {
    id: 80,
    title: 'Questions about A1',
    message: '<p>Ask here. Read the <a href="/courses/1/files/503">rules</a> first.</p>',
    posted_at: '2026-09-01T00:00:00Z',
    last_reply_at: '2026-09-05T00:00:00Z',
    discussion_subentry_count: 2,
    author: { display_name: 'Prof' },
  },
];

export const DISCUSSION_80_VIEW = {
  participants: [
    { id: 7, display_name: 'Ada' },
    { id: 8, display_name: 'Ben' },
  ],
  view: [
    {
      id: 1,
      user_id: 7,
      message: '<p>How is A1 graded?</p>',
      created_at: '2026-09-02T00:00:00Z',
      replies: [{ id: 2, user_id: 8, message: '<p>By the <b>test suite</b>. See <a href="/courses/1/files/560" title="rubric.pdf">the rubric</a>.</p>', created_at: '2026-09-03T00:00:00Z' }],
    },
    { id: 3, user_id: 8, deleted: true },
  ],
};

export const CONVERSATIONS = [
  {
    id: 900,
    subject: 'Extension request',
    last_message: 'Granted.',
    last_message_at: '2026-09-06T00:00:00Z',
    message_count: 2,
    participants: [
      { id: 7, name: 'Ada' },
      { id: 1, name: 'Prof' },
    ],
    context_code: 'course_1',
    context_name: 'Algorithms',
  },
];

export const CONVERSATION_900 = {
  id: 900,
  subject: 'Extension request',
  participants: CONVERSATIONS[0].participants,
  messages: [
    { id: 9001, author_id: 1, body: 'Granted.', created_at: '2026-09-06T00:00:00Z' },
    { id: 9000, author_id: 7, body: 'Could I have two more days for A1?', created_at: '2026-09-05T00:00:00Z' },
  ],
};

export const SYLLABUS_1 = { id: 1, syllabus_body: '<h2>Grading</h2><p>See <a href="/courses/1/files/504">the policy</a>.</p>' };

export const PLANNER = [
  {
    plannable_type: 'assignment',
    plannable_id: 31,
    course_id: 1,
    context_name: 'Algorithms',
    plannable_date: '2026-10-01T23:59:00Z',
    plannable: { title: 'A1', points_possible: 10 },
    submissions: { submitted: false, missing: false },
  },
];

export const QUIZZES_1 = [
  {
    id: 60,
    title: 'Quiz 1',
    quiz_type: 'assignment',
    time_limit: 20,
    allowed_attempts: -1,
    question_count: 5,
    description: '<p>Covers <a href="/courses/1/pages/week-1">week 1</a>.</p>',
    locked_for_user: true,
    lock_explanation: '<p>Available Oct 1</p>',
    assignment_id: 33,
  },
];

export const SUBMISSIONS_1 = [{ assignment_id: 31, workflow_state: 'graded', score: 9, grade: '9', submitted_at: '2026-09-30T00:00:00Z' }];

/** A fresh route table per test, so a test can change one route without leaking. */
export function canvasRoutes(): Record<string, Route> {
  return {
    '/courses': COURSES,
    '/courses/1/tabs': TABS_1,
    '/courses/2/tabs': reply.status(404),
    '/courses/1/modules': (url: URL) =>
      url.searchParams.get('include[]') === 'items' ? MODULES_1 : MODULES_1.map(({ items: _items, ...m }) => m),
    '/courses/1/modules/10/items': MODULES_1[0].items,
    '/courses/1/modules/11/items': MODULE_11_ITEMS,
    '/courses/1/assignment_groups': ASSIGNMENT_GROUPS_1,
    '/courses/1/assignments': ASSIGNMENTS_1,
    '/courses/1/assignments/31': ASSIGNMENT_31,
    // The Files and Pages areas are hidden from students, as in every probed UofT course
    '/courses/1/files': reply.status(403),
    '/courses/1/pages': reply.status(404),
    '/courses/1/front_page': FRONT_PAGE_1,
    '/courses/2/front_page': reply.status(404),
    '/courses/1/discussion_topics': (url: URL) => (url.searchParams.get('only_announcements') ? ANNOUNCEMENTS_1 : DISCUSSIONS_1),
    '/courses/1/discussion_topics/80/view': DISCUSSION_80_VIEW,
    '/conversations': CONVERSATIONS,
    '/conversations/900': CONVERSATION_900,
    '/courses/1': SYLLABUS_1,
    '/planner/items': PLANNER,
    '/courses/1/quizzes': QUIZZES_1,
    '/courses/1/students/submissions': SUBMISSIONS_1,
  };
}
