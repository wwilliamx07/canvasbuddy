import type { ContentLink } from '../types/canvas';
import { htmlToText } from './textExtractor';
import { canvasHost } from '../canvas/http';
import { profileFor } from '../canvas/profiles';

/**
 * Canvas content is a graph of HTML bodies linking to files, pages, assignments and external
 * sites, and those links are the only way to reach content an instructor organised as "a page
 * with links" when the Files/Pages areas are hidden. This module turns an HTML body into
 * (a) the structured links it contains and (b) text in which each link keeps a marker the model
 * can act on: "Syllabus [file 44541003]", "Week 1 [page week-1]", "Zoom <https://…>".
 */

export type ParsedRef = Pick<ContentLink, 'to_type' | 'to_ref' | 'course_id'>;

/** Classifies one href (or Canvas's data-api-endpoint) into a graph reference. Returns null for anchors/mailto/js. */
export function parseCanvasHref(href: string, currentCourseId?: string | null): ParsedRef | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (/^(#|mailto:|javascript:|tel:)/i.test(trimmed)) return null;

  // Relative hrefs are relative to the connected Canvas; which hosts count as "inside" it is the profile's call
  const host = canvasHost();
  let url: URL;
  try {
    url = new URL(trimmed, `https://${host}/`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;

  const internal = profileFor(host).isInternalHost(url.hostname, host);
  if (!internal) return { to_type: 'external', to_ref: url.href, course_id: null };

  const path = url.pathname.replace(/^\/api\/v1/, '');
  const course = path.match(/^\/courses\/(\d+)/)?.[1] ?? null;
  const courseId = course ?? currentCourseId ?? null;

  let m: RegExpMatchArray | null;
  if ((m = path.match(/\/files\/(\d+)/))) return { to_type: 'file', to_ref: m[1], course_id: courseId };
  const preview = url.searchParams.get('preview');
  if (preview && /^\d+$/.test(preview) && /\/files/.test(path)) return { to_type: 'file', to_ref: preview, course_id: courseId };
  if ((m = path.match(/^\/courses\/\d+\/pages\/([^/?#]+)/))) return { to_type: 'page', to_ref: decodeURIComponent(m[1]), course_id: courseId };
  if ((m = path.match(/^\/courses\/\d+\/assignments\/(\d+)/))) return { to_type: 'assignment', to_ref: m[1], course_id: courseId };
  if ((m = path.match(/^\/courses\/\d+\/quizzes\/(\d+)/))) return { to_type: 'quiz', to_ref: m[1], course_id: courseId };
  if ((m = path.match(/^\/courses\/\d+\/(?:discussion_topics|announcements)\/(\d+)/))) return { to_type: 'discussion', to_ref: m[1], course_id: courseId };
  if ((m = path.match(/^\/courses\/\d+\/modules\/(?:items\/)?(\d+)/))) return { to_type: 'module', to_ref: m[1], course_id: courseId };
  // Anything else on Canvas (external tool launches, folders, the course root) is kept as a URL
  return { to_type: 'external', to_ref: url.href, course_id: courseId };
}

/** The inline marker the model sees for a link: what to pass to read_document / search_documents. */
export function linkMarker(ref: ParsedRef): string {
  switch (ref.to_type) {
    case 'file':
      return `[file ${ref.to_ref}]`;
    case 'page':
      return `[page ${ref.to_ref}]`;
    case 'assignment':
      return `[assignment ${ref.to_ref}]`;
    case 'quiz':
      return `[quiz ${ref.to_ref}]`;
    case 'discussion':
      return `[discussion ${ref.to_ref}]`;
    case 'module':
      return `[module ${ref.to_ref}]`;
    default:
      return `<${ref.to_ref.length > 120 ? ref.to_ref.slice(0, 117) + '…' : ref.to_ref}>`;
  }
}

/**
 * Converts Canvas HTML to text with link markers, and returns the links in document order.
 * Embedded players (iframes) count as external links so "where is the lecture recording"
 * has something to point at.
 */
export function htmlToTextWithLinks(html: string, currentCourseId?: string | null): { text: string; links: ContentLink[] } {
  if (!html || !html.trim()) return { text: '', links: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links: ContentLink[] = [];
  const seen = new Set<string>();

  const record = (ref: ParsedRef, label: string | null, title: string | null = null) => {
    const key = `${ref.to_type}:${ref.to_ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ ...ref, label: label || null, title, position: links.length });
  };

  doc.querySelectorAll('a[href], a[data-api-endpoint]').forEach((a) => {
    const ref = parseCanvasHref(a.getAttribute('data-api-endpoint') || a.getAttribute('href') || '', currentCourseId);
    const title = a.getAttribute('title');
    const label = (a.textContent || '').replace(/\s+/g, ' ').trim() || title || null;
    if (!ref) return;
    record(ref, label, title);
    const marker = linkMarker(ref);
    // Don't repeat a URL the anchor text already shows
    const shown = label && ref.to_type === 'external' && label.replace(/\/$/, '') === ref.to_ref.replace(/\/$/, '') ? marker : `${label || ''} ${marker}`.trim();
    a.replaceWith(doc.createTextNode(shown));
  });

  doc.querySelectorAll('iframe[src]').forEach((f) => {
    const ref = parseCanvasHref(f.getAttribute('src') || '', currentCourseId);
    if (!ref) return;
    const label = f.getAttribute('title') || 'embedded media';
    record(ref, label);
    f.replaceWith(doc.createTextNode(`${label} ${linkMarker(ref)}`));
  });

  return { text: htmlToText(doc.body.innerHTML), links };
}
