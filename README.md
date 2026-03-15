# CanvasBuddy - Canvas AI Assistant

A powerful AI-powered student assistant integrated into Canvas LMS. CanvasBuddy leverages advanced language models to help students manage courses, track assignments, understand content, and more—all through a conversational interface.

## Features

✨ **AI-Powered Chat Interface**
- Natural language conversations with an intelligent student assistant
- Real-time responses with streaming support
- Conversation persistence across sessions

📚 **Canvas Integration**
- Access all active courses with grade information
- View upcoming assignments, quizzes, and announcements
- Retrieve course modules and file contents
- Extract text from PDF and PowerPoint files
- Smart filtering with Canvas API query parameters

🛠️ **Tool-Based Architecture**
- AI can autonomously call Canvas API endpoints to gather information
- Support for 10+ Canvas tools including:
  - Course listing and filtering
  - Assignment retrieval with submission status
  - Announcement management
  - Module and content browsing
  - File metadata and text extraction
  - Planner items and conversations

⚙️ **Customizable Settings**
- API key management
- Base URL configuration
- Model selection (supports OpenAI-compatible APIs)

💾 **Data Persistence**
- Local storage of conversation history
- Chat archival and management
- Configurable settings saved per session

## Architecture

```
CanvasBuddy/
├── extension/                 # React TypeScript frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatUI/        # Chat message display
│   │   │   ├── Navigation/    # Sidebar navigation
│   │   │   └── Settings/      # Configuration panel
│   │   ├── App.tsx            # Main app with state management
│   │   └── App.css            # Global styles
│   └── vite.config.ts         # Vite build config
├── server.js                  # Node.js backend for file extraction
├── package.json               # Dependencies
└── README.md
```

### Technology Stack

**Frontend:**
- React 18 with TypeScript
- Vite (build tool)
- Tailwind CSS (styling)
- Lucide Icons
- Marked (markdown rendering)

**Backend:**
- Node.js + Express
- PDF parsing (`pdf-parse`)
- PowerPoint parsing (`pptx2json`)
- Axios for HTTP requests
- CORS support

**External APIs:**
- Canvas LMS API v1
- OpenAI-compatible language models

## Installation

### Prerequisites
- Node.js 16+ 
- npm or yarn
- Canvas institution account with API access
- LLM API key (supports OpenAI-compatible endpoints)

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd CanvasBuddy
   ```

2. **Install root dependencies**
   ```bash
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd extension
   npm install
   cd ..
   ```

4. **Start the backend server**
   ```bash
   npm start
   # Server runs on http://localhost:3000
   ```

5. **Build the frontend** (in a new terminal)
   ```bash
   cd extension
   npm run build
   ```

6. **Development mode** (optional, for live reload)
   ```bash
   cd extension
   npm run dev
   # Frontend dev server on http://localhost:5173
   ```

## Configuration

### Canvas API
The frontend uses Canvas instance at `https://q.utoronto.ca` (University of Toronto). Customize the base URL in `extension/src/App.tsx`:

```typescript
const BASE_URL = 'https://your-canvas-instance.instructure.com';
```

### Language Model Settings
Configure in the Settings panel after launching:
- **API Key**: Your LLM provider's API key
- **Base URL**: API endpoint (e.g., Hugging Face endpoints)
- **Model**: Model identifier (e.g., `openai/gpt-oss-120b`)

## Usage

### Chat Interface
1. Open the extension in your browser
2. Type a message to ask the assistant about your courses
3. The AI can automatically fetch data using Canvas tools
4. View conversation history in the left sidebar
5. Create new chats or delete old ones

### Example Interactions

**Get upcoming assignments:**
> "What assignments do I have coming up this week?"

**Find course information:**
> "List all my active courses with grade information"

**Extract lecture notes:**
> "Extract text from the lecture slides in my biology course"

**Manage messages:**
> "Show me my unread messages"

## Available Tools

The AI has access to these Canvas API tools:

| Tool | Purpose | Required Parameters |
|------|---------|-------------------|
| `get_courses` | List user's courses | — |
| `get_planner_items` | Get upcoming items | — |
| `get_course_assignments` | List assignments | `course_id` |
| `get_course_announcements` | View announcements | `course_id` |
| `get_conversations` | Access inbox | — |
| `get_assignment_details` | Get assignment info | `course_id`, `assignment_id` |
| `get_course_modules` | List course modules | `course_id` |
| `get_module_items` | Get module contents | `course_id`, `module_id` |
| `get_file_metadata` | File information | `file_id` |
| `extract_text_from_file` | Extract PDF/PPTX text | `file_id` |

### Tool Parameters

Tools support Canvas API query parameters for filtering and optimization:

```
Examples:
- get_courses with enrollment_state=active, include[]=total_scores
- get_course_assignments with bucket=upcoming, order_by=due_at
- get_planner_items with start_date=2026-03-15, filter=new_activity
```

See `extension/src/App.tsx` system prompt for full parameter documentation.

## Development

### Frontend Development
```bash
cd extension
npm run dev
```

### Build for Production
```bash
# Frontend
cd extension
npm run build

# Backend stays as-is (Node.js)
```

### Debugging
- Check browser console for frontend errors
- Check terminal output for backend logs
- Use React DevTools for component inspection
- Inspect Canvas API responses in network tab

## API Integration Details

### File Extraction (`/extract`)
- Accepts PDF and PPTX files via URL
- Extracts plain text content
- Returns JSON with extracted text

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/file.pdf"}'
```

### Canvas Authentication
- Uses browser's credentials with `credentials: 'include'`
- Requires active Canvas session
- All requests routed through Canvas API

## Configuration Files

- `extension/vite.config.ts` - Frontend build configuration
- `extension/tailwind.config.js` - Tailwind CSS setup
- `extension/tsconfig.json` - TypeScript configuration
- `package.json` - Backend dependencies and scripts

## Troubleshooting

**"API Error" when fetching data:**
- Verify Canvas API access is enabled
- Check API key in settings
- Ensure course IDs are correct

**File extraction not working:**
- Verify backend server is running (`npm start`)
- Check file format is PDF or PPTX
- Ensure file URL is accessible

**Settings not persisting:**
- Clear localStorage if corrupted
- Check browser storage settings
- Verify localStorage isn't disabled

## Future Enhancements

- [ ] Grade analysis and predictions
- [ ] Assignment deadline reminders
- [ ] Collaborative study groups
- [ ] Document summarization
- [ ] Quiz preparation tools
- [ ] Mobile app version

## License

MIT License - feel free to use and modify

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review Canvas API documentation
3. Verify your LLM API configuration
4. Check browser console and server logs

---

Built with ❤️ for students.