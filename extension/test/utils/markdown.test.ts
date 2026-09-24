// DOMPurify does not sanitize under happy-dom (attributes and tags survive); it supports jsdom.
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, repairTex } from '../../src/utils/markdown';

describe('renderMarkdown: sanitizing', () => {
  it.each([
    ['<script>alert(1)</script>', /<script/i],
    ['<style>body{display:none}</style>', /<style/i],
    ['<iframe src="https://evil.test"></iframe>', /<iframe/i],
    ['<form action="https://evil.test"><input name="pw"></form>', /<form|<input/i],
    ['<img src="x" onerror="alert(1)">', /onerror|<img/i],
    ['<a href="https://a.test" onclick="steal()">x</a>', /onclick/i],
  ])('removes %s', (input, forbidden) => {
    expect(renderMarkdown(input)).not.toMatch(forbidden);
  });

  it('strips style attributes', () => {
    expect(renderMarkdown('<span style="position:fixed;top:0">hi</span>')).not.toMatch(/style=/);
  });

  it('drops images entirely (tracking pixels): only Markdown text tags are allowed', () => {
    expect(renderMarkdown('![chart](https://img.test/c.png)')).not.toMatch(/<img/);
  });

  it('keeps links and opens them in a new tab', () => {
    const html = renderMarkdown('[Syllabus](https://canvas.test/courses/1/files/2)');
    expect(html).toContain('href="https://canvas.test/courses/1/files/2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps tables, lists and code', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- item\n\n`code`');
    expect(html).toMatch(/<table>[\s\S]*<td>1<\/td>/);
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<code>code</code>');
  });
});

describe('renderMarkdown: math', () => {
  it('renders $…$ inline', () => {
    const html = renderMarkdown('Energy is $E = mc^2$ here.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-display');
    expect(html).toContain('here.');
  });

  it('renders a fenced $$ block as display math', () => {
    expect(renderMarkdown('Before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter')).toMatch(/katex-display[\s\S]*After/);
  });

  it('renders single-line $$…$$ mid-paragraph as display math without swallowing the paragraph', () => {
    const html = renderMarkdown('The sum $$\\sum_i i$$ grows, and more text follows.');
    expect(html).toContain('katex-display');
    expect(html).toContain('grows, and more text follows.');
    expect(html.match(/<p>/g)).toHaveLength(1);
  });

  it('renders \\(…\\) and \\[…\\]', () => {
    const html = renderMarkdown('Inline \\(a+b\\) and display \\[c\\]');
    expect(html.match(/class="katex"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('katex-display');
  });

  it('leaves an escaped dollar alone', () => {
    const html = renderMarkdown('It costs \\$5 and \\$10.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$5');
  });

  it('keeps KaTeX layout styles that the sanitizer would strip (math is inserted after sanitizing)', () => {
    expect(renderMarkdown('$\\frac{1}{2}$')).toMatch(/style="/);
  });
});

describe('repairTex: characters copied verbatim from course material', () => {
  const clean = (html: string) => expect(html).not.toContain('katex-error');

  it('renders the slide formula with a bare # inside a text argument', () => {
    const html = renderMarkdown(String.raw`$$P(A) = \frac{\text{# outcomes in } A}{\text{# outcomes in } S}$$ [slide 24]`);
    clean(html);
    expect(html).toContain('katex-display');
    expect(html).toContain('[slide 24]');
  });

  it.each([
    [String.raw`$\text{50% of the grade}$`, 'a % inside text'],
    [String.raw`$50\text{ marks} = 50%$`, 'a % in math'],
    [String.raw`$\text{A & B}$`, 'an & inside text'],
    [String.raw`$\textbf{Q & A} \mbox{#1}$`, 'text relatives'],
  ])('renders %s (%s)', (input) => {
    clean(renderMarkdown(input));
  });

  it('keeps & as a column separator in aligned environments', () => {
    clean(renderMarkdown(`$$\n${String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`}\n$$`));
    expect(repairTex(String.raw`\begin{aligned} a &= b \end{aligned}`)).toBe(String.raw`\begin{aligned} a &= b \end{aligned}`);
  });

  it('leaves escaped characters alone and handles nested braces', () => {
    expect(repairTex(String.raw`\text{\# and \% and \&}`)).toBe(String.raw`\text{\# and \% and \&}`);
    expect(repairTex(String.raw`\text{a {b & c} d} & e`)).toBe(String.raw`\text{a {b \& c} d} & e`);
    expect(repairTex(String.raw`\text{# }x \text{& }`)).toBe(String.raw`\text{\# }x \text{\& }`);
  });
});
