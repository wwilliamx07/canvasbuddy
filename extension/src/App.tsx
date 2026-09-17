import { useState, useEffect } from 'react';
import { Navigation } from './components/Navigation/Navigation';
import { ChatUI } from './components/ChatUI/ChatUI';
import type { Message } from './components/ChatUI/ChatUI';
import { Settings, type AppSettings } from './components/Settings/Settings';
import { GraphExplorer } from './components/GraphExplorer/GraphExplorer';
import { extractTextFromFile } from './utils/textExtractor';
import { exploreGraph, getGraphOverviewText } from './db/graph';
import {
  syncCourses,
  syncCourseModules,
  syncModuleItems,
  syncCourseAssignments,
  syncCourseFiles,
  syncCoursePages,
  ensureFresh,
  indexDocumentJustInTime,
} from './canvas/sync';
import { searchChunksHybrid, type DocumentSourceType } from './db/rag';
import { getEmbedding } from './embeddings/embeddingClient';
import './App.css';

// Types for chat persistence and compact model memory
interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  // Gemini 3 attaches an opaque signature to function-call parts and requires it to be
  // echoed back verbatim when the turn is replayed in history.
  thoughtSignature?: string;
}

interface ToolResult {
  id: string;
  name: string;
  result: string; // JSON string
}

// A turn in the model-facing history. Tool calls/results are carried as structured fields so
// each provider gets real function-call turns instead of JSON pasted into a user message.
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];   // assistant turn that requested tools
  toolResults?: ToolResult[]; // user/tool turn that answers them
  thoughtSignature?: string; // Gemini: signature carried on the text part of a model turn
}

// Gemini rejects replayed function calls that carry no signature (e.g. after a provider switch
// or when the model omitted one); this documented placeholder tells it to skip the check.
const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

interface ContextDigest {
  id: string;
  kind: 'conversation' | 'tool_loop';
  content: string;
  createdAt: Date;
  coversUpToIndex?: number;
}

interface Chat {
  id: string;
  title: string;
  messages: Message[]; // Display only - user and assistant messages shown in UI
  contextDigests: ContextDigest[]; // Compact persistent context memory for the model
  createdAt: Date;
  updatedAt: Date;
}

// System prompt for the assistant. The live graph overview is appended per request.
const SYSTEM_PROMPT = `You are a helpful student assistant integrated into Canvas (Quercus at the University of Toronto). You help students manage their courses, assignments, and academic tasks.

You have two sources of information:
- A LOCAL KNOWLEDGE GRAPH (courses, modules, module items, assignments, files, pages) plus a local vector index of document text. Reading it is instant and free.
- The LIVE Canvas API. Slow and expensive; each call returns large payloads.

RULES FOR USING KNOWLEDGE
1. The graph overview at the end of this prompt tells you exactly what is cached and how old it is. Trust it. If the data you need is listed there, answer from the graph with explore_graph; do NOT re-fetch it from Canvas.
2. Only go live (sync_canvas_node or a get_* tool) when: the graph has no data for that course/collection, the overview shows it is stale for a time-sensitive question (assignments older than ~24h, modules older than ~7d), the user says something changed, or you need data the graph never holds (submission status, grades, announcements, messages, planner).
3. After sync_canvas_node, the result already contains the synced data. Do not call explore_graph again for the same thing.
4. Never call the same tool twice with the same arguments in one turn.

RULES FOR QUERYING NARROWLY
5. Ask for exactly what you need. Always pass search_term when the user mentioned a name, topic, or week; pass course_id whenever the course is known; keep limit small (5-25). Do not request 100 rows to find one.
6. Use explore_graph entity types precisely: "assignments" for due dates, "module_items" with search_term to locate a file/page, "modules" for structure. Use full_hierarchy only when the user asks for an overview of a whole course, and never with include_items=true unless they want every item listed.
7. On live get_* tools, use bucket ("upcoming"), search_term, and small per_page. Default per_page is 20; raise it only if the user needs an exhaustive list.

RULES FOR DOCUMENTS
8. To answer from a file, wiki page, or assignment description: find it in the graph (module_items / files / pages / assignments show an "indexed" flag), call index_for_search if it is not indexed, then search_course_knowledge with a specific query and course_id. Do not use extract_text_from_file unless the user explicitly wants the full raw text.
9. Cite what you used: document name and page/slide number, e.g. "Lecture 4 slides, slide 12" or "Syllabus, page 3".

STYLE
10. Be concise and organized. Lead with the answer. Mention when data may be stale and offer to refresh rather than refreshing silently for non-urgent questions.`;

// Tool configuration for Google AI API
interface ToolParameter {
  type: 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
  description: string;
  enum?: string[];
}

