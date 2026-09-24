import { beforeEach, describe, expect, it } from 'vitest';
import { htmlToTextWithLinks, linkMarker, parseCanvasHref } from '../../src/utils/canvasLinks';
import { configureCanvas } from '../../src/canvas/http';

beforeEach(() => configureCanvas('canvas.test'));

describe('parseCanvasHref', () => {
  it.each([
    ['/courses/5/files/123', { to_type: 'file', to_ref: '123', course_id: '5' }],
    ['/courses/5/files/123/download?wrap=1', { to_type: 'file', to_ref: '123', course_id: '5' }],
    ['/courses/5/files?preview=456', { to_type: 'file', to_ref: '456', course_id: '5' }],
    ['/api/v1/courses/5/files/123', { to_type: 'file', to_ref: '123', course_id: '5' }],
    ['https://canvas.test/api/v1/courses/5/pages/intro', { to_type: 'page', to_ref: 'intro', course_id: '5' }],
    ['/courses/5/pages/week%201', { to_type: 'page', to_ref: 'week 1', course_id: '5' }],
    ['/courses/5/assignments/77', { to_type: 'assignment', to_ref: '77', course_id: '5' }],
    ['/courses/5/quizzes/8', { to_type: 'quiz', to_ref: '8', course_id: '5' }],
    ['/courses/5/discussion_topics/9', { to_type: 'discussion', to_ref: '9', course_id: '5' }],
    ['/courses/5/announcements/10', { to_type: 'discussion', to_ref: '10', course_id: '5' }],
    ['/courses/5/modules/items/11', { to_type: 'module', to_ref: '11', course_id: '5' }],
    ['/courses/5/modules/12', { to_type: 'module', to_ref: '12', course_id: '5' }],
    ['https://school.instructure.com/courses/5/files/3', { to_type: 'file', to_ref: '3', course_id: '5' }],
  ])('%s', (href, expected) => {
    expect(parseCanvasHref(href)).toEqual(expected);
  });

  it('takes the course from the link over the current course', () => {
    expect(parseCanvasHref('/courses/9/files/1', '5')).toEqual({ to_type: 'file', to_ref: '1', course_id: '9' });
  });

  it('falls back to the current course when the link has none', () => {
    expect(parseCanvasHref('/files/99', '7')).toEqual({ to_type: 'file', to_ref: '99', course_id: '7' });
  });

  it('keeps other Canvas URLs as external links with their course', () => {
    expect(parseCanvasHref('/courses/5/external_tools/3')).toEqual({
      to_type: 'external',
      to_ref: 'https://canvas.test/courses/5/external_tools/3',
      course_id: '5',
    });
  });

  it('treats other hosts as external', () => {
    expect(parseCanvasHref('https://youtube.com/watch?v=1', '5')).toEqual({
      to_type: 'external',
      to_ref: 'https://youtube.com/watch?v=1',
      course_id: null,
    });
  });

  it.each(['#top', 'mailto:prof@canvas.test', 'javascript:alert(1)', 'tel:5551234', '', 'ftp://files.example.com/a'])('ignores %j', (href) => {
    expect(parseCanvasHref(href)).toBeNull();
  });
});

describe('linkMarker', () => {
  it.each([
    ['file', '1', '[file 1]'],
    ['page', 'week-1', '[page week-1]'],
    ['assignment', '2', '[assignment 2]'],
    ['quiz', '3', '[quiz 3]'],
    ['discussion', '4', '[discussion 4]'],
    ['module', '5', '[module 5]'],
    ['external', 'https://a.test/x', '<https://a.test/x>'],
  ] as const)('%s', (to_type, to_ref, marker) => {
    expect(linkMarker({ to_type, to_ref, course_id: null })).toBe(marker);
  });

  it('shortens very long URLs', () => {
    const long = `https://a.test/${'x'.repeat(200)}`;
    const marker = linkMarker({ to_type: 'external', to_ref: long, course_id: null });
    expect(marker.length).toBe(120);
    expect(marker.endsWith('…>')).toBe(true);
  });
});

describe('htmlToTextWithLinks', () => {
  const frontPage = `
    <h2>Welcome to CSC100</h2>
    <p>Read the <a href="/courses/5/files/44">Syllabus</a> and <a href="/courses/5/pages/week-1">Week 1</a>.</p>
    <p><a href="https://zoom.us/j/1">https://zoom.us/j/1</a></p>
    <iframe src="https://www.youtube.com/embed/abc" title="Lecture 1"></iframe>
    <p>Again: <a href="/courses/5/files/44">the syllabus</a>. <a href="#top">Top</a></p>`;

  it('replaces links with text plus a marker the model can act on', () => {
    const { text } = htmlToTextWithLinks(frontPage, '5');
    expect(text).toContain('Welcome to CSC100');
    expect(text).toContain('Read the Syllabus [file 44] and Week 1 [page week-1].');
    expect(text).toContain('Lecture 1 <https://www.youtube.com/embed/abc>');
    expect(text).toContain('Again: the syllabus [file 44].');
  });

  it('does not repeat a URL the anchor text already shows', () => {
    const { text } = htmlToTextWithLinks(frontPage, '5');
    expect(text).toContain('<https://zoom.us/j/1>');
    expect(text).not.toContain('https://zoom.us/j/1 <https://zoom.us/j/1>');
  });

  it('records each target once, in document order, iframes as external', () => {
    const { links } = htmlToTextWithLinks(frontPage, '5');
    expect(links.map((l) => [l.to_type, l.to_ref, l.label, l.position])).toEqual([
      ['file', '44', 'Syllabus', 0],
      ['page', 'week-1', 'Week 1', 1],
      ['external', 'https://zoom.us/j/1', 'https://zoom.us/j/1', 2],
      ['external', 'https://www.youtube.com/embed/abc', 'Lecture 1', 3],
    ]);
  });

  it('prefers data-api-endpoint over href', () => {
    const { links } = htmlToTextWithLinks('<a href="/courses/5/pages/x" data-api-endpoint="https://canvas.test/api/v1/courses/5/pages/real">X</a>');
    expect(links[0].to_ref).toBe('real');
  });

  it('returns nothing for empty input', () => {
    expect(htmlToTextWithLinks('   ')).toEqual({ text: '', links: [] });
  });
});
