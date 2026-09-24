import * as pdfjsLib from 'pdfjs-dist';
// Use the ESM build (.mjs) shipped with `pdfjs-dist` so Vite/Rollup can
// resolve and bundle the worker file correctly at build time.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';
import { estimateTokenCount } from './tokens';

// Set up the worker for PDF.js using the bundled worker URL
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as unknown as string;

export interface StructuredPage {
  pageNumber: number;
  text: string;
}

/**
 * What a "page" of a document is, for citations: a PDF page, a PPTX slide, or a synthetic
 * section (DOCX and plain text have no page boundaries; sections are cut at headings or by size).
 */
export type PageKind = 'page' | 'slide' | 'section';

/** Words per synthetic section for documents without page boundaries. */
const SECTION_WORDS = 1500;

export interface DocumentChunk {
  chunkIndex: number;
  pageNumber?: number;
  /** Last page/slide in the chunk when several small pages were merged; equals pageNumber otherwise */
  pageEnd?: number;
  content: string;
  tokenCount: number;
}

/**
 * Extract structured page-by-page text from a PDF file
 */
export async function extractStructuredFromPDF(fileBuffer: ArrayBuffer | Uint8Array): Promise<StructuredPage[]> {
  let task: ReturnType<typeof pdfjsLib.getDocument> | undefined;
  try {
    task = pdfjsLib.getDocument({ data: fileBuffer });
    const pdf = await task.promise;
    const pages: StructuredPage[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      // pdf.js marks the last item of each visual line with hasEOL; keeping those breaks
      // preserves bullet lists and table rows instead of running them into one line.
      let raw = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        raw += item.str + (item.hasEOL ? '\n' : ' ');
      }
      const pageText = raw
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (pageText) {
        pages.push({ pageNumber: pageNum, text: pageText });
      }
    }

    return pages;
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${(error as Error).message}`);
  } finally {
    // The worker keeps every loaded document until it is destroyed; the panel indexes many
    await task?.destroy().catch(() => {});
  }
}

/**
 * Extract structured slide-by-slide text from a PPTX file
 */
export async function extractStructuredFromPPTX(fileBuffer: ArrayBuffer | Uint8Array): Promise<StructuredPage[]> {
  try {
    const zip = new JSZip();
    const unzipped = await zip.loadAsync(fileBuffer);
    const pages: StructuredPage[] = [];

    // Find and process all slide XML files
    const slideFiles: { path: string; content: string; slideNum: number }[] = [];

    for (const [path, file] of Object.entries(unzipped.files)) {
      const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (match && !file.dir) {
        const content = await file.async('string');
        slideFiles.push({ path, content, slideNum: parseInt(match[1], 10) });
      }
    }

    // Sort slides numerically
    slideFiles.sort((a, b) => a.slideNum - b.slideNum);

    for (const { content, slideNum } of slideFiles) {
      const slideText = pptxSlideText(content);
      if (slideText) {
        pages.push({ pageNumber: slideNum, text: slideText });
      }
    }

    return pages;
  } catch (error) {
    throw new Error(`Failed to extract text from PPTX: ${(error as Error).message}`);
  }
}

/**
 * The text of one slide: each DrawingML paragraph (`a:p`) is a line, its runs (`a:t`) joined as
 * written — a word can be split across runs. Parsed as XML, so entities (`&amp;`, `&lt;`) are
 * decoded and runs with attributes (`xml:space`) are read like any other.
 */
function pptxSlideText(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.getElementsByTagName('a:p'))
    .map((p) =>
      Array.from(p.getElementsByTagName('a:t'))
        .map((t) => t.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract section-by-section text from a DOCX file. Word's XML has no page boundaries, so
 * sections are synthetic: one per Heading 1/2 paragraph when the document has headings,
 * otherwise every ~SECTION_WORDS words. Tables become tab-separated rows; headers, footers
 * and footnotes are ignored.
 */
export async function extractStructuredFromDOCX(fileBuffer: ArrayBuffer | Uint8Array): Promise<StructuredPage[]> {
  try {
    const unzipped = await new JSZip().loadAsync(fileBuffer);
    const documentXml = unzipped.file('word/document.xml');
    if (!documentXml) throw new Error('word/document.xml is missing');
    const doc = new DOMParser().parseFromString(await documentXml.async('string'), 'application/xml');
    const body = doc.getElementsByTagName('w:body')[0] ?? doc.documentElement;

    const blocks: Array<{ text: string; heading: boolean }> = [];
    for (const el of Array.from(body.children)) {
      if (xmlName(el) === 'p') {
        const text = docxParagraphText(el);
        if (text) blocks.push({ text, heading: /^Heading[12]$/i.test(docxParagraphStyle(el)) });
      } else if (xmlName(el) === 'tbl') {
        const rows: string[] = [];
        for (const tr of Array.from(el.getElementsByTagName('w:tr'))) {
          const cells = Array.from(tr.getElementsByTagName('w:tc')).map((tc) =>
            Array.from(tc.getElementsByTagName('w:p')).map(docxParagraphText).filter(Boolean).join(' ')
          );
          if (cells.some(Boolean)) rows.push(cells.join('\t'));
        }
        if (rows.length) blocks.push({ text: rows.join('\n'), heading: false });
      }
    }

    if (blocks.some((b) => b.heading)) {
      const pages: StructuredPage[] = [];
      let current: string[] = [];
      const flush = () => {
        const text = current.join('\n\n').trim();
        if (text) pages.push({ pageNumber: pages.length + 1, text });
        current = [];
      };
      for (const b of blocks) {
        if (b.heading) flush();
        current.push(b.text);
      }
      flush();
      return pages;
    }
    return sectionsBySize(blocks.map((b) => b.text));
  } catch (error) {
    throw new Error(`Failed to extract text from DOCX: ${(error as Error).message}`);
  }
}

/** Element name without its namespace prefix ("w:p" → "p"); DOM implementations differ on whether localName keeps it. */
function xmlName(el: Element): string {
  const name = el.localName || el.tagName;
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** The style id of a Word paragraph ("Heading1", "ListParagraph", …), or ''. */
function docxParagraphStyle(p: Element): string {
  const style = p.getElementsByTagName('w:pStyle')[0];
  return style?.getAttribute('w:val') ?? '';
}

/** The text of a Word paragraph: runs joined in order, tabs and line breaks kept. */
function docxParagraphText(p: Element): string {
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    switch (xmlName(el)) {
      case 't':
        text += el.textContent ?? '';
        return;
      case 'tab':
        text += '\t';
        return;
      case 'br':
      case 'cr':
        text += '\n';
        return;
      case 'tbl': // a nested table inside a cell paragraph is handled by its own row walk
        return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  walk(p);
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Text of any file without a structured extractor: decoded as UTF-8 and cut into sections of
 * ~SECTION_WORDS words at line boundaries. A file that does not decode as text (NUL bytes,
 * a high share of invalid sequences) is rejected as binary rather than indexed as noise.
 */
export function extractStructuredFromText(fileBuffer: ArrayBuffer | Uint8Array, fileName: string): StructuredPage[] {
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) throw unsupportedBinary(fileName);
  const decoded = new TextDecoder('utf-8').decode(bytes);
  const sampleText = decoded.slice(0, 8192);
  const invalid = (sampleText.match(/\uFFFD/g) || []).length;
  if (sampleText.length > 0 && invalid / sampleText.length > 0.05) throw unsupportedBinary(fileName);

  const text = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return sectionsBySize(text.split('\n'), '\n');
}

/** ".pdf" for "Lecture 1.PDF"; "" when the name has no extension ("Makefile"). */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

function unsupportedBinary(fileName: string): Error {
  const ext = extensionOf(fileName);
  return new Error(`${ext || 'This file'} is a binary format CanvasBuddy cannot read; only PDF, PPTX, DOCX and text files are supported.`);
}

/** Groups blocks (paragraphs or lines) into sections of ~SECTION_WORDS words, never splitting a block. */
function sectionsBySize(blocks: string[], separator = '\n\n'): StructuredPage[] {
  const pages: StructuredPage[] = [];
  let current: string[] = [];
  let words = 0;
  const flush = () => {
    const text = current.join(separator).trim();
    if (text) pages.push({ pageNumber: pages.length + 1, text });
    current = [];
    words = 0;
  };
  for (const block of blocks) {
    const n = (block.match(/\S+/g) || []).length;
    if (words > 0 && words + n > SECTION_WORDS) flush();
    current.push(block);
    words += n;
  }
  flush();
  return pages;
}

/** What one "page" of this file is, by extension: PDF pages, PPTX slides, sections for everything else. */
export function pageKindFor(fileName: string): PageKind {
  const ext = extensionOf(fileName);
  if (ext === '.pdf') return 'page';
  if (ext === '.pptx') return 'slide';
  return 'section';
}

/**
 * Extract structured text from a file: PDF pages, PPTX slides, DOCX sections, and for every
 * other type the file decoded as text (source, Markdown, CSV, notebooks, …). Binary formats
 * without an extractor are rejected with a clear error.
 */
export async function extractStructuredFromFile(
  fileBuffer: ArrayBuffer | Uint8Array,
  fileName: string
): Promise<StructuredPage[]> {
  const fileExtension = extensionOf(fileName);

  if (fileExtension === '.pdf') return extractStructuredFromPDF(fileBuffer);
  if (fileExtension === '.pptx') return extractStructuredFromPPTX(fileBuffer);
  if (fileExtension === '.docx') return extractStructuredFromDOCX(fileBuffer);
  return extractStructuredFromText(fileBuffer, fileName);
}

/**
 * Chunk a structured document into retrieval-sized pieces. A long page is split with overlap;
 * a run of small pages/slides is merged into one chunk so a 30-token slide is embedded with its
 * neighbours' context. Every chunk records the page range it covers (pageNumber..pageEnd) for
 * citation, and no chunk ever spans a page that is not small.
 */
export function chunkStructuredDocument(
  pages: StructuredPage[],
  targetChunkTokens: number = 400,
  overlapTokens: number = 50,
  minChunkTokens: number = Math.round(targetChunkTokens / 4)
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let group: StructuredPage[] = [];
  let groupTokens = 0;

  const flush = () => {
    if (group.length === 0) return;
    const content = group.map((p) => p.text).join('\n\n');
    chunks.push({
      chunkIndex: chunks.length,
      pageNumber: group[0].pageNumber,
      pageEnd: group[group.length - 1].pageNumber,
      content,
      tokenCount: estimateTokenCount(content),
    });
    group = [];
    groupTokens = 0;
  };

  for (const page of pages) {
    const pageTokens = estimateTokenCount(page.text);

    if (pageTokens > targetChunkTokens * 1.4) {
      flush();
      // Tokens keep their trailing whitespace so line breaks survive the split
      const words = page.text.match(/\S+\s*/g) || [];
      const wordsPerChunk = Math.max(50, Math.floor(targetChunkTokens * 0.75));
      const overlapWords = Math.max(10, Math.floor(overlapTokens * 0.75));
      let start = 0;
      while (start < words.length) {
        const end = Math.min(words.length, start + wordsPerChunk);
        const content = words.slice(start, end).join('').trim();
        chunks.push({
          chunkIndex: chunks.length,
          pageNumber: page.pageNumber,
          pageEnd: page.pageNumber,
          content,
          tokenCount: estimateTokenCount(content),
        });
        if (end >= words.length) break;
        start += wordsPerChunk - overlapWords;
      }
      continue;
    }

    // Merge only while one side is small and the result stays within the target, so
    // normal-sized pages keep their own chunk (and their own citation).
    const canMerge =
      group.length > 0 &&
      groupTokens + pageTokens <= targetChunkTokens &&
      (groupTokens < minChunkTokens || pageTokens < minChunkTokens);
    if (!canMerge) flush();
    group.push(page);
    groupTokens += pageTokens;
  }
  flush();

  return chunks;
}

/**
 * Convert Canvas HTML (page bodies, assignment descriptions) to readable plain text.
 * Block elements become line breaks so list items and paragraphs stay separated.
 */
export function htmlToText(html: string): string {
  if (!html || !html.trim()) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre').forEach((el) => {
    el.prepend('\n');
    el.append('\n');
  });
  return (doc.body.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
