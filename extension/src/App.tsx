import { useState, useEffect } from 'react';
import { Navigation } from './components/Navigation/Navigation';
import { ChatUI } from './components/ChatUI/ChatUI';
import type { Message } from './components/ChatUI/ChatUI';
import { Settings, type AppSettings } from './components/Settings/Settings';
import { extractTextFromFile } from './utils/textExtractor';
import './App.css';

// Types for chat persistence and compact model memory
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

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

// System prompt for the assistant
const SYSTEM_PROMPT = `You are a helpful student assistant integrated into Canvas. Your role is to help students manage their courses, assignments, and academic tasks. 

When helping students, always:
1. Retrieve course information before accessing course-specific data
2. Filter results strategically to provide focused, relevant information
3. Be concise and organized in presenting information
4. Guide students through their academic workflow efficiently

Use the available tools to access Canvas data, retrieve assignment details, check announcements, and help with course planning.`;

const SYSTEM_PROMPT_MESSAGE: ConversationMessage = {
  role: 'system',
  content: SYSTEM_PROMPT,
};

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
    name: 'get_courses',
    description: 'Retrieve list of courses the student is enrolled in',
    parameters: {
      type: 'OBJECT',
      properties: {
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
        enrollment_state: { type: 'STRING', description: 'Filter by enrollment state', enum: ['active', 'invited', 'completed'] },
        enrollment_type: { type: 'STRING', description: 'Filter by enrollment type', enum: ['student', 'teacher', 'ta', 'observer'] },
        include_total_scores: { type: 'BOOLEAN', description: 'Include grade information' },
        include_term: { type: 'BOOLEAN', description: 'Include term/semester information' },
        include_course_image: { type: 'BOOLEAN', description: 'Include course banner image' },
        include_teachers: { type: 'BOOLEAN', description: 'Include instructor information' },
      },
    },
  },
  {
    name: 'get_planner_items',
    description: 'Retrieve upcoming assignments and activities from planner',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'Start date in ISO 8601 format (e.g., 2026-03-15)' },
        end_date: { type: 'STRING', description: 'End date in ISO 8601 format' },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
        filter: { type: 'STRING', description: 'Filter type', enum: ['new_activity'] },
      },
    },
  },
  {
    name: 'get_course_assignments',
    description: 'Retrieve assignments for a specific course',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        bucket: { type: 'STRING', description: 'Filter assignments by time bucket', enum: ['upcoming', 'past', 'undated', 'ungraded'] },
        include_submission: { type: 'BOOLEAN', description: 'Include student submission status' },
        include_rubric: { type: 'BOOLEAN', description: 'Include rubric assessment' },
        order_by: { type: 'STRING', description: 'Sort results by field', enum: ['due_at', 'name', 'position'] },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_course_announcements',
    description: 'Retrieve announcements for a specific course',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        order_by: { type: 'STRING', description: 'Sort results by field', enum: ['recent_activity', 'position', 'title'] },
        scope: { type: 'STRING', description: 'Filter announcements by scope', enum: ['locked', 'unlocked', 'pinned', 'unpinned'] },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_conversations',
    description: 'Retrieve conversations/messages',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: { type: 'STRING', description: 'Filter conversations by scope', enum: ['unread', 'starred', 'archived'] },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
    },
  },
  {
    name: 'get_assignment_details',
    description: 'Retrieve detailed information about a specific assignment',
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
    name: 'get_course_modules',
    description: 'Retrieve course modules and their contents',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        include_items: { type: 'BOOLEAN', description: 'Include module items in same call' },
        include_content_details: { type: 'BOOLEAN', description: 'Include file size and dates' },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_module_items',
    description: 'Retrieve items within a specific course module',
    parameters: {
      type: 'OBJECT',
      properties: {
        course_id: { type: 'STRING', description: 'ID of the course' },
        module_id: { type: 'STRING', description: 'ID of the module' },
        per_page: { type: 'INTEGER', description: 'Number of results per page (max 100)' },
        page: { type: 'INTEGER', description: 'Page number for pagination' },
      },
      required: ['course_id', 'module_id'],
    },
  },
  {
    name: 'get_file_metadata',
    description: 'Retrieve metadata about a file',
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
    description: 'Extract text content from a file',
    parameters: {
      type: 'OBJECT',
      properties: {
        file_id: { type: 'STRING', description: 'ID of the file to extract text from' },
      },
      required: ['file_id'],
    },
  },
];

