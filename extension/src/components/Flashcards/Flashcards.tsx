import React, { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  createdAt: Date;
  lastReviewedAt?: Date;
  reviewCount: number;
}

interface FlashcardsProps {
  flashcards: Flashcard[];
  onAddFlashcard: (front: string, back: string) => void;
  onDeleteFlashcard: (id: string) => void;
  onReviewFlashcard: (id: string) => void;
}

export const Flashcards: React.FC<FlashcardsProps> = ({
  flashcards,
  onAddFlashcard,
  onDeleteFlashcard,
  onReviewFlashcard,
}) => {
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newFront, setNewFront] = useState('');
  const [newBack, setNewBack] = useState('');

  const currentCard = flashcards[currentCardIndex];

  const handleAddFlashcard = () => {
    if (newFront.trim() && newBack.trim()) {
      onAddFlashcard(newFront, newBack);
      setNewFront('');
      setNewBack('');
      setIsCreating(false);
    }
  };

  const handleNextCard = () => {
    if (currentCard) {
      onReviewFlashcard(currentCard.id);
    }
    setIsFlipped(false);
    setCurrentCardIndex((prev) => (prev + 1) % flashcards.length);
  };

  const handlePrevCard = () => {
    setIsFlipped(false);
    setCurrentCardIndex((prev) =>
      prev === 0 ? flashcards.length - 1 : prev - 1
    );
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Flashcards</h1>
        <button
          onClick={() => {
            setIsCreating(true);
            setNewFront('');
            setNewBack('');
          }}
          className="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
        >
          <Plus size={18} />
          New Card
        </button>
      </div>

      {/* Create New Card */}
      {isCreating && (
        <div className="bg-white rounded-lg p-6 mb-6 border border-primary-200 shadow-sm">
          <h2 className="text-lg font-semibold mb-4 text-gray-900">
            Create New Flashcard
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Front (Question)
              </label>
              <input
                type="text"
                value={newFront}
                onChange={(e) => setNewFront(e.target.value)}
                placeholder="Enter question..."
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-200"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Back (Answer)
              </label>
              <textarea
                value={newBack}
                onChange={(e) => setNewBack(e.target.value)}
                placeholder="Enter answer..."
                rows={3}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-200 resize-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end mt-4">
            <button
              onClick={() => {
                setIsCreating(false);
                setNewFront('');
                setNewBack('');
              }}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddFlashcard}
              className="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      {flashcards.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🎴</span>
            </div>
            <p className="text-gray-500">No flashcards yet. Create your first one!</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center flex-1">
          {/* Card Counter */}
          <div className="mb-6 text-gray-600">
            Card {currentCardIndex + 1} of {flashcards.length}
          </div>

          {/* Flashcard */}
          <div
            onClick={() => setIsFlipped(!isFlipped)}
            className="w-96 h-64 cursor-pointer perspective"
            style={{
              perspective: '1000px',
            }}
          >
            <div
              className={`relative w-full h-full transition-transform duration-500 ${
                isFlipped ? 'scale-x-[-1]' : ''
              }`}
              style={{
                transformStyle: 'preserve-3d',
                transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
              }}
            >
              {/* Front */}
              <div
                className="absolute w-full h-full bg-white rounded-xl shadow-lg p-8 flex items-center justify-center border-2 border-primary-200"
                style={{
                  backfaceVisibility: 'hidden',
                }}
              >
                <p className="text-center text-xl text-gray-900 font-semibold">
                  {currentCard?.front}
                </p>
              </div>

              {/* Back */}
              <div
                className="absolute w-full h-full bg-primary-50 rounded-xl shadow-lg p-8 flex items-center justify-center border-2 border-primary-300"
                style={{
                  backfaceVisibility: 'hidden',
                  transform: 'rotateY(180deg)',
                }}
              >
                <p className="text-center text-lg text-gray-900">
                  {currentCard?.back}
                </p>
              </div>
            </div>
          </div>

          <p className="text-center text-gray-500 mt-4 mb-6">Click card to flip</p>

          {/* Statistics */}
          <div className="mb-8 text-sm text-gray-600">
            Reviewed {currentCard?.reviewCount || 0} times
            {currentCard?.lastReviewedAt && (
              <span>
                {' '}
                • Last: {currentCard.lastReviewedAt.toLocaleDateString()}
              </span>
            )}
          </div>

          {/* Navigation */}
          <div className="flex gap-4">
            <button
              onClick={handlePrevCard}
              className="px-6 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition-colors"
            >
              ← Previous
            </button>
            <button
              onClick={() => {
                if (currentCard) onDeleteFlashcard(currentCard.id);
                setIsFlipped(false);
                if (flashcards.length > 1) {
                  setCurrentCardIndex((prev) =>
                    prev === flashcards.length - 1 ? 0 : prev
                  );
                }
              }}
              className="px-6 py-2 bg-red-200 hover:bg-red-300 text-red-800 rounded-lg transition-colors flex items-center gap-2"
            >
              <Trash2 size={18} />
              Delete
            </button>
            <button
              onClick={handleNextCard}
              className="px-6 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
