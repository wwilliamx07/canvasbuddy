import React from 'react';
import { MessageCircle, Settings, Trash2, Plus } from 'lucide-react';

interface Chat {
  id: string;
  title: string;
  updatedAt: Date;
}

interface NavigationProps {
  activeTab: 'chat' | 'settings';
  onTabChange: (tab: 'chat' | 'settings') => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onTabChange,
  chats,
  currentChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
}) => {
  return (
    <aside className="w-48 bg-gradient-to-b from-slate-800 to-slate-900 flex flex-col shadow-lg h-full">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="w-10 h-10 rounded-lg bg-blue-500 flex items-center justify-center mb-4 overflow-hidden">
          <img src="/logo.png" alt="Logo" className="w-full h-full object-contain" />
        </div>
        <h1 className="text-white font-semibold text-lg">Quercus AI</h1>
      </div>

      {/* Navigation Tabs */}
      <nav className="flex flex-col gap-2 p-4 border-b border-slate-700">
        <button
          onClick={() => onTabChange('chat')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
            activeTab === 'chat'
              ? 'bg-blue-500 text-white'
              : 'text-slate-300 hover:bg-slate-700'
          }`}
        >
          <MessageCircle size={20} />
          <span className="font-medium">Chat</span>
        </button>

        <button
          onClick={() => onTabChange('settings')}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
            activeTab === 'settings'
              ? 'bg-blue-500 text-white'
              : 'text-slate-300 hover:bg-slate-700'
          }`}
        >
          <Settings size={20} />
          <span className="font-medium">Settings</span>
        </button>
      </nav>

      {/* Chat List (only show when on chat tab) */}
      {activeTab === 'chat' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-700">
            <h3 className="text-white font-semibold text-sm">Chats</h3>
          </div>

          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 ? (
              <div className="p-4 text-slate-400 text-sm text-center">
                No chats yet. Create one to get started!
              </div>
            ) : (
              chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`p-3 border-b border-slate-700 cursor-pointer group hover:bg-slate-700 transition-colors ${
                    currentChatId === chat.id ? 'bg-slate-700' : ''
                  }`}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm truncate font-medium">
                        {chat.title}
                      </p>
                      <p className="text-slate-400 text-xs mt-1">
                        {new Date(chat.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteChat(chat.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 transition-all p-1"
                      title="Delete chat"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-4 border-t border-slate-700">
            <button
              onClick={onNewChat}
              className="w-full bg-blue-500 hover:bg-blue-600 text-white py-2 px-3 rounded-lg flex items-center justify-center gap-2 transition-colors font-medium"
            >
              <Plus size={18} />
              New Chat
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};
