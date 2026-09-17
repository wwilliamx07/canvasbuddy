/**
 * Canvas LMS API entity types and local Graph representations
 */

export interface CanvasCourse {
  id: number | string;
  course_id?: number | string;
  name: string;
  course_code?: string;
  workflow_state?: string;
  term?: {
    name?: string;
    start_at?: string;
    end_at?: string;
  };
  synced_at?: string;
}

export interface CanvasModule {
  id: number | string;
  course_id?: number | string;
  name: string;
  position?: number;
  unlock_at?: string | null;
  require_sequential_progress?: boolean;
  prerequisite_module_ids?: (number | string)[];
  items_count?: number;
  items_url?: string;
  items?: CanvasModuleItem[];
  synced_at?: string;
}

export interface CanvasModuleItem {
  id: number | string;
  module_id: number | string;
  position?: number;
  title: string;
  type: 'File' | 'Assignment' | 'Page' | 'Discussion' | 'Quiz' | 'SubHeader' | 'ExternalUrl' | 'ExternalTool' | string;
  content_id?: number | string;
  page_url?: string;        // wiki pages are addressed by slug, not content_id
  html_url?: string;
  url?: string;
  content_ref?: string;
  synced_at?: string;
}

export interface CanvasAssignment {
  id: number | string;
  course_id: number | string;
  name: string;
  description?: string;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  updated_at?: string;
  synced_at?: string;
}

export interface CanvasPage {
  url: string;              // slug used in API paths
  page_id?: number | string;
  title: string;
  body?: string;            // only present when fetching a single page
  updated_at?: string;
  html_url?: string;
  published?: boolean;
}

export interface CanvasFile {
  id: number | string;
  course_id?: number | string;
  folder_id?: number | string;
  display_name?: string;
  filename: string;
  content_type?: string;
  url?: string;
  size?: number;
  created_at?: string;
  updated_at?: string;
  modified_at?: string;
  total_chunks?: number;
  extracted_at?: string;
}

export interface GraphEdge {
  edge_id?: number;
  from_type: 'course' | 'module' | 'module_item' | 'assignment' | 'file';
  from_id: string;
  to_type: 'course' | 'module' | 'module_item' | 'assignment' | 'file';
  to_id: string;
  relation: 'contains' | 'prerequisite' | 'references';
}

export interface GraphStats {
  courseCount: number;
  moduleCount: number;
  itemCount: number;
  assignmentCount: number;
  fileCount: number;
  chunkCount: number;
}

export interface RetrievedChunk {
  chunk_id: string;
  chunk_index: number;
  page_number?: number;
  content: string;
  similarity: number;
  filename: string;
  display_name?: string;
  file_id: string;
  course_id?: string;
  course_name?: string;
  module_name?: string;
  source_type?: 'file' | 'page' | 'assignment' | string;
  html_url?: string;
}

