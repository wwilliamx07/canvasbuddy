import React from 'react';
import { MessageCircle, BookOpen, Lightbulb } from 'lucide-react';

interface NavigationProps {
  activeTab: 'chat' | 'notes' | 'flashcards';
  onTabChange: (tab: 'chat' | 'notes' | 'flashcards') => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeTab, onTabChange }) => {
  const navItems = [
    { id: 'chat' as const, label: 'Chat', icon: MessageCircle },
    { id: 'notes' as const, label: 'Notes', icon: BookOpen },
    { id: 'flashcards' as const, label: 'Flashcards', icon: Lightbulb },
  ];

  return (
    <aside className="w-20 bg-gradient-to-b from-primary-900 to-primary-800 flex flex-col items-center py-6 gap-4 shadow-lg">
      <div className="w-12 h-12 rounded-lg bg-primary-500 flex items-center justify-center mb-4">
        <span className="text-white font-bold text-lg">Q</span>
      </div>
      
      <nav className="flex flex-col gap-4 flex-1">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`w-14 h-14 rounded-lg flex items-center justify-center transition-all duration-200 ${
              activeTab === id
                ? 'bg-primary-500 text-white shadow-lg scale-110'
                : 'text-primary-300 hover:text-white hover:bg-primary-700'
            }`}
            title={label}
          >
            <Icon size={24} />
          </button>
        ))}
      </nav>

      <div className="w-12 h-12 rounded-lg bg-primary-700 hover:bg-primary-600 flex items-center justify-center cursor-pointer transition-colors">
        <span className="text-white text-lg">⚙️</span>
      </div>
    </aside>
  );
};
