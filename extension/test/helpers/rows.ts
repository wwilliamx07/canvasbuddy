import type { ShapedAnnouncement, ShapedDiscussion, ShapedQuiz, ShapedSubmission } from '../../src/types/canvas';

/** Complete shaped rows with overridable fields, so a test states only what it is about. */

export const announcement = (id: string, over: Partial<ShapedAnnouncement> = {}): ShapedAnnouncement => ({
  announcement_id: id,
  title: `Announcement ${id}`,
  posted_at: '2026-09-01T12:00:00Z',
  author: 'Prof',
  text: `Text of ${id}`,
  html_url: null,
  ...over,
});

export const discussion = (id: string, over: Partial<ShapedDiscussion> = {}): ShapedDiscussion => ({
  discussion_id: id,
  title: `Topic ${id}`,
  author: 'Student',
  posted_at: '2026-09-01T12:00:00Z',
  last_reply_at: '2026-09-02T12:00:00Z',
  reply_count: 2,
  message: `Message ${id}`,
  html_url: null,
  pinned: false,
  locked: false,
  assignment_id: null,
  ...over,
});

export const quiz = (id: string, over: Partial<ShapedQuiz> = {}): ShapedQuiz => ({
  quiz_id: id,
  title: `Quiz ${id}`,
  quiz_type: 'assignment',
  time_limit: 30,
  allowed_attempts: 1,
  question_count: 10,
  points_possible: 10,
  due_at: null,
  unlock_at: null,
  lock_at: null,
  published: true,
  description: null,
  assignment_id: null,
  html_url: null,
  lock_explanation: null,
  ...over,
});

export const submission = (assignmentId: string, over: Partial<ShapedSubmission> = {}): ShapedSubmission => ({
  assignment_id: assignmentId,
  workflow_state: 'submitted',
  submitted_at: '2026-09-03T12:00:00Z',
  graded_at: null,
  score: null,
  grade: null,
  late: false,
  missing: false,
  excused: false,
  ...over,
});