// Utility function to build query parameters from tool arguments
function buildQueryString(args: Record<string, string>): string {
  const params = new URLSearchParams();
  
  for (const [key, value] of Object.entries(args)) {
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
const toolFunctions: Record<string, (args: Record<string, string>) => Promise<string>> = {
  get_courses: async (args) => {
    try {
      // Provide default values
      const params = { per_page: '100', ...args };
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_planner_items: async (args) => {
    try {
      const params = { per_page: '100', ...args };
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
      const params = { per_page: '100', ...args };
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
      const params = { only_announcements: 'true', per_page: '100', ...args };
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
      const params = { per_page: '100', ...args };
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
      const params = { per_page: '100', ...args };
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
  get_course_modules: async (args: any) => {
    try {
      if (!args.course_id) {
        return JSON.stringify({ error: 'course_id is required' });
      }
      const params = { per_page: '100', ...args };
      const courseId = (params as any).course_id;
      delete (params as any).course_id;
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${courseId}/modules${queryString}`, {
        credentials: 'include',
      });
      const data = await response.json();
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
  get_module_items: async (args: any) => {
    try {
      if (!args.course_id || !args.module_id) {
        return JSON.stringify({ error: 'course_id and module_id are required' });
      }
      const params = { per_page: '100', ...args };
      const courseId = (params as any).course_id;
      const moduleId = (params as any).module_id;
      delete (params as any).course_id;
      delete (params as any).module_id;
      const queryString = buildQueryString(params);
      const response = await fetch(`https://q.utoronto.ca/api/v1/courses/${courseId}/modules/${moduleId}/items${queryString}`, {
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
};

// Parse function calls from Google AI response
interface FunctionCall {
  name: string;
  args: Record<string, any>;
}

function parseFunctionCalls(responseData: any): FunctionCall[] {
  const functionCalls: FunctionCall[] = [];
  
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
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
    }
  }

  return functionCalls;
}

// Extract text content from Google AI response
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
  return messages.reduce((total, message) => total + estimateTokenCount(message.content) + 4, 0);
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
  transientMessages: ConversationMessage[] = []
): ConversationMessage[] {
  const orderedDigests = [...digests].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const coveredUpToIndex = getConversationCoverageIndex(orderedDigests);

  return [
    SYSTEM_PROMPT_MESSAGE,
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
    ? 'Summarize what was learned from this tool-call loop. Return only a compact persistent memory digest. Focus on durable facts, discovered course structure, relevant locations, and next steps. Do not repeat raw tool payloads.'
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
  const [activeTab, setActiveTab] = useState<'chat' | 'settings'>('chat');
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
          messages: messages,
          max_tokens: 2000,
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
      const requestBody: any = {
        contents: messages.map((msg) => ({
          role: msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        })),
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
      let currentApiHistory = buildApiHistory(currentMessages, currentDigests);
      let toolLoopTranscript: ConversationMessage[] = [];
      let usedToolsInLoop = false;

      // Keep calling the API until there are no more tool calls
      while (true) {
        const result = await callLLM(currentApiHistory, settings);

        if (result.text) {
          const assistantMessage: Message = {
            id: (Date.now() + Math.random()).toString(),
            role: 'assistant',
            content: result.text,
            timestamp: new Date(),
          };

          currentMessages = [...currentMessages, assistantMessage];
          setMessages(currentMessages);

          currentApiHistory = [...currentApiHistory, {
            role: 'assistant',
            content: result.text,
          }];

          if (usedToolsInLoop) {
            toolLoopTranscript.push({
              role: 'assistant',
              content: result.text,
            });
          }
        }

        // Parse function calls from response (Google AI specific)
        const functionCalls = parseFunctionCalls(result.rawResponse);

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

        // Execute tools and keep results transient during the loop only.
        const toolResultsParts = [];

        for (const functionCall of functionCalls) {
          const toolImpl = toolFunctions[functionCall.name];
          let toolResult = JSON.stringify({ error: 'Tool not found' });

          if (toolImpl) {
            try {
              const stringArgs = Object.entries(functionCall.args).reduce((acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              }, {} as Record<string, string>);

              toolResult = await toolImpl(stringArgs);
            } catch (error) {
              toolResult = JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          toolResultsParts.push({
            functionResponse: {
              name: functionCall.name,
              response: {
                result: toolResult,
              },
            },
          });

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
          content: JSON.stringify({
            tool_results: toolResultsParts.map((part) => part.functionResponse),
          }),
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
