import React, { useState, useRef, useEffect } from 'react';
import { Send, Square, Wrench } from 'lucide-react';
import { renderMarkdown } from '../../utils/markdown';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  /** Tokens are still arriving for this bubble. Transient: never persisted. */
  streaming?: boolean;
  /** What the assistant did after this text (one line per tool call). Persisted. */
  activity?: string[];
}

interface ChatUIProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
}

const TypingDots: React.FC = () => (
  <div className="flex gap-1 py-1">
    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
  </div>
);

export const ChatUI: React.FC<ChatUIProps> = ({ messages, onSendMessage, onStop, isLoading = false }) => {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onSendMessage(inputValue);
      setInputValue('');
    }
  };

  // While a bubble streams it is the progress indicator; the dots row covers the gaps between
  // model turns (tool execution, digesting) when no bubble is receiving tokens.
  const streamingBubble = messages.some((m) => m.streaming);

  return (
    <div className="flex flex-col h-full w-full bg-gray-50">
      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 w-full min-w-0">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4">
              <img src="/logo.png" alt="Logo" className="w-full h-full object-contain rounded-full" />
            </div>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">Chat with Canvas Buddy</h2>
            <p className="text-gray-500 max-w-xs">
              Ask questions about your courses, assignments, or anything related to your studies.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in w-full min-w-0`}
            >
              <div
                className={`max-w-[calc(100%-1rem)] sm:max-w-[90%] lg:max-w-2xl px-4 py-2 rounded-lg transition-all duration-300 overflow-hidden ${
                  message.role === 'user'
                    ? 'bg-blue-500 text-white rounded-br-none'
                    : 'bg-white text-gray-900 border border-gray-200 rounded-bl-none shadow-sm'
                }`}
              >
                {message.role === 'assistant' ? (
                  <>
                    {message.streaming && !message.content ? (
                      <TypingDots />
                    ) : (
                      message.content && (
                        <div
                          className={`prose prose-sm max-w-none dark:prose-invert break-words [&_*]:break-words [&_code]:break-all [&_pre]:overflow-x-auto ${
                            message.streaming ? 'streaming-caret' : ''
                          }`}
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(message.content),
                          }}
                        />
                      )
                    )}
                    {message.activity && message.activity.length > 0 && (
                      <ul className={`text-xs text-gray-500 space-y-0.5 ${message.content ? 'mt-2 pt-2 border-t border-gray-100' : ''}`}>
                        {message.activity.map((line, i) => (
                          <li key={i} className="flex items-center gap-1.5">
                            <Wrench size={12} className="flex-shrink-0 text-gray-400" />
                            <span className="truncate">{line}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <div className="text-sm whitespace-pre-wrap break-words overflow-hidden">
                    {message.content}
                  </div>
                )}
                {!message.streaming && (
                  <span className="text-xs opacity-70 mt-1 block flex-shrink-0">
                    {message.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </div>
            </div>
          ))
        )}

        {isLoading && !streamingBubble && (
          <div className="flex justify-start w-full min-w-0">
            <div className="bg-white text-gray-900 border border-gray-200 rounded-lg rounded-bl-none px-4 py-2 shadow-sm">
              <TypingDots />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-200 bg-white px-4 py-3 flex-shrink-0">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type your message..."
            disabled={isLoading}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100"
          />
          {isLoading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop"
              className="bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={isLoading || !inputValue.trim()}
              className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
            >
              <Send size={18} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
