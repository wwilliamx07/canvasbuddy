import React, { useState } from 'react';
import { Plus } from 'lucide-react';

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

interface NotesProps {
  notes: Note[];
  onAddNote: (title: string, content: string) => void;
  onDeleteNote?: (id: string) => void;
  onUpdateNote: (id: string, title: string, content: string) => void;
}

export const Notes: React.FC<NotesProps> = ({
  notes,
  onAddNote,
  onUpdateNote,
}) => {
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');

  const selectedNote = notes.find((n) => n.id === selectedNoteId);

  const handleAddNote = () => {
    if (newTitle.trim() && newContent.trim()) {
      onAddNote(newTitle, newContent);
      setNewTitle('');
      setNewContent('');
      setIsCreating(false);
    }
  };

  const handleUpdateNote = () => {
    if (selectedNote && newTitle.trim() && newContent.trim()) {
      onUpdateNote(selectedNote.id, newTitle, newContent);
      setSelectedNoteId(null);
    }
  };

  return (
    <div className="flex h-full bg-gray-50">
      {/* Notes List */}
      <div className="w-64 border-r border-gray-200 bg-white overflow-y-auto">
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={() => {
              setIsCreating(true);
              setNewTitle('');
              setNewContent('');
              setSelectedNoteId(null);
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
          >
            <Plus size={18} />
            New Note
          </button>
        </div>
        <div className="space-y-2 p-4">
          {notes.map((note) => (
            <div
              key={note.id}
              onClick={() => {
                setSelectedNoteId(note.id);
                setIsCreating(false);
              }}
              className={`p-3 rounded-lg cursor-pointer transition-colors ${
                selectedNoteId === note.id
                  ? 'bg-primary-100 border border-primary-300'
                  : 'hover:bg-gray-100'
              }`}
            >
              <p className="font-semibold text-sm text-gray-900 truncate">
                {note.title}
              </p>
              <p className="text-xs text-gray-500 truncate mt-1">
                {note.content.substring(0, 50)}...
              </p>
              <p className="text-xs text-gray-400 mt-2">
                {note.updatedAt.toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Note Editor */}
      <div className="flex-1 flex flex-col">
        {isCreating || selectedNote ? (
          <>
            <div className="border-b border-gray-200 bg-white p-4">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={isCreating ? 'Note title...' : selectedNote?.title}
                className="w-full text-2xl font-bold text-gray-900 border-none focus:outline-none placeholder-gray-400"
              />
            </div>

            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder={isCreating ? 'Start typing...' : selectedNote?.content}
              className="flex-1 p-4 border-none focus:outline-none resize-none text-gray-700 placeholder-gray-400"
            />

            <div className="border-t border-gray-200 bg-white p-4 flex gap-2 justify-end">
              <button
                onClick={() => {
                  setIsCreating(false);
                  setSelectedNoteId(null);
                  setNewTitle('');
                  setNewContent('');
                }}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={isCreating ? handleAddNote : handleUpdateNote}
                className="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
              >
                {isCreating ? 'Create' : 'Update'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">📝</span>
              </div>
              <p className="text-gray-500">Select a note or create a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
