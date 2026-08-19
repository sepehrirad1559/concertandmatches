import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, ResponsiveContainer } from 'recharts';
import { Settings, RefreshCw, AlertTriangle, CheckCircle, Database } from 'lucide-react';
interface Source {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  country: string;
  total_events_discovered: number;
  total_listings_discovered: number;
  last_successful_crawl?: string;
  last_failed_crawl?: string;
  last_error?: string;
}

interface CrawlerStatus {
  source_id: number;
  source_name: string;
  enabled: boolean;
  last_crawl?: string;
  last_status: string;
  total_events_discovered: number;
  total_listings_discovered: number;
  success_rate: string;
}

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<'overview' | 'sources' | 'crawler' | 'matching'>('overview');
  const [sources, setSources] = useState<Source[]>([]);
  const [crawlerStatus, setCrawlerStatus] = useState<CrawlerStatus[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [sourcesRes, statusRes] = await Promise.all([
        adminAPI.sources.list(),
        adminAPI.crawler.getStatus()
      ]);
      setSources(sourcesRes.data.data || []);
      setCrawlerStatus(statusRes.data.data || []);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-indigo-600">EventFlow Admin</h1>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-6 flex gap-8">
          <NavTab active={activeTab === 'overview'} onClick={() => setActiveTab('overview')}>
            Overview
          </NavTab>
          <NavTab active={activeTab === 'sources'} onClick={() => setActiveTab('sources')}>
            Data Sources
          </NavTab>
          <NavTab active={activeTab === 'crawler'} onClick={() => setActiveTab('crawler')}>
            Crawler Status
          </NavTab>
          <NavTab active={activeTab === 'matching'} onClick={() => setActiveTab('matching')}>
            Entity Matching
          </NavTab>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'overview' && <OverviewTab crawlerStatus={crawlerStatus} />}
        {activeTab === 'sources' && <SourcesTab sources={sources} onRefresh={loadData} />}
        {activeTab === 'crawler' && <CrawlerTab crawlerStatus={crawlerStatus} />}
        {activeTab === 'matching' && <EntityMatchingTab />}
      </main>
    </div>
  );
}

function NavTab({ active, onClick, children }: any) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-4 font-semibold border-b-2 transition-colors ${
        active
          ? 'text-indigo-600 border-indigo-600'
          : 'text-gray-600 border-transparent hover:text-indigo-600'
      }`}
    >
      {children}
    </button>
  );
}

function OverviewTab({ crawlerStatus }: { crawlerStatus: CrawlerStatus[] }) {
  const totalEvents = crawlerStatus.reduce((sum, s) => sum + s.total_events_discovered, 0);
  const totalListings = crawlerStatus.reduce((sum, s) => sum + s.total_listings_discovered, 0);
  const enabledSources = crawlerStatus.filter(s => s.enabled).length;
  const avgSuccessRate = (
    crawlerStatus.reduce((sum, s) => sum + parseFloat(s.success_rate || '0'), 0) / crawlerStatus.length
  ).toFixed(1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          title="Events Discovered"
          value={totalEvents.toLocaleString()}
          icon={<Database className="text-blue-600" />}
        />
        <StatCard
          title="Listings Indexed"
          value={totalListings.toLocaleString()}
          icon={<Database className="text-green-600" />}
        />
        <StatCard
          title="Active Sources"
          value={enabledSources}
          icon={<CheckCircle className="text-indigo-600" />}
        />
        <StatCard
          title="Success Rate"
          value={`${avgSuccessRate}%`}
          icon={<CheckCircle className="text-green-600" />}
        />
      </div>

      {/* Chart */}
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-xl font-bold mb-4">Crawl Performance by Source</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={crawlerStatus}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="source_name" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="total_events_discovered" fill="#3b82f6" name="Events" />
            <Bar dataKey="total_listings_discovered" fill="#10b981" name="Listings" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SourcesTab({ sources, onRefresh }: any) {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">Data Sources</h2>
        <button className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
          + Add Source
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-100 border-b">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-semibold">Source</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">Type</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">Events</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">Listings</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">Status</th>
              <th className="px-6 py-3 text-left text-sm font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id} className="border-b hover:bg-gray-50">
                <td className="px-6 py-4 font-semibold">{source.name}</td>
                <td className="px-6 py-4">
                  <span className="inline-block px-2 py-1 bg-gray-100 rounded text-sm">
                    {source.type}
                  </span>
                </td>
                <td className="px-6 py-4">{source.total_events_discovered.toLocaleString()}</td>
                <td className="px-6 py-4">{source.total_listings_discovered.toLocaleString()}</td>
                <td className="px-6 py-4">
                  {source.enabled ? (
                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-sm">
                      <CheckCircle size={14} /> Enabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-600 rounded text-sm">
                      <AlertTriangle size={14} /> Disabled
                    </span>
                  )}
                </td>
                <td className="px-6 py-4">
                  <button className="text-indigo-600 hover:text-indigo-700 font-semibold">
                    <Settings size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CrawlerTab({ crawlerStatus }: any) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Crawler Status</h2>

      <div className="grid grid-cols-1 gap-4">
        {crawlerStatus.map((status: CrawlerStatus) => (
          <div key={status.source_id} className="bg-white p-6 rounded-lg shadow-md">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-bold text-lg">{status.source_name}</h3>
                <p className="text-sm text-gray-600">
                  Last crawl: {status.last_crawl ? new Date(status.last_crawl).toLocaleString() : 'Never'}
                </p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-indigo-600">{status.success_rate}%</div>
                <div className="text-sm text-gray-600">Success Rate</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-gray-600">Events Discovered</div>
                <div className="text-2xl font-bold">{status.total_events_discovered.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Listings Indexed</div>
                <div className="text-2xl font-bold">{status.total_listings_discovered.toLocaleString()}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EntityMatchingTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Entity Matching Review</h2>
      <div className="bg-white p-6 rounded-lg shadow-md text-center py-12">
        <AlertTriangle className="mx-auto text-yellow-600 mb-4" size={32} />
        <p className="text-gray-600 text-lg">No pending matches for review</p>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon }: any) {
  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-gray-600 font-semibold">{title}</h3>
        {icon}
      </div>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}