interface ToolConfig {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

const TOOL_CONFIG: ToolConfig[] = [
  {
    name: 'get_planner_items',
    description: 'LIVE Canvas call. The student\'s personal planner across all courses (to-dos, upcoming items with submission state). Use for "what do I have this week" style questions; always bound it with start_date/end_date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'Start date in ISO 8601 format (e.g., 2026-03-15). Always set this.' },
        end_date: { type: 'STRING', description: 'End date in ISO 8601 format. Always set this; keep the window as small as the question allows.' },
        per_page: { type: 'INTEGER', description: 'Results per page. Default 20; raise only for an exhaustive list.' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
        filter: { type: 'STRING', description: 'Filter type', enum: ['new_activity'] },
      },
    },
  },
  {
    name: 'get_course_assignments',
    description: 'LIVE Canvas call. Use ONLY for what the local graph does not hold: submission status / grades (include_submission=true) or rubrics. For names, due dates and points use explore_graph(entity_type="assignments") instead. Narrow with bucket and search_term.',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        bucket: { type: 'STRING', description: 'Time bucket. Prefer "upcoming" unless the user asks about past work.', enum: ['upcoming', 'past', 'undated', 'ungraded', 'overdue', 'unsubmitted', 'submitted'] },
        search_term: { type: 'STRING', description: 'Partial assignment name to match. Set this whenever the user named the assignment.' },
        include_submission: { type: 'BOOLEAN', description: 'Include student submission status and score' },
        include_rubric: { type: 'BOOLEAN', description: 'Include rubric assessment' },
        order_by: { type: 'STRING', description: 'Sort results by field', enum: ['due_at', 'name', 'position'] },
        per_page: { type: 'INTEGER', description: 'Results per page. Default 20; raise only for an exhaustive list.' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_course_announcements',
    description: 'LIVE Canvas call. Announcements for a course, newest first. Not cached in the graph. Use search_term when the user mentions a topic; default per_page is 10.',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        search_term: { type: 'STRING', description: 'Partial title to match' },
        order_by: { type: 'STRING', description: 'Sort results by field', enum: ['recent_activity', 'position', 'title'] },
        scope: { type: 'STRING', description: 'Filter announcements by scope', enum: ['locked', 'unlocked', 'pinned', 'unpinned'] },
        per_page: { type: 'INTEGER', description: 'Results per page. Default 10.' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_conversations',
    description: 'LIVE Canvas call. The student\'s inbox conversations. Not cached. Prefer scope="unread" unless asked otherwise; default per_page is 10.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: { type: 'STRING', description: 'Filter conversations by scope', enum: ['unread', 'starred', 'archived'] },
        per_page: { type: 'INTEGER', description: 'Results per page. Default 10.' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
    },
  },
  {
    name: 'get_assignment_details',
    description: 'LIVE Canvas call. Full details of one assignment including its description HTML and submission info. Prefer index_for_search(source_type="assignment") + search_course_knowledge when the question is about what the description says.',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        assignment_id: { type: 'STRING', description: 'ID of the assignment' },
      },
      required: ['course_id', 'assignment_id'],
    },
  },
  {
    name: 'get_file_metadata',
    description: 'LIVE Canvas call. Metadata (size, type, dates, URL) for one file. explore_graph(entity_type="files") already has this for synced courses.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_id: { type: 'STRING', description: 'ID of the file' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'extract_text_from_file',
    description: 'LAST RESORT. Downloads a whole PDF/PPTX and returns ALL of its text (can be tens of thousands of tokens). Only use when the user explicitly asks for the full raw text. Otherwise use index_for_search + search_course_knowledge.',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_id: { type: 'STRING', description: 'ID of the file to extract text from' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'explore_graph',
    description: 'READ the local knowledge graph (instant, no network). Returns compact rows with a synced_age_hours field and an "indexed" flag on documents. Always filter: pass course_id when known, search_term for anything the user named, and a small limit.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entity_type: {
          type: 'STRING',
          description: 'courses: enrolled courses with per-collection sync ages and counts. modules: a course\'s modules. module_items: items inside modules (files, pages, assignments, quizzes) — the way to find a specific document. assignments: names, due dates, points. files: the course Files list. pages: wiki pages. full_hierarchy: whole-course tree (only for course overviews).',
          enum: ['courses', 'modules', 'module_items', 'assignments', 'files', 'pages', 'full_hierarchy'],
        },
        course_id: { type: 'STRING', description: 'Course ID. Required for full_hierarchy; pass it for everything else whenever the course is known.' },
        module_id: { type: 'STRING', description: 'Module ID to restrict module_items to one module' },
        search_term: { type: 'STRING', description: 'Case-insensitive substring on the name/title. Use it whenever the user mentioned a name, topic, week, or lecture number.' },
        limit: { type: 'INTEGER', description: 'Max rows (default 25, max 200). Keep it small.' },
        include_items: { type: 'BOOLEAN', description: 'full_hierarchy only: include every module item (default false = modules with counts only)' },
      },
      required: ['entity_type'],
    },
  },
  {
    name: 'sync_canvas_node',
    description: 'LIVE Canvas call that refreshes one collection of the local graph (pruning items deleted upstream) and RETURNS the refreshed rows, so no follow-up explore_graph is needed. Use when the overview shows the collection is missing or stale, or the user says something changed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: {
          type: 'STRING',
          description: 'courses: enrolled courses. modules: modules + their items for a course. module_items: items of one module. assignments: a course\'s assignments. files: a course\'s Files list (metadata only). pages: a course\'s wiki page titles.',
          enum: ['courses', 'modules', 'module_items', 'assignments', 'files', 'pages'],
        },
        course_id: { type: 'STRING', description: 'Course ID (required for everything except courses)' },
        module_id: { type: 'STRING', description: 'Module ID (required for module_items)' },
        search_term: { type: 'STRING', description: 'Optional: only include rows matching this in the returned data (the whole collection is still synced).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'index_for_search',
    description: 'Make a document searchable: downloads/fetches it, chunks it with page or slide numbers, embeds it, and stores it locally. Idempotent (returns "cached" if already indexed at the same version). Works for PDF/PPTX files, wiki pages, and assignment descriptions.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source_type: { type: 'STRING', description: 'file (default): a Canvas file. page: a wiki page. assignment: an assignment description.', enum: ['file', 'page', 'assignment'] },
        source_id: { type: 'STRING', description: 'Canvas file id (content_ref of a File item), page slug (content_ref of a Page item / page_url), or assignment id' },
        course_id: { type: 'STRING', description: 'Course ID. Required for page and assignment; strongly recommended for files.' },
      },
      required: ['source_id'],
    },
  },
  {
    name: 'search_course_knowledge',
    description: 'Hybrid (keyword + semantic) search over locally indexed documents. Returns the best-matching excerpts with document name and page/slide for citation. Only finds documents that have been indexed — check the "indexed" flag in explore_graph first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Specific question or key phrase. Include distinctive terms from the user\'s question (theorem names, question numbers, concepts).' },
        course_id: { type: 'STRING', description: 'Restrict to one course. Pass it whenever the course is known.' },
        limit: { type: 'INTEGER', description: 'Max excerpts (default 5, max 15)' },
      },
      required: ['query'],
    },
  },
];

