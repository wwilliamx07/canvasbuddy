import * as pdfjsLib from 'pdfjs-dist';
// Use the ESM build (.mjs) shipped with `pdfjs-dist` so Vite/Rollup can
// resolve and bundle the worker file correctly at build time.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

// Set up the worker for PDF.js using the bundled worker URL
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as unknown as string;

export interface StructuredPage {
  pageNumber: number;
  text: string;
}

export interface DocumentChunk {
  chunkIndex: number;
  pageNumber?: number;
  /** Last page/slide in the chunk when several small pages were merged; equals pageNumber otherwise */
  pageEnd?: number;
  content: string;
  tokenCount: number;
}

/**
 * Estimate token count using the standard ~4 chars per token rule
 */
export function estimateTokens(text: string): number {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Extract structured page-by-page text from a PDF file
 */
export async function extractStructuredFromPDF(fileBuffer: ArrayBuffer | Uint8Array): Promise<StructuredPage[]> {
  try {
    const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
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
      const slideText = extractTextFromXml(content);
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
 * Extract text content from Office Open XML
 */
function extractTextFromXml(xml: string): string {
  let text = '';
  const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g);

  if (textMatches) {
    textMatches.forEach((match) => {
      const content = match.replace(/<\/?a:t>/g, '').trim();
      if (content) {
        text += content + ' ';
      }
    });
  }

  return text.trim();
}

/**
 * Extract structured page/slide text from either PDF or PPTX
 */
export async function extractStructuredFromFile(
  fileBuffer: ArrayBuffer | Uint8Array,
  fileName: string
): Promise<StructuredPage[]> {
  const fileExtension = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));

  if (fileExtension === '.pdf') {
    return extractStructuredFromPDF(fileBuffer);
  } else if (fileExtension === '.pptx') {
    return extractStructuredFromPPTX(fileBuffer);
  } else {
    throw new Error(`Unsupported file type: ${fileExtension}. Only PDF and PPTX files are supported.`);
  }
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
      tokenCount: estimateTokens(content),
    });
    group = [];
    groupTokens = 0;
  };

  for (const page of pages) {
    const pageTokens = estimateTokens(page.text);

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
          tokenCount: estimateTokens(content),
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
