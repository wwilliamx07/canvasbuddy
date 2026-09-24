import DOMPurify from 'dompurify';
import { marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Assistant replies are rendered as HTML, and their text is derived from Canvas content
 * (announcements, pages, inbox messages, PDFs) that anyone with access to the course can author.
 * `marked` passes raw HTML through untouched, so the output is sanitized to the tag set Markdown
 * itself produces. The extension CSP already blocks scripts; this closes what it does not
 * (<style>/<form>/<iframe>/<img> overlays, tracking pixels, layout breakage).
 *
 * Math ($…$, $$…$$, \(…\), \[…\]) is tokenized by marked extensions below, which stash the raw
 * TeX in `pending` and emit a placeholder `<span data-math="N">`. KaTeX renders each placeholder's
 * TeX into HTML *after* DOMPurify has sanitized the Markdown output, not before: with `trust: false`
 * KaTeX only ever emits spans with class/style/aria attributes and escaped text (no URLs, no
 * scripts), so nothing unsafe reaches the page, and the Markdown allowlist above can keep
 * forbidding `style` everywhere else instead of carving out an exception for KaTeX's output.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'a', 'em', 'strong', 'b', 'i', 's', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span',
];
const ALLOWED_ATTR = ['href', 'title', 'class', 'start', 'align', 'target', 'rel', 'data-math'];

// The side panel is a page: a plain link would navigate it away. Open links in a tab instead.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Raw TeX for the math tokens found in the current renderMarkdown call, indexed by placeholder id.
// Reset per call so KaTeX renders exactly what this pass tokenized, nothing left over from before.
let pending: Array<{ tex: string; display: boolean }> = [];

function pushMath(tex: string, display: boolean): string {
  const index = pending.length;
  pending.push({ tex, display });
  return `<span data-math="${index}"></span>`;
}

export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    // Only the fenced form: `$$` alone on a line, formula, `$$` alone on a line. A block-level
    // `start` cuts the enclosing paragraph wherever it points, and a body that may span lines
    // would otherwise let a mid-paragraph `$$…$$` swallow text up to the next fence. Single-line
    // `$$…$$` is still display math — `mathDisplayInline` handles it inside the paragraph.
    name: 'mathBlock',
    level: 'block',
    start(src) {
      const m = /(?:^|\n)\$\$[ \t]*\n/.exec(src);
      if (!m) return undefined;
      return m.index + (m[0][0] === '\n' ? 1 : 0);
    },
    tokenizer(src) {
      const match = /^\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: 'mathBlock', raw: match[0], tex: match[1], display: true };
    },
    renderer(token: Tokens.Generic) {
      return pushMath(token.tex, true);
    },
  },
  {
    name: 'mathDisplayInline',
    level: 'inline',
    start(src) {
      return mathInlineStart(src);
    },
    tokenizer(src) {
      const match = /^\$\$([\s\S]+?)\$\$/.exec(src);
      if (!match) return undefined;
      return { type: 'mathDisplayInline', raw: match[0], tex: match[1], display: true };
    },
    renderer(token: Tokens.Generic) {
      return pushMath(token.tex, true);
    },
  },
  {
    name: 'mathInline',
    level: 'inline',
    start(src) {
      return mathInlineStart(src);
    },
    tokenizer(src) {
      const match = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
      if (!match) return undefined;
      return { type: 'mathInline', raw: match[0], tex: match[1], display: false };
    },
    renderer(token: Tokens.Generic) {
      return pushMath(token.tex, false);
    },
  },
  {
    name: 'mathParen',
    level: 'inline',
    start(src) {
      return mathInlineStart(src);
    },
    tokenizer(src) {
      const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
      if (!match) return undefined;
      return { type: 'mathParen', raw: match[0], tex: match[1], display: false };
    },
    renderer(token: Tokens.Generic) {
      return pushMath(token.tex, false);
    },
  },
  {
    name: 'mathBracket',
    level: 'inline',
    start(src) {
      return mathInlineStart(src);
    },
    tokenizer(src) {
      const match = /^\\\[([\s\S]+?)\\\]/.exec(src);
      if (!match) return undefined;
      return { type: 'mathBracket', raw: match[0], tex: match[1], display: true };
    },
    renderer(token: Tokens.Generic) {
      return pushMath(token.tex, true);
    },
  },
];

// Shared `start` for every inline math extension: the earliest position any of them could match,
// so marked's inline text tokenizer stops there instead of swallowing the delimiter as plain text.
// A `$` immediately after a backslash is an escape (`\$5`), not a candidate — skip past it so
// marked's built-in `escape` tokenizer (which only fires at a backslash) still gets first look.
function mathInlineStart(src: string): number | undefined {
  let dollar = src.indexOf('$');
  while (dollar > 0 && src[dollar - 1] === '\\') {
    dollar = src.indexOf('$', dollar + 1);
  }
  const paren = src.indexOf('\\(');
  const bracket = src.indexOf('\\[');
  const candidates = [dollar, paren, bracket].filter((i) => i >= 0);
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

marked.use({ extensions: mathExtensions });

const MATH_PLACEHOLDER = /<span[^>]*\bdata-math="(\d+)"[^>]*><\/span>/g;

/** `\text{…}` and its relatives: arguments typeset as prose, where `&` can only be a literal. */
const TEXT_ARGUMENT = /\\(?:text(?:bf|it|rm|sf|tt|up)?|mbox)\s*\{/g;

/**
 * Escapes characters models copy verbatim from course material into math ("\text{# outcomes}",
 * "50%"), which KaTeX rejects: a bare `#` (a macro parameter, never meant in a reply) and `%`
 * (a comment that swallows the rest of the formula) anywhere, and `&` inside text arguments. A bare
 * `&` elsewhere is left alone — it separates columns in aligned environments.
 */
export function repairTex(tex: string): string {
  const escaped = tex.replace(/(?<!\\)#/g, '\\#').replace(/(?<!\\)%/g, '\\%');
  let out = '';
  let from = 0;
  let match: RegExpExecArray | null;
  TEXT_ARGUMENT.lastIndex = 0;
  while ((match = TEXT_ARGUMENT.exec(escaped))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < escaped.length && depth > 0; end++) {
      if (escaped[end] === '\\') end++; // an escaped character never opens or closes a group
      else if (escaped[end] === '{') depth++;
      else if (escaped[end] === '}') depth--;
    }
    const inner = escaped.slice(start, depth === 0 ? end - 1 : end);
    out += escaped.slice(from, start) + inner.replace(/(?<!\\)&/g, '\\&') + (depth === 0 ? '}' : '');
    from = end;
    TEXT_ARGUMENT.lastIndex = end;
  }
  return out + escaped.slice(from);
}

export function renderMarkdown(text: string): string {
  pending = [];
  const html = marked.parse(text, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
  return sanitized.replace(MATH_PLACEHOLDER, (_match, indexStr: string) => {
    const entry = pending[Number(indexStr)];
    if (!entry) return '';
    return katex.renderToString(repairTex(entry.tex), {
      displayMode: entry.display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
    });
  });
}