// Utility function to build query parameters from tool arguments
function buildQueryString(args: Record<string, string>): string {
  const params = new URLSearchParams();
  
  for (const [key, value] of Object.entries(args)) {
    // Tool params like include_submission=true map to Canvas's include[]=submission
    if (key.startsWith('include_')) {
      if (value === 'true' || value === '1') {
        params.append('include[]', key.slice('include_'.length));
      }
      continue;
    }
    if (value) {
      // Check if this is an array parameter with multiple values (stored with \x00 separator)
      if (key.includes('[]') && value.includes('\x00')) {
        // Split and append each value separately
        const values = value.split('\x00');
        for (const v of values) {
          params.append(key, v);
        }
      } else {
        params.set(key, value);
      }
    }
  }
  
  const queryString = params.toString();
  return queryString ? '?' + queryString : '';
}

// Tool implementation functions with proper origin and credentials
const toolFunctions: Record<string, (args: Record<string, string>, currentSettings: AppSettings) => Promise<string>> = {
  get_planner_items: async (args) => {
    try {
      const params = { per_page: '20', ...args };
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/planner/items${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_course_assignments: async (args: any) => {
    try {
      if (!args.course_id) {
        return JSON.stringify({ error: 'course_id is required' });
      }
      const params = { per_page: '20', ...args };
      const courseId = (params as any).course_id;
      delete (params as any).course_id;
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${courseId}/assignments${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_course_announcements: async (args: any) => {
    try {
      if (!args.course_id) {
        return JSON.stringify({ error: 'course_id is required' });
      }
      const params = { only_announcements: 'true', per_page: '10', ...args };
      const courseId = (params as any).course_id;
      delete (params as any).course_id;
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${courseId}/discussion_topics${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_conversations: async (args) => {
    try {
      const params = { per_page: '10', ...args };
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/conversations${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_assignment_details: async (args) => {
    try {
      if (!args.course_id || !args.assignment_id) {
        return JSON.stringify({ error: 'course_id and assignment_id are required' });
      }
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${args.course_id}/assignments/${args.assignment_id}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_course_quizzes: async (args: any) => {
    try {
      if (!args.course_id) {
        return JSON.stringify({ error: 'course_id is required' });
      }
      const params = { per_page: '20', ...args };
      const courseId = (params as any).course_id;
      delete (params as any).course_id;
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${courseId}/quizzes${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_file_metadata: async (args) => {
    try {
      if (!args.file_id) {
        return JSON.stringify({ error: 'file_id is required' });
      }
      const response = await fetch(`https://q.utoronto.ca/api/v1/files/${args.file_id}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  extract_text_from_file: async (args) => {
    try {
      if (!args.file_id) {
        return JSON.stringify({ error: 'file_id is required' });
      }
      // First, get the file metadata to get the filename
      const fileMetadataResponse = await fetch(`https://q.utoronto.ca/api/v1/files/${args.file_id}`, {
        credentials: 'include',
      });
      const fileMetadata = await fileMetadataResponse.json();
      const fileName = fileMetadata.filename;

      // Get the public URL of the file
      const urlResponse = await fetch(`https://q.utoronto.ca/api/v1/files/${args.file_id}/public_url`, {
        credentials: 'include',
      });
      const urlData = await urlResponse.json();
      const fileUrl = urlData["public_url"];

      if (!fileUrl) {
        return JSON.stringify({ error: 'Unable to get file URL' });
      }

      // Download the file
      const fileResponse = await fetch(fileUrl);
      const fileBuffer = await fileResponse.arrayBuffer();

      // Extract text using local utility
      const text = await extractTextFromFile(fileBuffer, fileName);
      return JSON.stringify({ text });
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  explore_graph: async (args) => {
    try {
      const entityType = args.entity_type as any;
      const limit = args.limit ? parseInt(args.limit, 10) : undefined;
      const notes: string[] = [];

      // Deterministic freshness for time-sensitive data: due dates older than a day get
      // refreshed before answering, without relying on the model to notice the age.
      if (entityType === 'assignments' && args.course_id) {
        try {
          const fresh = await ensureFresh(args.course_id, 'assignments', 24);
          if (fresh.refreshed) notes.push('Assignments were automatically re-synced from Canvas because the cached copy was missing or older than 24h.');
        } catch (e) {
          notes.push(`Automatic assignment refresh failed (${(e as Error).message}); showing cached data.`);
        }
      }

      const data = await exploreGraph({
        entity_type: entityType,
        course_id: args.course_id,
        module_id: args.module_id,
        search_term: args.search_term,
        limit,
        include_items: args.include_items === 'true',
      });

      const isEmpty = !data || (Array.isArray(data) && data.length === 0);
      if (isEmpty) {
        return JSON.stringify({
          data: [],
          message: args.search_term
            ? `No local ${entityType} match "${args.search_term}". Try a shorter search_term, or sync_canvas_node if this collection was never synced for the course.`
            : `No local ${entityType} for this query. Call sync_canvas_node with target "${entityType === 'module_items' ? 'modules' : entityType}" to fetch from Canvas.`,
        });
      }

      const rows = Array.isArray(data) ? data : data;
      return JSON.stringify(notes.length ? { notes, data: rows } : rows);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  sync_canvas_node: async (args) => {
    try {
      const target = args.target;
      const needsCourse = target !== 'courses';
      if (needsCourse && !args.course_id) {
        return JSON.stringify({ error: `course_id is required to sync ${target}` });
      }
      if (target === 'module_items' && !args.module_id) {
        return JSON.stringify({ error: 'module_id is required to sync module_items' });
      }

      let summary: string;
      let exploreType: Parameters<typeof exploreGraph>[0]['entity_type'];

      switch (target) {
        case 'courses': {
          const res = await syncCourses();
          summary = `Synced ${res.count} active courses.`;
          exploreType = 'courses';
          break;
        }
        case 'modules': {
          const res = await syncCourseModules(args.course_id);
          summary = `Synced ${res.modulesUpserted} modules (${res.modulesPruned} pruned) and ${res.itemsUpserted} items for course ${args.course_id}.`;
          exploreType = 'modules';
          break;
        }
        case 'module_items': {
          const res = await syncModuleItems(args.course_id, args.module_id);
          summary = `Synced ${res.upserted} items (${res.pruned} pruned) for module ${args.module_id}.`;
          exploreType = 'module_items';
          break;
        }
        case 'assignments': {
          const res = await syncCourseAssignments(args.course_id);
          summary = `Synced ${res.upserted} assignments (${res.pruned} pruned) for course ${args.course_id}.`;
          exploreType = 'assignments';
          break;
        }
        case 'files': {
          const res = await syncCourseFiles(args.course_id);
          summary = `Synced ${res.upserted} files (${res.pruned} pruned) for course ${args.course_id}.`;
          exploreType = 'files';
          break;
        }
        case 'pages': {
          const res = await syncCoursePages(args.course_id);
          summary = `Synced ${res.upserted} pages (${res.pruned} pruned) for course ${args.course_id}.`;
          exploreType = 'pages';
          break;
        }
        default:
          return JSON.stringify({ error: `Unknown sync target: ${target}` });
      }

      // Return the refreshed rows so the model does not need a second call
      const data = await exploreGraph({
        entity_type: exploreType,
        course_id: args.course_id,
        module_id: args.module_id,
        search_term: args.search_term,
        limit: 50,
      });

      return JSON.stringify({ message: summary, data });
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  index_for_search: async (args, currentSettings) => {
    try {
      const sourceId = args.source_id || args.file_id;
      if (!sourceId) return JSON.stringify({ error: 'source_id is required' });
      const sourceType = ((args.source_type as DocumentSourceType) || 'file');

      const res = await indexDocumentJustInTime(
        { sourceType, sourceId, courseId: args.course_id },
        currentSettings
      );
      return JSON.stringify({
        status: res.status,
        document: res.title,
        source_type: res.sourceType,
        chunks_count: res.chunksCount,
        message:
          res.status === 'cached'
            ? `"${res.title}" is already indexed (${res.chunksCount} chunks). Call search_course_knowledge now.`
            : `Indexed "${res.title}" into ${res.chunksCount} chunks. Call search_course_knowledge now.`,
      });
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  // Backward-compatible alias
  index_file_for_search: async (args, currentSettings) =>
    toolFunctions.index_for_search({ ...args, source_type: 'file', source_id: args.file_id || args.source_id }, currentSettings),
  search_course_knowledge: async (args, currentSettings) => {
    try {
      if (!args.query) return JSON.stringify({ error: 'query is required' });
      const limit = Math.min(15, args.limit ? parseInt(args.limit, 10) || 5 : 5);
      const queryVector = await getEmbedding(args.query, currentSettings, 'query');
      const results = await searchChunksHybrid(args.query, queryVector, args.course_id, limit);
      if (results.length === 0) {
        return JSON.stringify({
          results: [],
          message:
            'No matching excerpts. Either nothing relevant is indexed yet (check the "indexed" flag in explore_graph and call index_for_search), or try different key terms.',
        });
      }
      return JSON.stringify({
        results: results.map((r) => ({
          document: r.filename,
          source_type: r.source_type,
          page_or_slide: r.page_number != null ? r.page_number : 'N/A',
          course: r.course_name || 'Unknown',
          module: r.module_name || null,
          url: r.html_url || null,
          similarity_score: Math.round(r.similarity * 100) / 100,
          excerpt: r.content,
        })),
      });
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
};

// Parse function calls from Google AI response
type FunctionCall = ToolCall;

// Convert the Google-style TOOL_CONFIG to OpenAI's function-tool schema
function toOpenAITools(tools: ToolConfig[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters.properties).map(([key, param]) => [
            key,
            {
              type: param.type.toLowerCase(),
              description: param.description,
              ...(param.enum ? { enum: param.enum } : {}),
            },
          ])
        ),
        required: tool.parameters.required || [],
      },
    },
  }));
}

function parseJsonOrString(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// OpenAI chat format: system/user/assistant(+tool_calls)/tool messages
function toOpenAIMessages(messages: ConversationMessage[]): any[] {
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.toolResults?.length) {
      for (const r of msg.toolResults) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.result });
      }
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

// Gemini format: systemInstruction + contents with text / functionCall / functionResponse parts
function toGeminiRequest(messages: ConversationMessage[]): { systemInstruction?: any; contents: any[] } {
  const systemTexts: string[] = [];
  const contents: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemTexts.push(msg.content);
      continue;
    }
    if (msg.toolResults?.length) {
      contents.push({
        role: 'user',
        parts: msg.toolResults.map((r) => ({
          functionResponse: { name: r.name, response: { result: parseJsonOrString(r.result) } },
        })),
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts: any[] = [];
      if (msg.content) {
        parts.push({ text: msg.content, ...(msg.thoughtSignature ? { thoughtSignature: msg.thoughtSignature } : {}) });
      }
      const anySigned = msg.toolCalls.some((c) => c.thoughtSignature);
      msg.toolCalls.forEach((c, i) => {
        const part: any = { functionCall: { name: c.name, args: c.args } };
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
        else if (!anySigned && i === 0) part.thoughtSignature = GEMINI_SKIP_SIGNATURE;
        parts.push(part);
      });
      contents.push({ role: 'model', parts });
      continue;
    }
    if (msg.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: msg.content, ...(msg.thoughtSignature ? { thoughtSignature: msg.thoughtSignature } : {}) }],
      });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }

  return {
    systemInstruction: systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
    contents,
  };
}

function parseFunctionCalls(responseData: any): FunctionCall[] {
  const functionCalls: FunctionCall[] = [];

  // OpenAI: choices[0].message.tool_calls[].function.{name, arguments (JSON string)}
  const openAIToolCalls = responseData?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(openAIToolCalls)) {
    for (const call of openAIToolCalls) {
      if (call?.function?.name) {
        let args: Record<string, any> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        functionCalls.push({ id: call.id || `call_${functionCalls.length}`, name: call.function.name, args });
      }
    }
    return functionCalls;
  }

  // Google: candidates[0].content.parts[].functionCall
  if (!responseData.candidates || responseData.candidates.length === 0) {
    return functionCalls;
  }

  const candidate = responseData.candidates[0];
  if (!candidate.content || !candidate.content.parts) {
    return functionCalls;
  }

  for (const part of candidate.content.parts) {
    if (part.functionCall) {
      functionCalls.push({
        id: part.functionCall.id || `call_${functionCalls.length}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  }

  return functionCalls;
}

// Extract text content from Google AI response
// Gemini: signature attached to a text part of the model turn (needed when replaying it)
function extractTextThoughtSignature(responseData: any): string | undefined {
  const parts = responseData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && parts[i].thoughtSignature) return parts[i].thoughtSignature;
  }
  return undefined;
}

function extractTextContent(responseData: any): string {
  if (!responseData.candidates || responseData.candidates.length === 0) {
    return '';
  }

  const candidate = responseData.candidates[0];
  if (!candidate.content || !candidate.content.parts) {
    return '';
  }

  let output = '';
  for (const part of candidate.content.parts) {
    if (part.text) {
      output += part.text;
    }
  }

  return output;
}

function estimateTokenCount(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateConversationTokens(messages: ConversationMessage[]): number {
  return messages.reduce((total, message) => {
    let tokens = estimateTokenCount(message.content) + 4;
    for (const call of message.toolCalls || []) tokens += estimateTokenCount(JSON.stringify(call.args)) + 8;
    for (const res of message.toolResults || []) tokens += estimateTokenCount(res.result) + 8;
    return total + tokens;
  }, 0);
}

function toConversationMessage(message: Message): ConversationMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

function digestToConversationMessage(digest: ContextDigest): ConversationMessage {
  const label = digest.kind === 'tool_loop' ? 'Tool loop memory' : 'Conversation memory';
  return {
    role: 'system',
    content: `[${label} | ${digest.createdAt.toISOString()}]\n${digest.content}`,
  };
}

function getConversationCoverageIndex(digests: ContextDigest[]): number {
  return digests.reduce((maxIndex, digest) => {
    if (digest.kind === 'conversation' && typeof digest.coversUpToIndex === 'number') {
      return Math.max(maxIndex, digest.coversUpToIndex);
    }

    return maxIndex;
  }, -1);
}

function buildApiHistory(
  displayMessages: Message[],
  digests: ContextDigest[],
  transientMessages: ConversationMessage[] = [],
  graphOverview: string | null = null
): ConversationMessage[] {
  const orderedDigests = [...digests].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const coveredUpToIndex = getConversationCoverageIndex(orderedDigests);
  const systemMessage: ConversationMessage = {
    role: 'system',
    content: graphOverview ? `${SYSTEM_PROMPT}\n\n${graphOverview}` : SYSTEM_PROMPT,
  };

  return [
    systemMessage,
    ...orderedDigests.map(digestToConversationMessage),
    ...displayMessages.slice(coveredUpToIndex + 1).map(toConversationMessage),
    ...transientMessages,
  ];
}

function takeMessagesByTokenBudget(messages: Message[], tokenBudget: number): Message[] {
  const selected: Message[] = [];
  let totalTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateTokenCount(message.content);
    if (selected.length > 0 && totalTokens + messageTokens > tokenBudget) {
      break;
    }

    selected.push(message);
    totalTokens += messageTokens;
  }

  return selected;
}

async function generateDigestText(
  transcript: ConversationMessage[],
  settings: AppSettings,
  callLLMFn: (messages: ConversationMessage[], settings: AppSettings, includeTools?: boolean) => Promise<{ text: string; rawResponse: any }>,
  kind: 'conversation' | 'tool_loop'
): Promise<string> {
  const prompt = kind === 'tool_loop'
    ? 'Summarize what was learned from this tool-call loop. Return only a compact persistent memory digest. Record: durable facts (course ids, module/assignment/file names and ids, due dates), which collections are now synced in the local graph and which documents are now indexed for search (so they are NOT re-fetched or re-indexed later), and next steps. Do not repeat raw tool payloads.'
    : 'Summarize this conversation segment into a compact persistent memory digest. Preserve durable facts, decisions, user preferences, course structure, and unresolved tasks. Do not repeat raw text or verbose detail.';

  const response = await callLLMFn(
    [
      { role: 'system', content: prompt },
      ...transcript,
    ],
    settings,
    false
  );

  return response.text.trim();
}

// Clean up temporary tool results from history before saving (they're only needed during API calls)
// function cleanupToolResults(history: ConversationMessage[]): ConversationMessage[] {
//   return history.filter(msg => !(msg.role === 'user' && msg.content.startsWith('Tool results:')));
// }

function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'graph' | 'settings'>('chat');
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]); // Display messages only
  const [contextDigests, setContextDigests] = useState<ContextDigest[]>([]); // Compact persistent memory only
  const [isLoading, setIsLoading] = useState(false);
  const [currentContextTokens, setCurrentContextTokens] = useState(0);
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: '',
    baseUrl: '',
    model: 'gemini-3.1-flash-lite-preview',
    embeddingModel: 'gemini-embedding-2',
    llmProvider: 'google',
    contextThreshold: 15000,
  });

  // Load chats from localStorage on mount
  useEffect(() => {
    const savedChats = localStorage.getItem('canvas-buddy-chats');
    if (savedChats) {
      try {
        const parsed: Chat[] = JSON.parse(savedChats).map((chat: any) => ({
          ...chat,
          createdAt: new Date(chat.createdAt),
          updatedAt: new Date(chat.updatedAt),
          messages: chat.messages.map((msg: any) => ({
            ...msg,
            timestamp: new Date(msg.timestamp),
          })),
          contextDigests: (chat.contextDigests || []).map((digest: any) => ({
            ...digest,
            createdAt: new Date(digest.createdAt),
          })),
        }));
        setChats(parsed);
        if (parsed.length > 0) {
          const lastChat = parsed[parsed.length - 1];
          setCurrentChatId(lastChat.id);
          setMessages(lastChat.messages);
          setContextDigests(lastChat.contextDigests || []);
        }

        // Rewrite persisted chats without legacy raw conversation history.
        localStorage.setItem('canvas-buddy-chats', JSON.stringify(parsed));
      } catch (error) {
        console.error('Failed to load chats:', error);
      }
    }

    // Load settings from localStorage
    const savedSettings = localStorage.getItem('canvas-buddy-settings');
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        setSettings({
          apiKey: '',
          baseUrl: '',
          model: 'gemini-3.1-flash-lite-preview',
          embeddingModel: 'gemini-embedding-2',
          llmProvider: 'google',
          contextThreshold: 15000,
          ...parsed,
        });
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    }
  }, []);

  // Save current chat to localStorage
  const saveCurrentChat = (chatId: string, msgs: Message[], digests: ContextDigest[]) => {
    setChats((prevChats) => {
      const updated = prevChats.map((chat) =>
        chat.id === chatId
          ? { ...chat, messages: msgs, contextDigests: digests, updatedAt: new Date() }
          : chat
      );
      localStorage.setItem('canvas-buddy-chats', JSON.stringify(updated));
      return updated;
    });
  };

  // Create a new chat
  const createNewChat = (): string => {
    const newChatId = Date.now().toString();
    const newChat: Chat = {
      id: newChatId,
      title: `Chat ${new Date().toLocaleString()}`,
      messages: [],
      contextDigests: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setChats((prevChats) => {
      const updated = [...prevChats, newChat];
      localStorage.setItem('canvas-buddy-chats', JSON.stringify(updated));
      return updated;
    });
    setCurrentChatId(newChatId);
    setMessages([]);
    setContextDigests([]);
    return newChatId;
  };

  // Switch to a different chat
  const switchChat = (chatId: string) => {
    if (currentChatId) {
      saveCurrentChat(currentChatId, messages, contextDigests);
    }
    const chat = chats.find((c) => c.id === chatId);
    if (chat) {
      setCurrentChatId(chatId);
      setMessages(chat.messages);
      setContextDigests(chat.contextDigests || []);
    }
  };

  // Delete a chat
  const deleteChat = (chatId: string) => {
    const updated = chats.filter((c) => c.id !== chatId);
    setChats(updated);
    localStorage.setItem('canvas-buddy-chats', JSON.stringify(updated));

    if (currentChatId === chatId) {
      if (updated.length > 0) {
        const lastChat = updated[updated.length - 1];
        setCurrentChatId(lastChat.id);
        setMessages(lastChat.messages);
        setContextDigests(lastChat.contextDigests || []);
      } else {
        setCurrentChatId(null);
        setMessages([]);
        setContextDigests([]);
      }
    }
  };

  // Handle settings change
  const handleSettingsChange = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem('canvas-buddy-settings', JSON.stringify(newSettings));
  };

  useEffect(() => {
    if (!currentChatId) {
      setCurrentContextTokens(0);
      return;
    }

    const apiHistory = buildApiHistory(messages, contextDigests);
    setCurrentContextTokens(estimateConversationTokens(apiHistory));
  }, [messages, contextDigests, currentChatId, settings.contextThreshold]);

  // Call LLM API with support for both OpenAI and Google AI
  const callLLM = async (
    messages: ConversationMessage[],
    settings: AppSettings,
    includeTools: boolean = true
  ): Promise<{ text: string; rawResponse: any }> => {
    if (settings.llmProvider === 'openai') {
      // OpenAI API call
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: toOpenAIMessages(messages),
          max_tokens: 2000,
          ...(includeTools && TOOL_CONFIG.length > 0 ? { tools: toOpenAITools(TOOL_CONFIG) } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        text: data.choices[0].message.content || '',
        rawResponse: data,
      };
    } else if (settings.llmProvider === 'google') {
      // Google AI API call with tool support
      const { systemInstruction, contents } = toGeminiRequest(messages);
      const requestBody: any = {
        ...(systemInstruction ? { systemInstruction } : {}),
        contents,
        generationConfig: {
          maxOutputTokens: 2000,
        },
      };

      // Include tools configuration for Google AI
      if (includeTools && TOOL_CONFIG.length > 0) {
        requestBody.tools = [
          {
            functionDeclarations: TOOL_CONFIG,
          },
        ];
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      const data = await response.json();
      const textContent = extractTextContent(data);
      
      return {
        text: textContent,
        rawResponse: data,
      };
    } else {
      throw new Error('Unknown LLM provider');
    }
  };

  const ensureContextWithinThreshold = async (
    displayMessages: Message[],
    digests: ContextDigest[]
  ): Promise<ContextDigest[]> => {
    let nextDigests = [...digests];
    let apiHistory = buildApiHistory(displayMessages, nextDigests);
    let estimatedTokens = estimateConversationTokens(apiHistory);

    while (estimatedTokens > settings.contextThreshold) {
      const coveredUpToIndex = getConversationCoverageIndex(nextDigests);
      const remainingMessages = displayMessages.slice(coveredUpToIndex + 1);

      if (remainingMessages.length === 0) {
        break;
      }

      const sliceBudget = Math.max(1000, Math.floor(settings.contextThreshold * 0.25));
      const messagesToDigest = takeMessagesByTokenBudget(remainingMessages, sliceBudget);

      if (messagesToDigest.length === 0) {
        break;
      }

      const digestText = await generateDigestText(
        messagesToDigest.map(toConversationMessage),
        settings,
        callLLM,
        'conversation'
      );

      if (!digestText) {
        break;
      }

      nextDigests = [
        ...nextDigests,
        {
          id: `digest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: 'conversation',
          content: digestText,
          createdAt: new Date(),
          coversUpToIndex: coveredUpToIndex + messagesToDigest.length,
        },
      ];

      apiHistory = buildApiHistory(displayMessages, nextDigests);
      estimatedTokens = estimateConversationTokens(apiHistory);
    }

    return nextDigests;
  };

  // Chat handlers
  const handleSendMessage = async (content: string) => {
    const hadActiveChat = Boolean(currentChatId);
    const activeChatId = hadActiveChat ? currentChatId! : createNewChat();
    const baseMessages = hadActiveChat ? messages : [];
    const baseDigests = hadActiveChat ? contextDigests : [];

    // Create user message for display
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    let currentMessages = [...baseMessages, userMessage];
    setMessages(currentMessages);

    let currentDigests = [...baseDigests];
    currentDigests = await ensureContextWithinThreshold(currentMessages, currentDigests);
    setContextDigests(currentDigests);

    saveCurrentChat(activeChatId, currentMessages, currentDigests);
    setIsLoading(true);

    try {
      // Tell the model what is already cached so it does not re-fetch it.
      let graphOverview: string | null = null;
      try {
        graphOverview = await getGraphOverviewText();
      } catch (e) {
        console.warn('Graph overview unavailable:', e);
      }

      let currentApiHistory = buildApiHistory(currentMessages, currentDigests, [], graphOverview);
      const toolLoopTranscript: ConversationMessage[] = [];
      let usedToolsInLoop = false;

      // Keep calling the API until there are no more tool calls
      const MAX_TOOL_ROUNDS = 12;
      let toolRounds = 0;
      while (true) {
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          throw new Error(`Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls without a final answer.`);
        }
        const result = await callLLM(currentApiHistory, settings);

        // Parse function calls from response (Google or OpenAI format)
        const functionCalls = parseFunctionCalls(result.rawResponse);

        if (result.text) {
          const assistantMessage: Message = {
            id: (Date.now() + Math.random()).toString(),
            role: 'assistant',
            content: result.text,
            timestamp: new Date(),
          };

          currentMessages = [...currentMessages, assistantMessage];
          setMessages(currentMessages);

          if (usedToolsInLoop) {
            toolLoopTranscript.push({
              role: 'assistant',
              content: result.text,
            });
          }
        }

        // Record the assistant turn once, carrying any tool calls it made
        const textSignature = extractTextThoughtSignature(result.rawResponse);
        currentApiHistory = [...currentApiHistory, {
          role: 'assistant',
          content: result.text || '',
          ...(functionCalls.length > 0 ? { toolCalls: functionCalls } : {}),
          ...(textSignature ? { thoughtSignature: textSignature } : {}),
        }];

        if (functionCalls.length === 0) {
          if (usedToolsInLoop && toolLoopTranscript.length > 0) {
            const toolLoopDigest = await generateDigestText(toolLoopTranscript, settings, callLLM, 'tool_loop');
            if (toolLoopDigest) {
              currentDigests = [
                ...currentDigests,
                {
                  id: `digest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  kind: 'tool_loop',
                  content: toolLoopDigest,
                  createdAt: new Date(),
                },
              ];
            }
          }

          currentDigests = await ensureContextWithinThreshold(currentMessages, currentDigests);
          setMessages(currentMessages);
          setContextDigests(currentDigests);
          saveCurrentChat(activeChatId, currentMessages, currentDigests);
          break;
        }

        usedToolsInLoop = true;
        toolRounds += 1;

        // Execute tools and keep results transient during the loop only.
        const toolResults: ToolResult[] = [];

        for (const functionCall of functionCalls) {
          const toolImpl = toolFunctions[functionCall.name];
          let toolResult = JSON.stringify({ error: 'Tool not found' });

          if (toolImpl) {
            try {
              const stringArgs = Object.entries(functionCall.args).reduce((acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              }, {} as Record<string, string>);

              toolResult = await toolImpl(stringArgs, settings);
            } catch (error) {
              toolResult = JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          toolResults.push({ id: functionCall.id, name: functionCall.name, result: toolResult });

          toolLoopTranscript.push({
            role: 'user',
            content: JSON.stringify({
              tool_name: functionCall.name,
              tool_args: functionCall.args,
              tool_result: toolResult,
            }),
          });
        }

        currentApiHistory = [...currentApiHistory, {
          role: 'user',
          content: '',
          toolResults,
        }];
      }
    } catch (error) {
      console.error('Error calling API:', error);

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to get response from AI'}`,
        timestamp: new Date(),
      };

      const errorMessages = [...currentMessages, errorMessage];
      setMessages(errorMessages);
      saveCurrentChat(activeChatId, errorMessages, currentDigests);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-full w-full bg-gray-900">
      <Navigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={switchChat}
        onNewChat={createNewChat}
        onDeleteChat={deleteChat}
      />

      <main className="flex-1 flex flex-col overflow-hidden h-full">
        {activeTab === 'chat' && (
          <ChatUI
            messages={messages}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
          />
        )}
        {activeTab === 'graph' && <GraphExplorer settings={settings} />}
        {activeTab === 'settings' && (
          <Settings
            settings={settings}
            onSettingsChange={handleSettingsChange}
            currentContextTokens={currentContextTokens}
          />
        )}
      </main>
    </div>
  );
}

export default App;
