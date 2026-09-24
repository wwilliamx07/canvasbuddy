import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  chunkStructuredDocument,
  extractStructuredFromDOCX,
  extractStructuredFromFile,
  extractStructuredFromPPTX,
  extractStructuredFromText,
  htmlToText,
  pageKindFor,
  type StructuredPage,
} from '../../src/utils/textExtractor';
import { estimateTokenCount } from '../../src/utils/tokens';

const words = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const enc = (s: string) => new TextEncoder().encode(s);

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [path, content] of Object.entries(files)) z.file(path, content);
  return z.generateAsync({ type: 'uint8array' });
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (body: string) => zip({ 'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` });

describe('htmlToText', () => {
  it('turns blocks into lines and collapses whitespace', () => {
    const html = '<h1>Title</h1><p>One   two&nbsp;three</p><ul><li>a</li><li>b</li></ul><p>x<br>y</p>';
    expect(htmlToText(html)).toBe('Title\nOne two three\na\nb\nx\ny');
  });

  it('drops scripts and styles', () => {
    expect(htmlToText('<p>keep</p><script>alert(1)</script><style>p{}</style>')).toBe('keep');
  });

  it('returns empty text for empty input', () => {
    expect(htmlToText('  ')).toBe('');
  });
});

describe('chunkStructuredDocument', () => {
  it('splits a long page with overlap, all chunks citing that page', () => {
    const pages: StructuredPage[] = [{ pageNumber: 3, text: words(1000) }];
    const chunks = chunkStructuredDocument(pages, 400, 50);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect([c.pageNumber, c.pageEnd]).toEqual([3, 3]);
    // 300 words per chunk, 37 overlapping
    const first = chunks[0].content.split(/\s+/);
    const second = chunks[1].content.split(/\s+/);
    expect(first.slice(-37)).toEqual(second.slice(0, 37));
  });

  it('merges a run of small slides into one chunk with its page range', () => {
    const pages = [1, 2, 3, 4, 5].map((n) => ({ pageNumber: n, text: `slide ${n} ${'x'.repeat(60)}` }));
    const chunks = chunkStructuredDocument(pages, 400, 50);
    expect(chunks).toHaveLength(1);
    expect([chunks[0].pageNumber, chunks[0].pageEnd]).toEqual([1, 5]);
  });

  it('never merges normal-sized pages', () => {
    const pages = [1, 2, 3].map((n) => ({ pageNumber: n, text: 'y'.repeat(800) }));
    const chunks = chunkStructuredDocument(pages, 400, 50);
    expect(chunks.map((c) => [c.pageNumber, c.pageEnd])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks[0].tokenCount).toBe(estimateTokenCount('y'.repeat(800)));
  });
});

describe('DOCX', () => {
  it('cuts sections at Heading 1/2 and keeps tables as tab-separated rows', async () => {
    const body =
      para('Intro', 'Heading1') +
      '<w:p><w:r><w:t>First</w:t></w:r><w:r><w:tab/><w:t>para</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc>' + para('A') + '</w:tc><w:tc>' + para('B') + '</w:tc></w:tr></w:tbl>' +
      para('Methods', 'Heading2') +
      para('Second');
    expect(await extractStructuredFromDOCX(await docx(body))).toEqual([
      { pageNumber: 1, text: 'Intro\n\nFirst\tpara\n\nA\tB' },
      { pageNumber: 2, text: 'Methods\n\nSecond' },
    ]);
  });

  it('without headings, cuts sections by size between paragraphs', async () => {
    const body = [0, 1, 2, 3].map((i) => para(words(600, `p${i}_`))).join('');
    const pages = await extractStructuredFromDOCX(await docx(body));
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(pages[0].text.startsWith('p0_0')).toBe(true);
    expect(pages[1].text.startsWith('p2_0')).toBe(true);
  });

  it('reports a missing document part', async () => {
    await expect(extractStructuredFromDOCX(await zip({ 'other.xml': '<x/>' }))).rejects.toThrow(/word\/document.xml/);
  });
});

describe('PPTX', () => {
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slideXml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

  it('reads slides in numeric order', async () => {
    const slide = (t: string) => slideXml(`<a:p><a:r><a:t>${t}</a:t></a:r><a:r><a:t> more</a:t></a:r></a:p>`);
    const file = await zip({
      'ppt/slides/slide10.xml': slide('ten'),
      'ppt/slides/slide2.xml': slide('two'),
      'ppt/slides/slide1.xml': slide('one'),
      'ppt/slides/_rels/slide1.xml.rels': '<x/>',
    });
    expect(await extractStructuredFromPPTX(file)).toEqual([
      { pageNumber: 1, text: 'one more' },
      { pageNumber: 2, text: 'two more' },
      { pageNumber: 10, text: 'ten more' },
    ]);
  });

  it('decodes entities, reads runs with attributes, joins split runs and keeps one line per paragraph', async () => {
    const file = await zip({
      'ppt/slides/slide1.xml': slideXml(
        '<a:p><a:r><a:t>R&amp;D: x &lt; y</a:t></a:r></a:p>' +
          '<a:p><a:r><a:t xml:space="preserve">Hel</a:t></a:r><a:r><a:t>lo</a:t></a:r></a:p>' +
          '<a:p><a:r><a:t>   </a:t></a:r></a:p>'
      ),
    });
    expect(await extractStructuredFromPPTX(file)).toEqual([{ pageNumber: 1, text: 'R&D: x < y\nHello' }]);
  });
});

describe('text fallback', () => {
  it('strips a BOM and normalizes CRLF', () => {
    expect(extractStructuredFromText(enc('﻿line1\r\nline2\rline3'), 'a.txt')).toEqual([{ pageNumber: 1, text: 'line1\nline2\nline3' }]);
  });

  it('cuts sections at line boundaries by size', () => {
    const text = Array.from({ length: 1600 }, (_, i) => `l${i}`).join('\n');
    const pages = extractStructuredFromText(enc(text), 'a.md');
    expect(pages).toHaveLength(2);
    expect(pages[0].text.split('\n')).toHaveLength(1500);
    expect(pages[1].text.startsWith('l1500')).toBe(true);
  });

  it('reads extension-less files as text', async () => {
    expect(await extractStructuredFromFile(enc('all: build'), 'Makefile')).toEqual([{ pageNumber: 1, text: 'all: build' }]);
  });

  it('rejects files with NUL bytes as binary', () => {
    expect(() => extractStructuredFromText(new Uint8Array([72, 0, 73]), 'data.bin')).toThrow(/\.bin is a binary format/);
    // A name without an extension does not lend its last character as one
    expect(() => extractStructuredFromText(new Uint8Array([72, 0, 73]), 'data')).toThrow(/^This file is a binary format/);
  });

  it('rejects files that do not decode as UTF-8', () => {
    expect(() => extractStructuredFromText(new Uint8Array(200).fill(0xff), 'image.heic')).toThrow(/binary format/);
  });
});

describe('pageKindFor', () => {
  it.each([
    ['a.pdf', 'page'],
    ['Deck.PPTX', 'slide'],
    ['notes.docx', 'section'],
    ['code.py', 'section'],
  ])('%s → %s', (name, kind) => {
    expect(pageKindFor(name)).toBe(kind);
  });
});
