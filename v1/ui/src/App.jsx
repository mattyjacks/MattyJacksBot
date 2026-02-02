import { useState, useEffect } from 'react'
import { 
  Settings, 
  RefreshCw, 
  Play, 
  Square, 
  Upload, 
  Download,
  Wifi,
  WifiOff,
  FileText,
  Shield,
  MessageCircle,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Terminal,
  FolderSync,
  Bot,
  ExternalLink,
  Copy
} from 'lucide-react'

const API_BASE = '/api'

function useApi() {
  const [token, setToken] = useState(localStorage.getItem('authToken') || '')
  
  const fetchApi = async (endpoint, options = {}) => {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers
      }
    })
    
    if (res.status === 401) {
      throw new Error('Unauthorized - check your auth token')
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const raw = await res.text()
    const hasBody = raw && raw.trim().length > 0

    let data = null
    if (hasBody && contentType.includes('application/json')) {
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error('Server returned invalid JSON')
      }
    } else if (hasBody) {
      data = { message: raw }
    }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `Request failed (${res.status})`
      throw new Error(msg)
    }

    return data
  }
  
  return { fetchApi, token, setToken: (t) => { setToken(t); localStorage.setItem('authToken', t) } }
}

function StatusCard({ title, icon: Icon, children, status }) {
  const statusColors = {
    success: 'border-emerald-500/50',
    error: 'border-red-500/50',
    warning: 'border-yellow-500/50',
    neutral: 'border-gray-700'
  }
  
  return (
    <div className={`card border-l-4 ${statusColors[status] || statusColors.neutral}`}>
      <div className="flex items-center gap-3 mb-4">
        <Icon className="w-5 h-5 text-lobster-500" />
        <h3 className="font-semibold text-lg">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function App() {
  const { fetchApi, token, setToken } = useApi()
  const [status, setStatus] = useState(null)
  const [config, setConfig] = useState(null)
  const [logs, setLogs] = useState('')
  const [pendingPosts, setPendingPosts] = useState([])
  const [loading, setLoading] = useState({})
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [dashboardInfo, setDashboardInfo] = useState(null)
  
  const fetchStatus = async () => {
    try {
      const data = await fetchApi('/status')
      setStatus(data)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }
  
  const fetchConfig = async () => {
    try {
      const data = await fetchApi('/config')
      setConfig(data)
    } catch (err) {
      console.error('Failed to fetch config:', err)
    }
  }
  
  const fetchLogs = async () => {
    try {
      const data = await fetchApi('/logs?lines=100')
      setLogs(data.logs)
    } catch (err) {
      console.error('Failed to fetch logs:', err)
    }
  }
  
  const fetchPending = async () => {
    try {
      const data = await fetchApi('/moltbook/pending')
      setPendingPosts(data)
    } catch (err) {
      console.error('Failed to fetch pending:', err)
    }
  }
  
  useEffect(() => {
    if (token) {
      fetchStatus()
      fetchConfig()
      const interval = setInterval(fetchStatus, 10000)
      return () => clearInterval(interval)
    }
  }, [token])
  
  useEffect(() => {
    if (token && activeTab === 'logs') {
      fetchLogs()
      const interval = setInterval(fetchLogs, 5000)
      return () => clearInterval(interval)
    }
  }, [token, activeTab])
  
  useEffect(() => {
    if (token && activeTab === 'moltbook') {
      fetchPending()
    }
  }, [token, activeTab])
  
  const handleAction = async (action, endpoint, method = 'POST', body = {}) => {
    setLoading(prev => ({ ...prev, [action]: true }))
    try {
      await fetchApi(endpoint, { method, body: JSON.stringify(body) })
      await fetchStatus()
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(prev => ({ ...prev, [action]: false }))
    }
  }
  
  const openWebUI = async () => {
    setLoading(prev => ({ ...prev, webui: true }))
    try {
      const data = await fetchApi('/openclaw/webui', { method: 'POST' })
      setDashboardInfo(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(prev => ({ ...prev, webui: false }))
    }
  }
  
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
  }
  
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="card max-w-md w-full">
          <div className="text-center mb-6">
            <span className="text-6xl">🦞</span>
            <h1 className="text-2xl font-bold mt-4">MattyJacksBot Self Improving AI System</h1>
            <p className="text-gray-400 mt-1">MJBSIAIS</p>
            <p className="text-gray-400 mt-2">Enter your auth token to continue</p>
          </div>
          
          <div className="space-y-4">
            <input
              type="password"
              className="input"
              placeholder="Auth token"
              onKeyDown={(e) => e.key === 'Enter' && setToken(e.target.value)}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-sm text-gray-500">
              Run <code className="bg-gray-800 px-2 py-1 rounded">npm run start</code> and check the console for your token.
            </p>
          </div>
        </div>
      </div>
    )
  }
  
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: Bot },
    { id: 'sync', label: 'Sync', icon: FolderSync },
    { id: 'moltbook', label: 'Moltbook', icon: MessageCircle },
    { id: 'logs', label: 'Logs', icon: Terminal },
    { id: 'settings', label: 'Settings', icon: Settings }
  ]
  
  return (
    <div className="min-h-screen">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🦞</span>
            <div>
              <h1 className="font-bold text-xl">MattyJacksBot Self Improving AI System</h1>
              <p className="text-sm text-gray-400">MJBSIAIS Control Panel</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {status?.connection?.connected ? (
              <div className="flex items-center gap-2 text-emerald-400">
                <Wifi className="w-4 h-4" />
                <span className="text-sm">Connected</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-400">
                <WifiOff className="w-4 h-4" />
                <span className="text-sm">Disconnected</span>
              </div>
            )}
            
            <button onClick={fetchStatus} className="btn btn-secondary p-2">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>
      
      <nav className="bg-gray-900/50 border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors ${
                  activeTab === tab.id 
                    ? 'border-lobster-500 text-lobster-400' 
                    : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>
      
      <main className="max-w-7xl mx-auto p-6">
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-6 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400" />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300">
              <XCircle className="w-5 h-5" />
            </button>
          </div>
        )}
        
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <StatusCard 
              title="Connection" 
              icon={Wifi}
              status={status?.connection?.connected ? 'success' : 'error'}
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Host</span>
                  <span className="font-mono">{status?.connection?.host || 'Not configured'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Status</span>
                  <span className={status?.connection?.connected ? 'text-emerald-400' : 'text-red-400'}>
                    {status?.connection?.connected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
              </div>
              <button 
                onClick={() => handleAction('connect', '/connect')}
                disabled={loading.connect}
                className="btn btn-primary w-full mt-4"
              >
                {loading.connect ? 'Connecting...' : 'Connect'}
              </button>
            </StatusCard>
            
            <StatusCard 
              title="Agent" 
              icon={Bot}
              status={status?.agent?.running ? 'success' : 'warning'}
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Status</span>
                  <span className={status?.agent?.running ? 'text-emerald-400' : 'text-yellow-400'}>
                    {status?.agent?.running ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Model</span>
                  <span className="font-mono text-xs">{status?.agent?.model || 'Not loaded'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">VRAM</span>
                  <span>{status?.agent?.vram || 'Unknown'}</span>
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button 
                  onClick={() => handleAction('start', '/agent/start')}
                  disabled={loading.start || status?.agent?.running}
                  className="btn btn-success flex-1 flex items-center justify-center gap-2"
                >
                  <Play className="w-4 h-4" />
                  Start
                </button>
                <button 
                  onClick={() => handleAction('stop', '/agent/stop')}
                  disabled={loading.stop || !status?.agent?.running}
                  className="btn btn-danger flex-1 flex items-center justify-center gap-2"
                >
                  <Square className="w-4 h-4" />
                  Stop
                </button>
              </div>
              <button 
                onClick={openWebUI}
                disabled={loading.webui || !status?.connection?.connected}
                className="btn btn-secondary w-full mt-2 flex items-center justify-center gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                {loading.webui ? 'Checking...' : 'Open Web UI'}
              </button>
              {dashboardInfo && (
                <div className="mt-3 p-3 bg-gray-800 rounded-lg text-xs">
                  <p className={dashboardInfo.success ? 'text-emerald-400' : 'text-yellow-400'}>
                    {dashboardInfo.message}
                  </p>
                  {dashboardInfo.tunnelCommand && (
                    <div className="mt-2">
                      <p className="text-gray-400 mb-1">1. Run this SSH tunnel in a terminal:</p>
                      <div className="flex items-center gap-2">
                        <code className="bg-gray-900 px-2 py-1 rounded flex-1 overflow-x-auto text-xs">
                          {dashboardInfo.tunnelCommand}
                        </code>
                        <button 
                          onClick={() => copyToClipboard(dashboardInfo.tunnelCommand)}
                          className="p-1 hover:bg-gray-700 rounded"
                          title="Copy"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                  {dashboardInfo.webUrl && (
                    <div className="mt-2">
                      <p className="text-gray-400 mb-1">2. Then open (includes auth token):</p>
                      <div className="flex items-center gap-2">
                        <code className="bg-gray-900 px-2 py-1 rounded flex-1 overflow-x-auto text-xs text-emerald-400 break-all">
                          {dashboardInfo.webUrl}
                        </code>
                        <button 
                          onClick={() => copyToClipboard(dashboardInfo.webUrl)}
                          className="p-1 hover:bg-gray-700 rounded"
                          title="Copy URL"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => window.open(dashboardInfo.webUrl, '_blank')}
                          className="p-1 hover:bg-gray-700 rounded"
                          title="Open"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </StatusCard>
            
            <StatusCard 
              title="Moltbook" 
              icon={MessageCircle}
              status={status?.agent?.moltbookMode === 'readonly' ? 'warning' : 'success'}
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Mode</span>
                  <span className={
                    status?.agent?.moltbookMode === 'readonly' ? 'text-yellow-400' :
                    status?.agent?.moltbookMode === 'autonomous' ? 'text-emerald-400' :
                    'text-blue-400'
                  }>
                    {status?.agent?.moltbookMode || 'readonly'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Pending posts</span>
                  <span>{pendingPosts.length}</span>
                </div>
              </div>
              <select 
                className="input mt-4"
                value={status?.agent?.moltbookMode || 'readonly'}
                onChange={(e) => handleAction('moltbook', '/moltbook/mode', 'POST', { mode: e.target.value })}
              >
                <option value="readonly">Read Only</option>
                <option value="approval">Approval Required</option>
                <option value="autonomous">Autonomous</option>
              </select>
            </StatusCard>
            
            <StatusCard 
              title="Sync" 
              icon={FolderSync}
              status="neutral"
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Last sync</span>
                  <span>{status?.sync?.lastSync ? new Date(status.sync.lastSync).toLocaleString() : 'Never'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Public files</span>
                  <span>{status?.sync?.publicFiles || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Private files</span>
                  <span>{status?.sync?.privateFiles || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Artifacts</span>
                  <span>{status?.sync?.artifactFiles || 0}</span>
                </div>
              </div>
              <button 
                onClick={() => handleAction('sync', '/sync')}
                disabled={loading.sync}
                className="btn btn-primary w-full mt-4 flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${loading.sync ? 'animate-spin' : ''}`} />
                {loading.sync ? 'Syncing...' : 'Sync Now'}
              </button>
            </StatusCard>
            
            <StatusCard 
              title="Security" 
              icon={Shield}
              status="success"
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Sandbox</span>
                  <span className={config?.sandboxNonMain ? 'text-emerald-400' : 'text-yellow-400'}>
                    {config?.sandboxNonMain ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Post approval</span>
                  <span className={config?.requirePostApproval ? 'text-emerald-400' : 'text-yellow-400'}>
                    {config?.requirePostApproval ? 'Required' : 'Not required'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Conflict policy</span>
                  <span>{config?.syncConflictPolicy || 'newest'}</span>
                </div>
              </div>
            </StatusCard>
          </div>
        )}
        
        {activeTab === 'sync' && (
          <div className="space-y-6">
            <div className="card">
              <h2 className="text-xl font-bold mb-4">Bidirectional Sync</h2>
              <p className="text-gray-400 mb-6">
                Sync files between your local PC and the Vast.ai instance. Conflicts are resolved using the "{config?.syncConflictPolicy || 'newest'}" policy with backups.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Upload className="w-4 h-4 text-blue-400" />
                    <span className="font-medium">Public</span>
                  </div>
                  <p className="text-2xl font-bold">{status?.sync?.publicFiles || 0}</p>
                  <p className="text-sm text-gray-400">files (can be posted)</p>
                </div>
                
                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-4 h-4 text-yellow-400" />
                    <span className="font-medium">Private</span>
                  </div>
                  <p className="text-2xl font-bold">{status?.sync?.privateFiles || 0}</p>
                  <p className="text-sm text-gray-400">files (never posted)</p>
                </div>
                
                <div className="bg-gray-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Download className="w-4 h-4 text-emerald-400" />
                    <span className="font-medium">Artifacts</span>
                  </div>
                  <p className="text-2xl font-bold">{status?.sync?.artifactFiles || 0}</p>
                  <p className="text-sm text-gray-400">files from agent</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <button 
                  onClick={() => handleAction('sync', '/sync')}
                  disabled={loading.sync}
                  className="btn btn-primary flex items-center gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${loading.sync ? 'animate-spin' : ''}`} />
                  {loading.sync ? 'Syncing...' : 'Run Full Sync'}
                </button>
                
                <button 
                  onClick={() => handleAction('syncDry', '/sync', 'POST', { dryRun: true })}
                  disabled={loading.syncDry}
                  className="btn btn-secondary flex items-center gap-2"
                >
                  <FileText className="w-4 h-4" />
                  Dry Run
                </button>
              </div>
            </div>
            
            <div className="card">
              <h3 className="font-semibold mb-2">Sync Root</h3>
              <p className="font-mono text-sm text-gray-400">{status?.sync?.syncRoot || config?.syncRoot || 'Not configured'}</p>
            </div>
          </div>
        )}
        
        {activeTab === 'moltbook' && (
          <div className="space-y-6">
            <div className="card">
              <h2 className="text-xl font-bold mb-4">Moltbook Integration</h2>
              <p className="text-gray-400 mb-6">
                Control how your agent interacts with the Moltbook social network.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {['readonly', 'approval', 'autonomous'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => handleAction('moltbook', '/moltbook/mode', 'POST', { mode })}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      status?.agent?.moltbookMode === mode 
                        ? 'border-lobster-500 bg-lobster-500/10' 
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <h3 className="font-semibold capitalize">{mode}</h3>
                    <p className="text-sm text-gray-400 mt-1">
                      {mode === 'readonly' && 'Agent can read but not post'}
                      {mode === 'approval' && 'Posts require your approval'}
                      {mode === 'autonomous' && 'Agent posts independently'}
                    </p>
                  </button>
                ))}
              </div>
            </div>
            
            {pendingPosts.length > 0 && (
              <div className="card">
                <h3 className="font-semibold mb-4">Pending Posts ({pendingPosts.length})</h3>
                <div className="space-y-4">
                  {pendingPosts.map(post => (
                    <div key={post.id} className="bg-gray-800 rounded-lg p-4">
                      <p className="text-sm text-gray-400 mb-2">ID: {post.id}</p>
                      <p className="mb-4">{post.content}</p>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => handleAction(`approve-${post.id}`, `/moltbook/approve/${post.id}`)}
                          className="btn btn-success flex items-center gap-2"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Approve
                        </button>
                        <button 
                          onClick={() => handleAction(`reject-${post.id}`, `/moltbook/reject/${post.id}`)}
                          className="btn btn-danger flex items-center gap-2"
                        >
                          <XCircle className="w-4 h-4" />
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'logs' && (
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Gateway Logs</h2>
              <button onClick={fetchLogs} className="btn btn-secondary p-2">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-gray-950 rounded-lg p-4 h-[600px] overflow-auto font-mono text-sm">
              {logs ? (
                logs.split('\n').map((line, i) => (
                  <div 
                    key={i} 
                    className={`log-line ${
                      line.toLowerCase().includes('error') ? 'error' :
                      line.toLowerCase().includes('warn') ? 'warn' :
                      line.toLowerCase().includes('info') ? 'info' : ''
                    }`}
                  >
                    {line}
                  </div>
                ))
              ) : (
                <p className="text-gray-500">No logs available</p>
              )}
            </div>
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="card">
              <h2 className="text-xl font-bold mb-4">Configuration</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Model Family</label>
                  <input type="text" className="input" value={config?.modelFamily || ''} readOnly />
                </div>
                
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Gateway Port</label>
                  <input type="text" className="input" value={config?.gatewayPort || ''} readOnly />
                </div>
                
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Sync Conflict Policy</label>
                  <input type="text" className="input" value={config?.syncConflictPolicy || ''} readOnly />
                </div>
              </div>
              
              <p className="text-sm text-gray-500 mt-4">
                Edit the <code className="bg-gray-800 px-2 py-1 rounded">.env</code> file to change these settings.
              </p>
            </div>
            
            <div className="card">
              <h3 className="font-semibold mb-4">Auth Token</h3>
              <div className="flex gap-2">
                <input 
                  type="password" 
                  className="input flex-1" 
                  value={token} 
                  onChange={(e) => setToken(e.target.value)}
                />
                <button 
                  onClick={() => { setToken(''); localStorage.removeItem('authToken') }}
                  className="btn btn-danger"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
