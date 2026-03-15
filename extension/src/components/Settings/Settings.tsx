import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export interface AppSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface SettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export const Settings: React.FC<SettingsProps> = ({ settings, onSettingsChange }) => {
  const [showApiKey, setShowApiKey] = useState(false);
  const [form, setForm] = useState(settings);

  const handleChange = (field: keyof AppSettings, value: string) => {
    setForm({ ...form, [field]: value });
  };

  const handleSave = () => {
    onSettingsChange(form);
  };

  const handleReset = () => {
    setForm(settings);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-50 p-6">
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Settings</h1>

      <div className="max-w-2xl space-y-6">
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

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium transition-colors"
          >
            Save Settings
          </button>
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
