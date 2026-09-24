import type { Queryable } from '../db/pglite';
import { storeContentLinks } from '../db/graph';
import { htmlToTextWithLinks } from '../utils/canvasLinks';
import type { ContentLink } from '../types/canvas';

/**
 * Which HTML body a link was found in; `from_id` is the page slug / assignment, announcement,
 * discussion or quiz id / course id for the syllabus. `discussion_replies` holds the links of all
 * replies of one topic (`from_id` = topic id), apart from the topic's own (`discussion`), which the
 * discussions sync replaces on its own schedule.
 */
export type LinkSource = 'page' | 'assignment' | 'announcement' | 'discussion' | 'discussion_replies' | 'quiz' | 'syllabus';

/**
 * Every HTML body that enters the graph passes through here: the text (with link markers) is
 * what gets stored or shown, and the links are recorded so the files and pages they point at
 * become discoverable through list_content even when a course hides its Files/Pages areas.
 */
export async function ingestHtml(
  courseId: string,
  fromType: LinkSource,
  fromId: string,
  html: string | null | undefined,
  tx?: Queryable
): Promise<{ text: string; links: ContentLink[] }> {
  const converted = htmlToTextWithLinks(html || '', courseId);
  await storeContentLinks(courseId, fromType, fromId, converted.links, tx);
  return converted;
}
