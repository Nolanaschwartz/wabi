'use client';

import { useState } from 'react';

interface DashboardViewProps {
  user: { discordId: string; email: string | null };
  moods: Array<{ rating: number; emoji: string; createdAt: Date }>;
  playtimes: Array<{ duration: number; createdAt: Date }>;
  streak: number;
}

export default function DashboardView({ user, moods, playtimes, streak }: DashboardViewProps) {
  const [activeTab, setActiveTab] = useState<'mood' | 'playtime' | 'streak'>('mood');

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">
          Dashboard
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
            <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Streak
            </h2>
            <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">
              {streak} days
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
            <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Mood Entries
            </h2>
            <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">
              {moods.length}
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
            <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Playtime Hours
            </h2>
            <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">
              {Math.round(playtimes.reduce((acc, p) => acc + p.duration, 0) / 60)}h
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="flex -mb-px">
              <button
                onClick={() => setActiveTab('mood')}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === 'mood'
                    ? 'border-b-2 border-blue-500 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Mood History
              </button>
              <button
                onClick={() => setActiveTab('playtime')}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === 'playtime'
                    ? 'border-b-2 border-blue-500 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Playtime
              </button>
              <button
                onClick={() => setActiveTab('streak')}
                className={`px-4 py-2 text-sm font-medium ${
                  activeTab === 'streak'
                    ? 'border-b-2 border-blue-500 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Streak
              </button>
            </nav>
          </div>

          <div className="p-6">
            {activeTab === 'mood' && (
              <div className="space-y-3">
                {moods.map((mood, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded"
                  >
                    <span className="text-2xl">{mood.emoji}</span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {new Date(mood.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'playtime' && (
              <div className="space-y-3">
                {playtimes.map((pt, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded"
                  >
                    <span className="text-sm font-medium">
                      {pt.duration} minutes
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {new Date(pt.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'streak' && (
              <div className="text-center py-8">
                <p className="text-6xl font-bold text-gray-900 dark:text-white mb-2">
                  {streak}
                </p>
                <p className="text-gray-500 dark:text-gray-400">
                  day streak
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
