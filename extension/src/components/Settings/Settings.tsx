import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export interface AppSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  embeddingModel?: string;
  llmProvider: 'openai' | 'google';
  contextThreshold: number;
}

interface SettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  currentContextTokens?: number;
}

export const Settings: React.FC<SettingsProps> = ({ settings, onSettingsChange, currentContextTokens = 0 }) => {
  const [showApiKey, setShowApiKey] = useState(false);
  const [form, setForm] = useState(settings);

  React.useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleChange = (field: keyof AppSettings, value: string | number) => {
    const updated = { ...form, [field]: value };
    setForm(updated);
    // Auto-save immediately on any change to persist settings
    onSettingsChange(updated);
  };


  const handleReset = () => {
    setForm(settings);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-50 p-6">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Settings</h1>

      <div className="max-w-2xl space-y-6">
        {/* LLM Provider */}
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            LLM Provider
          </label>
          <select
            value={form.llmProvider}
            onChange={(e) => handleChange('llmProvider', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          >
            <option value="openai">OpenAI</option>
            <option value="google">Google AI</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Choose which LLM provider to use for AI responses
          </p>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            API Key
          </label>
          <div className="flex gap-2">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={form.apiKey}
              onChange={(e) => handleChange('apiKey', e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              placeholder="Enter your API key"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
              title={showApiKey ? 'Hide API key' : 'Show API key'}
            >
              {showApiKey ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Your API key is stored locally and never shared
          </p>
        </div>

        {/* Base URL */}
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            API Base URL
          </label>
          <input
            type="text"
            value={form.baseUrl}
            onChange={(e) => handleChange('baseUrl', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            placeholder="https://example.com/api"
          />
          <p className="text-xs text-gray-500 mt-1">
            The base URL for your LLM API endpoint
          </p>
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            Model Name
          </label>
          <input
            type="text"
            value={form.model}
            onChange={(e) => handleChange('model', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            placeholder="gpt-4o-mini"
          />
          <p className="text-xs text-gray-500 mt-1">
            The model to use for AI responses
          </p>
        </div>

        {/* Embedding Model */}
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">
            Embedding Model Name
          </label>
          <input
            type="text"
            value={form.embeddingModel || ''}
            onChange={(e) => handleChange('embeddingModel', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            placeholder={form.llmProvider === 'google' ? 'gemini-embedding-2' : 'text-embedding-3-small'}
          />
          <p className="text-xs text-gray-500 mt-1">
            The model used for vector embeddings in local RAG (Default: gemini-embedding-2 for Google, text-embedding-3-small for OpenAI, targeting 768 dimensions)
          </p>
        </div>

        {/* Context Optimization */}
        <div className="pt-2 border-t border-gray-200 space-y-3">
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">
              Max Context Before Summarization
            </label>
            <div className="space-y-2">
              <input
                type="range"
                min={5000}
                max={100000}
                step={500}
                value={form.contextThreshold}
                onChange={(e) => handleChange('contextThreshold', Number(e.target.value))}
                className="w-full cursor-pointer"
              />
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  value={form.contextThreshold}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    if (!Number.isNaN(parsed)) {
                      handleChange('contextThreshold', parsed);
                    }
                  }}
                  className="w-40 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                />
                <span className="text-xs text-gray-500">tokens</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Slider range is 5,000 to 100,000 tokens. The number field accepts any value.
            </p>
          </div>

          <div className="bg-gray-100 rounded-lg p-3 text-sm text-gray-700">
            <div className="flex items-center justify-between">
              <span className="font-medium">Current context estimate</span>
              <span>
                {currentContextTokens.toLocaleString()} / {form.contextThreshold.toLocaleString()} tokens
              </span>
            </div>
            <div className="mt-2 h-2 w-full bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, (currentContextTokens / Math.max(form.contextThreshold, 1)) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={handleReset}
            className="px-6 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
