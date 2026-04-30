import * as pdfjsLib from 'pdfjs-dist';
// Use the ESM build (.mjs) shipped with `pdfjs-dist` so Vite/Rollup can
// resolve and bundle the worker file correctly at build time.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';

// Set up the worker for PDF.js using the bundled worker URL
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as unknown as string;

/**
 * Extract text from a PDF file
 * @param fileBuffer - Buffer or Uint8Array of the PDF file
 * @returns Promise<string> - Extracted text from the PDF
 */
export async function extractTextFromPDF(fileBuffer: ArrayBuffer | Uint8Array): Promise<string> {
  try {
    const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
    let text = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      text += pageText + '\n';
    }

    return text.trim();
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${(error as Error).message}`);
  }
}

/**
 * Extract text from a PPTX file (OpenXML format - ZIP archive)
 * @param fileBuffer - Buffer or Uint8Array of the PPTX file
 * @returns Promise<string> - Extracted text from the PPTX
 */
export async function extractTextFromPPTX(fileBuffer: ArrayBuffer | Uint8Array): Promise<string> {
  try {
    // PPTX is a ZIP file, parse using jszip
    const zip = new JSZip();
    const unzipped = await zip.loadAsync(fileBuffer);
    
    let text = '';

    // Find and process all slide XML files
    const slideFiles: { path: string; content: string }[] = [];
    
    for (const [path, file] of Object.entries(unzipped.files)) {
      if (path.match(/^ppt\/slides\/slide\d+\.xml$/) && !file.dir) {
        const content = await file.async('string');
        slideFiles.push({ path, content });
      }
    }

    // Sort slide files numerically
    slideFiles.sort((a, b) => {
      const numA = parseInt(a.path.match(/\d+/)![0]);
      const numB = parseInt(b.path.match(/\d+/)![0]);
      return numA - numB;
    });

    // Extract text from each slide
    for (const { content } of slideFiles) {
      const slideText = extractTextFromXml(content);
      if (slideText) {
        text += slideText + '\n';
      }
    }

    return text.trim();
  } catch (error) {
    throw new Error(`Failed to extract text from PPTX: ${(error as Error).message}`);
  }
}

/**
 * Extract text content from Office Open XML
 */
function extractTextFromXml(xml: string): string {
  let text = '';
  
  // Match all text within <a:t> tags (PowerPoint text elements)
  const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
  
  if (textMatches) {
    textMatches.forEach(match => {
      const content = match.replace(/<\/?a:t>/g, '').trim();
      if (content) {
        text += content + ' ';
      }
    });
  }

  return text.trim();
}

/**
 * Extract text from a file (PDF or PPTX)
 * @param fileBuffer - Buffer or Uint8Array of the file
 * @param fileName - Name of the file (used to determine file type)
 * @returns Promise<string> - Extracted text
 */
export async function extractTextFromFile(fileBuffer: ArrayBuffer | Uint8Array, fileName: string): Promise<string> {
  const fileExtension = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));

  if (fileExtension === '.pdf') {
    return extractTextFromPDF(fileBuffer);
  } else if (fileExtension === '.pptx') {
    return extractTextFromPPTX(fileBuffer);
  } else {
    throw new Error(`Unsupported file type: ${fileExtension}. Only PDF and PPTX files are supported.`);
  }
}
