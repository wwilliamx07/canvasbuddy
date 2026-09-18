import type { Queryable } from '../db/pglite';
import { storeContentLinks } from '../db/graph';
import { htmlToTextWithLinks } from '../utils/canvasLinks';

/**
 * Every HTML body that enters the graph passes through here: the text (with link markers) is
 * what gets stored or shown, and the links are recorded so the files and pages they point at
 * become discoverable through list_content even when a course hides its Files/Pages areas.
 */
export async function ingestHtml(
  courseId: string,
  fromType: 'page' | 'assignment' | 'announcement',
  fromId: string,
  html: string | null | undefined,
  tx?: Queryable
): Promise<string> {
  const { text, links } = htmlToTextWithLinks(html || '', courseId);
  await storeContentLinks(courseId, fromType, fromId, links, tx);
  return text;
}
