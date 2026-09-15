# CanvasBuddy

CanvasBuddy is your personal AI agent for the University of Toronto's quercus. CanvasBuddy can help you with all tasks related to quercus, from summarizing documents, to planning your week.

## What it can do

- List your active courses and course details
- Show upcoming assignments, planner items, and assignment details
- Browse course modules and module items
- Check announcements and recent course activity
- Review conversations/messages in Canvas
- Extract text from PDF and PowerPoint files uploaded to Canvas
- Keep multiple chat threads locally in the browser

## Technical Overview

**Architecture:**
- Browser extension (Manifest v3) for Chrome/Edge, integrated with Canvas (Quercus)
- React 19 frontend with TypeScript, styled with Tailwind CSS
- Supports Google AI (Gemini) and OpenAI APIs
- All data persisted locally via localStorage (no backend)
- Tools for Canvas API access, PDF/PPTX text extraction

**Context Optimization:**
- Context-size-based compression: older conversation segments are automatically summarized when context exceeds the configured token threshold
- Tool-loop digests: model summarizes what it learned after each tool-call sequence

## Build:

```bash
cd extension
npm run build
```

Then install as a google extension