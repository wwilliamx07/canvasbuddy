import { useState } from 'react';
import { Navigation } from './components/Navigation/Navigation';
import { ChatUI } from './components/ChatUI/ChatUI';
import type { Message } from './components/ChatUI/ChatUI';
import { Notes } from './components/Notes/Notes';
import type { Note } from './components/Notes/Notes';
import { Flashcards } from './components/Flashcards/Flashcards';
import type { Flashcard } from './components/Flashcards/Flashcards';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'notes' | 'flashcards'>('chat');
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);

  // Chat handlers
  const handleSendMessage = (content: string) => {
    const newMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    };
    setMessages([...messages, newMessage]);

    // Simulate AI response
    setTimeout(() => {
      const aiResponse: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content:
          'This is a sample AI response. Connect this to your actual AI backend API.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiResponse]);
    }, 500);
  };

  // Notes handlers
  const handleAddNote = (title: string, content: string) => {
    const newNote: Note = {
      id: Date.now().toString(),
      title,
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setNotes([...notes, newNote]);
  };

  const handleDeleteNote = (id: string) => {
    setNotes(notes.filter((note) => note.id !== id));
  };

  const handleUpdateNote = (id: string, title: string, content: string) => {
    setNotes(
      notes.map((note) =>
        note.id === id
          ? {
              ...note,
              title,
              content,
              updatedAt: new Date(),
            }
          : note
      )
    );
  };

  // Flashcard handlers
  const handleAddFlashcard = (front: string, back: string) => {
    const newFlashcard: Flashcard = {
      id: Date.now().toString(),
      front,
      back,
      createdAt: new Date(),
      reviewCount: 0,
    };
    setFlashcards([...flashcards, newFlashcard]);
  };

  const handleDeleteFlashcard = (id: string) => {
    setFlashcards(flashcards.filter((card) => card.id !== id));
  };

  const handleReviewFlashcard = (id: string) => {
    setFlashcards(
      flashcards.map((card) =>
        card.id === id
          ? {
              ...card,
              reviewCount: card.reviewCount + 1,
              lastReviewedAt: new Date(),
            }
          : card
      )
    );
  };

  return (
    <div className="flex h-screen bg-gray-900">
      <Navigation activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="flex-1 flex flex-col overflow-hidden">
        {activeTab === 'chat' && (
          <ChatUI
            messages={messages}
            onSendMessage={handleSendMessage}
            isLoading={false}
          />
        )}
        {activeTab === 'notes' && (
          <Notes
            notes={notes}
            onAddNote={handleAddNote}
            onDeleteNote={handleDeleteNote}
            onUpdateNote={handleUpdateNote}
          />
        )}
        {activeTab === 'flashcards' && (
          <Flashcards
            flashcards={flashcards}
            onAddFlashcard={handleAddFlashcard}
            onDeleteFlashcard={handleDeleteFlashcard}
            onReviewFlashcard={handleReviewFlashcard}
          />
        )}
      </main>
    </div>
  );
}

export default App;
