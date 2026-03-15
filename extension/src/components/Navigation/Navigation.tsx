import React from 'react';
import { MessageCircle, BookOpen, Lightbulb, Settings } from 'lucide-react';

interface NavigationProps {
  activeTab: 'chat' | 'notes' | 'flashcards' | 'settings';
  onTabChange: (tab: 'chat' | 'notes' | 'flashcards' | 'settings') => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeTab, onTabChange }) => {
  const navItems = [
    { id: 'chat' as const, label: 'Chat', icon: MessageCircle },
    { id: 'notes' as const, label: 'Notes', icon: BookOpen },
    { id: 'flashcards' as const, label: 'Flashcards', icon: Lightbulb },
  ];

  return (
    <aside className="w-20 bg-gradient-to-b from-slate-800 to-slate-900 flex flex-col items-center py-6 gap-4 shadow-lg">
      <div className="w-12 h-12 rounded-lg bg-blue-500 flex items-center justify-center mb-4">
        <span className="text-white font-bold text-lg">Q</span>
      </div>
      
      <nav className="flex flex-col gap-4 flex-1">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`w-14 h-14 rounded-lg flex items-center justify-center transition-all duration-200 ${
              activeTab === id
                ? 'bg-blue-500 text-white shadow-lg scale-110'
                : 'bg-slate-700 text-white hover:bg-slate-600'
            }`}
            title={label}
          >
            <Icon size={24} />
          </button>
        ))}
      </nav>

      <button
        onClick={() => onTabChange('settings')}
        className={`w-14 h-14 rounded-lg flex items-center justify-center transition-all duration-200 ${
          activeTab === 'settings'
            ? 'bg-blue-500 text-white shadow-lg scale-110'
            : 'bg-slate-700 text-white hover:bg-slate-600'
        }`}
        title="Settings"
      >
        <Settings size={24} />
      </button>
    </aside>
  );
};
