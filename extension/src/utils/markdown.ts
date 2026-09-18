import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Assistant replies are rendered as HTML, and their text is derived from Canvas content
 * (announcements, pages, inbox messages, PDFs) that anyone with access to the course can author.
 * `marked` passes raw HTML through untouched, so the output is sanitized to the tag set Markdown
 * itself produces. The extension CSP already blocks scripts; this closes what it does not
 * (<style>/<form>/<iframe>/<img> overlays, tracking pixels, layout breakage).
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'a', 'em', 'strong', 'b', 'i', 's', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span',
];
const ALLOWED_ATTR = ['href', 'title', 'class', 'start', 'align', 'target', 'rel'];

// The side panel is a page: a plain link would navigate it away. Open links in a tab instead.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
