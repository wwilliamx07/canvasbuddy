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
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ')
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
 * Chunk a structured document into semantically sized pieces preserving page/slide numbers
 */
export function chunkStructuredDocument(
  pages: StructuredPage[],
  targetChunkTokens: number = 400,
  overlapTokens: number = 50
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    const pageTokens = estimateTokens(page.text);

    // If page is reasonably sized (e.g. standard presentation slide or short page), keep as one chunk
    if (pageTokens <= targetChunkTokens * 1.4) {
      chunks.push({
        chunkIndex: chunkIndex++,
        pageNumber: page.pageNumber,
        content: page.text,
        tokenCount: pageTokens,
      });
      continue;
    }

    // Otherwise, split long page into overlapping token segments by sentences or words
    const words = page.text.split(/\s+/);
    let startWordIdx = 0;
    const wordsPerChunk = Math.max(50, Math.floor(targetChunkTokens * 0.75));
    const overlapWords = Math.max(10, Math.floor(overlapTokens * 0.75));

    while (startWordIdx < words.length) {
      const endWordIdx = Math.min(words.length, startWordIdx + wordsPerChunk);
      const chunkText = words.slice(startWordIdx, endWordIdx).join(' ');

      chunks.push({
        chunkIndex: chunkIndex++,
        pageNumber: page.pageNumber,
        content: chunkText,
        tokenCount: estimateTokens(chunkText),
      });

      if (endWordIdx >= words.length) break;
      startWordIdx += wordsPerChunk - overlapWords;
    }
  }

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
