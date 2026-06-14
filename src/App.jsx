import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { FileClock, Link2, LogOut, QrCode, RefreshCcw } from 'lucide-react';
import jsQR from 'jsqr';

import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Textarea } from './components/ui/textarea';

const timelineSteps = [
  { key: 'queued', label: 'We received the TV code.' },
  { key: 'validating', label: 'We are checking the code format.' },
  { key: 'submitting_code', label: 'We are sending the code to Suka.' },
  { key: 'paired', label: 'We are waiting for the TV to confirm.' },
];

function toneFromSession(session) {
  if (!session?.hasAccessToken || session.accessTokenExpired) {
    return 'danger';
  }

  if (session.refreshRecommended) {
    return 'warn';
  }

  return 'ok';
}

function labelFromSession(session) {
  if (!session?.hasAccessToken) {
    return 'Missing';
  }

  if (session.accessTokenExpired) {
    return 'Expired';
  }

  if (session.refreshRecommended) {
    return 'Refresh soon';
  }

  return 'Ready';
}

function toneFromJob(stage) {
  if (!stage) {
    return 'neutral';
  }

  if (stage === 'paired') {
    return 'ok';
  }

  if (['pairing_failed', 'timed_out', 'blocked', 'rejected'].includes(stage)) {
    return 'danger';
  }

  if (['waiting_confirmation', 'pairing'].includes(stage)) {
    return 'warn';
  }

  return 'neutral';
}

function getTimelineState(stage) {
  if (!stage) return { activeIndex: 0, isFailed: false, isSuccess: false };

  const failed = ['pairing_failed', 'timed_out', 'blocked', 'rejected'].includes(stage);
  const success = stage === 'paired';

  let activeIndex = 0;
  if (stage === 'queued') {
    activeIndex = 0;
  } else if (stage === 'validating') {
    activeIndex = 1;
  } else if (stage === 'opening_sooka_session' || stage === 'submitting_code') {
    activeIndex = 2;
  } else if (stage === 'waiting_confirmation' || stage === 'paired' || failed) {
    activeIndex = 3;
  }

  return { activeIndex, isFailed: failed, isSuccess: success };
}

function formatDateTime(value) {
  if (!value) {
    return 'Not recorded';
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }

  if (ms <= 0) {
    return 'expired';
  }

  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) {
    parts.push(`${days}d`);
  }
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes || !parts.length) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ');
}

function formatRelativeTime(value) {
  if (!value) {
    return 'Not refreshed yet';
  }

  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return formatDateTime(value);
  }

  const diffSeconds = Math.round(diffMs / 1000);
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  return `${diffHours}h ago`;
}

function sanitizeDisplayCode(rawInput) {
  if (!rawInput) {
    return null;
  }

  const trimmed = rawInput.trim();

  try {
    const parsed = new URL(trimmed);
    const candidate = parsed.searchParams.get('code') || parsed.searchParams.get('pair') || parsed.searchParams.get('token');
    if (candidate) {
      const cleanedCandidate = candidate.trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(cleanedCandidate)) {
        return cleanedCandidate;
      }
    }
  } catch {
    // Not a URL.
  }

  const cleaned = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{6}$/.test(cleaned) ? cleaned : null;
}

function readImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxDimension = 1024;
        let width = img.width;
        let height = img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Failed to get canvas 2D context');
        }
        context.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image. Make sure the file is a valid image.'));
    };
    img.src = url;
  });
}

async function detectQrCode(file) {
  if (!file) {
    return null;
  }

  let canvas;
  try {
    canvas = await readImageToCanvas(file);
  } catch (err) {
    console.error('Failed to load image to canvas:', err);
    throw new Error(`Failed to load image: ${err.message}`);
  }

  // Attempt 1: Native BarcodeDetector (if supported)
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const results = await detector.detect(canvas);
      if (results[0]?.rawValue) {
        return results[0].rawValue;
      }
    } catch (err) {
      console.warn('Native BarcodeDetector failed, trying bundled jsQR:', err);
    }
  }

  // Attempt 2: Standard jsQR scan on original canvas
  try {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not get 2D context from canvas');
    }
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (result?.data) {
      return result.data;
    }
  } catch (error) {
    console.error('jsQR original scan failed:', error);
  }

  // Attempt 3: jsQR scan with Grayscale & Contrast Boosting (fallback for TV screen photo glare)
  try {
    const context = canvas.getContext('2d');
    if (context) {
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // In-place grayscale + contrast multiplier (factor = 3.0)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];

        // Luminance grayscale formula
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;

        // Boost contrast around midtones
        let val = (gray - 128) * 3.0 + 128;
        if (val < 0) val = 0;
        if (val > 255) val = 255;

        data[i] = val;
        data[i+1] = val;
        data[i+2] = val;
      }

      const processedResult = jsQR(data, imageData.width, imageData.height);
      if (processedResult?.data) {
        return processedResult.data;
      }
    }
  } catch (error) {
    console.error('jsQR processed scan failed:', error);
  }

  return null;
}

function summarizeLog(entry) {
  const details = { ...entry };
  delete details.ts;
  delete details.level;
  delete details.event;

  const compact = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' • ');

  return compact || 'No extra details.';
}

async function apiJson(url, init = {}) {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null;

  if (response.status === 401 && payload?.error === 'Authentication required') {
    throw new Error('AUTH_REQUIRED');
  }

  if (!response.ok) {
    const message = payload?.details || payload?.error || 'Request failed';
    throw new Error(message);
  }

  if (url.startsWith('/api/') && payload === null) {
    throw new Error('The portal returned an invalid response. Sign in again or restart the server.');
  }

  return payload;
}

function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PortalPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let ignore = false;

    apiJson('/api/me')
      .then(() => {
        if (!ignore) {
          navigate('/', { replace: true, state: location.state });
        }
      })
      .catch(() => {
        // Stay on login.
      });

    return () => {
      ignore = true;
    };
  }, [location.state, navigate]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setMessage('Enter both the portal username and password.');
      return;
    }

    setBusy(true);
    setMessage('Signing you in...');

    try {
      await apiJson('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      navigate('/', { replace: true });
    } catch (error) {
      setMessage(error.message === 'AUTH_REQUIRED' ? 'The portal needs you to sign in again.' : error.message);
      setBusy(false);
    }
  }

  return (
    <main className="shell items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="label" htmlFor="username">Username</label>
              <Input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </div>
            <Button className="w-full" disabled={busy} type="submit">{busy ? 'Signing in...' : 'Sign in'}</Button>
          </form>
          { message &&
            <div className="mt-4 rounded-xl border border-border/70 bg-background/70 p-3 text-sm text-muted-foreground">{message}</div>
          }
        </CardContent>
      </Card>
    </main>
  );
}

function PortalPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('pairing');
  const [authUser, setAuthUser] = useState(null);
  const [session, setSession] = useState(null);
  const [contact, setContact] = useState(null);
  const [pairInput, setPairInput] = useState('');
  const [job, setJob] = useState(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [activityLog, setActivityLog] = useState('Loading workspace...');
  const [scanStatus, setScanStatus] = useState(null); // 'loading' | 'success' | 'error' | null
  const [scanMessage, setScanMessage] = useState('');
  const [loginResponse, setLoginResponse] = useState('');
  const [requestHeaders, setRequestHeaders] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionLastRefreshedAt, setSessionLastRefreshedAt] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsSummary, setJobsSummary] = useState({ total: 0, active: 0, paired: 0, failed: 0 });
  const [logs, setLogs] = useState([]);
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsLastRefreshedAt, setLogsLastRefreshedAt] = useState(null);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
  const [clockTick, setClockTick] = useState(Date.now());
  const [logLevel, setLogLevel] = useState('');
  const [logEventFilter, setLogEventFilter] = useState('');
  const [logPage, setLogPage] = useState(1);
  const LOG_PAGE_SIZE = 20;
  const pollingRef = useRef(null);
  const fileInputRef = useRef(null);

  const sessionCountdownMs = session?.accessTokenExpiresAt
    ? new Date(session.accessTokenExpiresAt).getTime() - clockTick
    : session?.accessTokenExpiresInMs ?? null;
  const sessionLabel = labelFromSession({
    ...session,
    accessTokenExpired: Number.isFinite(sessionCountdownMs) ? sessionCountdownMs <= 0 : session?.accessTokenExpired,
    refreshRecommended: Number.isFinite(sessionCountdownMs) ? sessionCountdownMs <= 10 * 60 * 1000 : session?.refreshRecommended,
  });
  const sessionTone = toneFromSession(session);

  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (logLevel && entry.level !== logLevel) {
        return false;
      }

      if (logEventFilter && !String(entry.event || '').toLowerCase().includes(logEventFilter.toLowerCase())) {
        return false;
      }

      return true;
    });
  }, [logEventFilter, logLevel, logs]);

  const logPageCount = Math.max(1, Math.ceil(filteredLogs.length / LOG_PAGE_SIZE));
  const pagedLogs = filteredLogs.slice((logPage - 1) * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE);

  // Reset to page 1 whenever filters change.
  useEffect(() => { setLogPage(1); }, [logLevel, logEventFilter]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  async function refreshSessionStatus() {
    const [me, bootstrap] = await Promise.all([
      apiJson('/api/me'),
      apiJson('/api/bootstrap/status'),
    ]);

    if (!me || typeof me.user !== 'string') {
      throw new Error('The portal session could not be loaded. Sign in again.');
    }

    setAuthUser(me.user);
    setSession(bootstrap.session || me.session);
    setContact(bootstrap.session?.lastVerifiedContact || me.session?.lastVerifiedContact || null);
    setSessionLastRefreshedAt(new Date().toISOString());
    return { me, bootstrap };
  }

  async function refreshJobs() {
    const payload = await apiJson('/api/jobs');
    setJobs(payload.items || []);
    setJobsSummary(payload.summary || { total: 0, active: 0, paired: 0, failed: 0 });
    return payload;
  }

  async function refreshLogs() {
    setLogsBusy(true);
    try {
      const payload = await apiJson('/api/logs?minutes=60');
      setLogs(payload.items || []);
      setLogsLastRefreshedAt(new Date().toISOString());
      return payload;
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
      }

      throw error;
    } finally {
      setLogsBusy(false);
    }
  }

  useEffect(() => {
    let ignore = false;

    async function boot() {
      try {
        const [, jobsPayload, logsPayload] = await Promise.all([
          refreshSessionStatus(),
          refreshJobs(),
          refreshLogs(),
        ]);

        if (ignore) {
          return;
        }

        setJobs(jobsPayload.items || []);
        setLogs(logsPayload.items || []);
        setActivityLog('Ready. Paste the TV code or upload a QR screenshot to start pairing.');
      } catch (error) {
        if (!ignore) {
          if (error.message === 'AUTH_REQUIRED') {
            navigate('/login', { replace: true });
            return;
          }

          setActivityLog(error.message);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    boot();

    return () => {
      ignore = true;
      window.clearInterval(pollingRef.current);
    };
  }, [navigate]);

  useEffect(() => {
    if (activeTab !== 'session') {
      return undefined;
    }

    const timer = window.setInterval(() => {
      refreshSessionStatus().catch((error) => {
        if (error.message === 'AUTH_REQUIRED') {
          navigate('/login', { replace: true });
        }
      });
    }, 30000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeTab, navigate]);

  useEffect(() => {
    if (activeTab !== 'logging' || !autoRefreshLogs) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      refreshLogs().catch(() => {
        // Route handling is already inside refreshLogs.
      });
    }, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeTab, autoRefreshLogs, navigate]);

  async function pollJob(jobId) {
    window.clearInterval(pollingRef.current);
    pollingRef.current = window.setInterval(async () => {
      try {
        const nextJob = await apiJson(`/api/jobs/${jobId}`);
        setJob(nextJob);
        setActivityLog([
          `Stage: ${nextJob.stage.replaceAll('_', ' ')}`,
          `Message: ${nextJob.message}`,
          nextJob.resultDetails ? `Details: ${nextJob.resultDetails}` : null,
          `Updated: ${new Date(nextJob.updatedAt).toLocaleTimeString()}`,
        ].filter(Boolean).join('\n'));

        setJobs((current) => {
          const rest = current.filter((entry) => entry.id !== nextJob.id);
          return [nextJob, ...rest].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
        });

        if (nextJob.terminal) {
          window.clearInterval(pollingRef.current);
          setJobBusy(false);
          await refreshJobs();
        }
      } catch (error) {
        window.clearInterval(pollingRef.current);
        setJobBusy(false);
        setActivityLog(`Polling failed: ${error.message}`);
      }
    }, 900);
  }

  async function handleLogout() {
    try {
      await apiJson('/api/auth/logout', { method: 'POST' });
    } finally {
      navigate('/login', { replace: true });
    }
  }

  async function handleFile(file) {
    if (!file) {
      setScanStatus('error');
      setScanMessage('No file selected.');
      return;
    }

    setScanStatus('loading');
    setScanMessage(`Loading "${file.name}" (${(file.size / 1024).toFixed(1)} KB)...`);
    setActivityLog(`Loading "${file.name}" (${(file.size / 1024).toFixed(1)} KB)...`);

    try {
      const decoded = await detectQrCode(file);
      if (!decoded) {
        setScanStatus('error');
        setScanMessage(`Could not find a valid QR code in "${file.name}". Please make sure the screenshot is clear and uncropped.`);
        setActivityLog(`Could not find a valid QR code in "${file.name}".\n\nPlease make sure the QR screenshot is clear and uncropped, or enter the 6-character TV code manually.`);
        return;
      }

      setPairInput(decoded);
      setScanStatus('success');
      setScanMessage(`Successfully scanned QR code from "${file.name}"!`);
      setActivityLog(`Successfully scanned QR code from "${file.name}".\n\nDecoded URL/Code:\n${decoded}`);
    } catch (error) {
      setScanStatus('error');
      setScanMessage(`Error scanning image: ${error.message}`);
      setActivityLog(`Error processing image "${file.name}":\n${error.message}`);
    }
  }

  async function handlePairSubmit(event) {
    event.preventDefault();
    const rawInput = pairInput.trim();

    if (!sanitizeDisplayCode(rawInput)) {
      setActivityLog('Enter the TV pairing code or upload the QR screenshot first.');
      return;
    }

    setJobBusy(true);
    setActivityLog('Starting the pairing request...');

    try {
      const payload = await apiJson('/api/pair', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rawInput }),
      });

      setJob(payload);
      setJobs((current) => {
        const rest = current.filter((entry) => entry.id !== payload.id);
        return [payload, ...rest].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });
      setActivityLog([
        `Stage: ${payload.stage.replaceAll('_', ' ')}`,
        `Message: ${payload.message}`,
        payload.code ? `Code: ${payload.code}` : 'Code: not accepted',
      ].join('\n'));
      await refreshJobs();
      await pollJob(payload.id);
    } catch (error) {
      setJobBusy(false);
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Pairing failed: ${error.message}`);
    }
  }

  async function openJobFromHistory(jobId) {
    try {
      const payload = await apiJson(`/api/jobs/${jobId}`);
      setJob(payload);
      setActivityLog([
        `Stage: ${payload.stage.replaceAll('_', ' ')}`,
        `Message: ${payload.message}`,
        payload.resultDetails ? `Details: ${payload.resultDetails}` : null,
        `Updated: ${formatDateTime(payload.updatedAt)}`,
      ].filter(Boolean).join('\n'));

      if (!payload.terminal) {
        setJobBusy(true);
        await pollJob(payload.id);
      }
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Could not load that job: ${error.message}`);
    }
  }

  function clearPairing() {
    window.clearInterval(pollingRef.current);
    setPairInput('');
    setJob(null);
    setJobBusy(false);
    setScanStatus(null);
    setScanMessage('');
    setActivityLog('Waiting for the next TV code.');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function saveSession(event) {
    event.preventDefault();
    if (!loginResponse.trim()) {
      setActivityLog('Paste the Suka login JSON before saving the session.');
      return;
    }

    setSessionBusy(true);
    setActivityLog('Saving the Suka session...');
    try {
      const payload = await apiJson('/api/bootstrap/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ loginResponse, requestHeaders }),
      });
      setSession(payload.session || null);
      setContact(payload.contact || payload.session?.lastVerifiedContact || null);
      setActivityLog(`Session saved. ${payload.message || 'The token is ready for pairing.'}`);
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Session save failed: ${error.message}`);
    } finally {
      setSessionBusy(false);
    }
  }

  async function verifySession() {
    setSessionBusy(true);
    setActivityLog('Checking the current Suka session...');
    try {
      const payload = await apiJson('/api/bootstrap/verify', { method: 'POST' });
      setSession(payload.session || null);
      setContact(payload.contact || payload.session?.lastVerifiedContact || null);
      setActivityLog(payload.ok ? payload.details : `Session verification failed: ${payload.details || 'Unknown error'}`);
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Session verification failed: ${error.message}`);
    } finally {
      setSessionBusy(false);
    }
  }

  async function refreshSessionToken() {
    setSessionBusy(true);
    setActivityLog('Refreshing the saved token...');
    try {
      const payload = await apiJson('/api/session/refresh', { method: 'POST' });
      setSession(payload.session || null);
      setSessionLastRefreshedAt(new Date().toISOString());
      setActivityLog(payload.refreshed ? 'The saved token was refreshed successfully.' : 'The saved token did not need a refresh.');
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Token refresh failed: ${error.message}`);
    } finally {
      setSessionBusy(false);
    }
  }

  async function clearSession() {
    setSessionBusy(true);
    setActivityLog('Clearing the saved Suka session...');
    try {
      const payload = await apiJson('/api/bootstrap/clear', { method: 'POST' });
      setLoginResponse('');
      setRequestHeaders('');
      setSession(payload.session || null);
      setContact(null);
      setActivityLog('The saved Suka session was cleared.');
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') {
        navigate('/login', { replace: true });
        return;
      }

      setActivityLog(`Clear session failed: ${error.message}`);
    } finally {
      setSessionBusy(false);
    }
  }

  const progressWidth = `${job?.progress || 0}%`;
  const activeJobText = job?.stage ? job.stage.replaceAll('_', ' ') : 'idle';


  if (loading) {
    return (
      <main className="shell justify-center">
        <Card className="mx-auto max-w-xl">
          <CardContent className="p-8">
            <p className="text-sm text-muted-foreground">Loading the pairing workspace...</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant={sessionTone}>{session ? `Session ${sessionLabel.toLowerCase()}` : 'Checking'}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">{authUser}</p>
          <Button variant="outline" size="sm" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            Log out
          </Button>
        </div>
      </header>



      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pairing">Pairing</TabsTrigger>
          <TabsTrigger value="session">Session</TabsTrigger>
          <TabsTrigger value="logging">Logging</TabsTrigger>
        </TabsList>

        <TabsContent value="pairing">
          <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Pair a TV</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-5" onSubmit={handlePairSubmit}>
                  <div>
                    <label className="label" htmlFor="pairing-code">TV code or Suka pairing link</label>
                    <Input
                      id="pairing-code"
                      rows={4}
                      placeholder="NXXMP2 or https://suka.my/pair-tv?code=NXXMP2"
                      value={pairInput}
                      onChange={(event) => {
                        setPairInput(event.target.value);
                        if (scanStatus) {
                          setScanStatus(null);
                          setScanMessage('');
                        }
                      }}
                      disabled={jobBusy}
                    />
                  </div>

                  <div className="rounded-[1.5rem] border border-dashed border-border bg-background/60 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold">QR screenshot</p>
                      <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                        <QrCode className="h-4 w-4" />
                        Choose image
                      </Button>
                    </div>
                    <input
                      ref={fileInputRef}
                      className="sr-only"
                      type="file"
                      accept="image/*"
                      onChange={async (event) => {
                        const [file] = event.target.files || [];
                        if (file) {
                          await handleFile(file);
                        }
                        event.target.value = '';
                      }}
                    />
                    {scanStatus && (
                      <div className={`mt-3 rounded-xl border p-3 text-xs leading-relaxed ${
                        scanStatus === 'loading'
                          ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                          : scanStatus === 'success'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                      }`}>
                        {scanMessage}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button disabled={jobBusy} type="submit">{jobBusy ? 'Pairing...' : 'Start pairing'}</Button>
                    <Button type="button" variant="outline" onClick={clearPairing}>Clear</Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Live progress</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>{job ? `${activeJobText}${job.deviceName ? ` (${job.deviceName})` : ''}` : 'Idle'}</span>
                    <span>{job?.progress || 0}%</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-secondary">
                    <div className={`h-full rounded-full transition-all ${
                      job?.stage === 'paired' 
                        ? 'bg-emerald-500' 
                        : ['pairing_failed', 'timed_out', 'blocked', 'rejected'].includes(job?.stage) 
                          ? 'bg-rose-500' 
                          : 'bg-primary'
                    }`} style={{ width: progressWidth }} />
                  </div>
                </div>

                <div className="grid gap-3">
                  {timelineSteps.map((step, index) => {
                    if (!job) {
                      return (
                        <div key={step.key} className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/60 p-3">
                          <div className="mt-1 h-3 w-3 rounded-full bg-secondary" />
                          <p className="text-sm text-muted-foreground">{step.label}</p>
                        </div>
                      );
                    }

                    const { activeIndex, isFailed, isSuccess } = getTimelineState(job.stage);
                    const isActive = index === activeIndex;
                    const isDone = index < activeIndex || (index === activeIndex && isSuccess);

                    let dotColor = 'bg-secondary';
                    if (isDone) {
                      dotColor = 'bg-emerald-500'; // Green for OK
                    } else if (isActive) {
                      if (isFailed) {
                        dotColor = 'bg-rose-500'; // Red if wrong
                      } else {
                        dotColor = 'bg-amber-500'; // Amber if active
                      }
                    }

                    return (
                      <div key={step.key} className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/60 p-3">
                        <div className={`mt-1 h-3 w-3 rounded-full ${dotColor}`} />
                        <p className="text-sm text-muted-foreground">{step.label}</p>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Activity console</p>
                    <Badge variant={toneFromJob(job?.stage)}>{job ? activeJobText : 'idle'}</Badge>
                  </div>
                  <pre className="min-h-48 overflow-x-auto rounded-[1.5rem] border border-border/70 bg-slate-950 p-4 text-sm leading-6 text-slate-100">{activityLog}</pre>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>History</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="neutral">{jobsSummary.total} total</Badge>
                  <Badge variant="ok">{jobsSummary.paired} paired</Badge>
                  {jobsSummary.failed > 0 && <Badge variant="danger">{jobsSummary.failed} failed</Badge>}
                  <Button type="button" variant="outline" size="sm" onClick={refreshJobs}><RefreshCcw className="h-3 w-3" /></Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {jobs.length ? jobs.slice(0, 6).map((entry) => (
                  <div key={entry.id} className="flex flex-col gap-3 rounded-[1.25rem] border border-border/70 bg-background/60 p-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={toneFromJob(entry.stage)}>{entry.stage.replaceAll('_', ' ')}</Badge>
                      <p className="text-sm font-semibold">{entry.code || '—'}</p>
                      {entry.deviceName && (
                        <span className="text-xs text-muted-foreground">• {entry.deviceName}</span>
                      )}
                      <p className="text-xs text-muted-foreground">• {formatDateTime(entry.updatedAt)}</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => openJobFromHistory(entry.id)}>
                      {entry.terminal ? 'View' : 'Monitor'}
                    </Button>
                  </div>
                )) : (
                  <div className="rounded-[1.25rem] border border-border/70 bg-background/60 p-6 text-sm text-muted-foreground">No jobs yet.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="session">
          <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <CardTitle>Session</CardTitle>
                  <Badge variant={sessionTone}>{sessionLabel}</Badge>
                  <Badge variant="neutral">{session?.source || 'no source'}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <StatusItem label="Account" value={contact?.name || contact?.email || 'Not verified'} />
                  <StatusItem label="Customer ID" value={session?.customerId || '—'} />
                  <StatusItem label="Valid until" value={session?.accessTokenExpiresAt ? `${formatDateTime(session.accessTokenExpiresAt)} (${formatDuration(sessionCountdownMs)} left)` : '—'} />
                  <StatusItem label="Updated" value={formatDateTime(session?.updatedAt || session?.savedAt)} />
                  <StatusItem label="Access token" value={session?.accessTokenPreview || 'Missing'} />
                  <StatusItem label="Refresh token" value={session?.refreshTokenPreview || 'Missing'} />
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Update session</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-5" onSubmit={saveSession}>
                  <div>
                    <label className="label" htmlFor="login-response">Login response JSON</label>
                    <Textarea id="login-response" rows={9} value={loginResponse} onChange={(event) => setLoginResponse(event.target.value)} disabled={sessionBusy} placeholder='{"status":true,"data":{"accessToken":"..."}}' />
                  </div>
                  <div>
                    <label className="label" htmlFor="request-headers">Request headers JSON (optional)</label>
                    <Textarea id="request-headers" rows={7} value={requestHeaders} onChange={(event) => setRequestHeaders(event.target.value)} disabled={sessionBusy} placeholder='{"x-pf":"web","tenant_identifier":"master"}' />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button disabled={sessionBusy} type="submit">Save session</Button>
                    <Button disabled={sessionBusy} type="button" variant="outline" onClick={verifySession}>Verify session</Button>
                    <Button disabled={sessionBusy} type="button" variant="outline" onClick={refreshSessionToken}>Refresh token</Button>
                    <Button disabled={sessionBusy} type="button" variant="ghost" onClick={clearSession}>Clear session</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="logging">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Logs</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="neutral">Updated {formatRelativeTime(logsLastRefreshedAt)}</Badge>
                  <Button type="button" size="sm" variant={autoRefreshLogs ? 'secondary' : 'outline'} onClick={() => setAutoRefreshLogs((current) => !current)}>
                    {autoRefreshLogs ? 'Auto' : 'Manual'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => refreshLogs().catch(() => {})}>
                    <RefreshCcw className={`h-4 w-4 ${logsBusy ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 lg:grid-cols-[180px_1fr]">
                <div>
                  <label className="label" htmlFor="level-filter">Level</label>
                  <select id="level-filter" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={logLevel} onChange={(event) => setLogLevel(event.target.value)}>
                    <option value="">All</option>
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="event-filter">Event</label>
                  <Input id="event-filter" value={logEventFilter} onChange={(event) => setLogEventFilter(event.target.value)} placeholder="pairing.job or session.verify" />
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-border/70">
                {pagedLogs.length ? pagedLogs.map((entry, index) => (
                  <LogEntry key={`${entry.ts}-${entry.event}-${index}`} entry={entry} />
                )) : (
                  <div className="p-6 text-sm text-muted-foreground">No entries.</div>
                )}
              </div>

              {filteredLogs.length > LOG_PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2">
                  <p className="text-xs text-muted-foreground">
                    {(logPage - 1) * LOG_PAGE_SIZE + 1}–{Math.min(logPage * LOG_PAGE_SIZE, filteredLogs.length)} of {filteredLogs.length}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={logPage <= 1} onClick={() => setLogPage((p) => p - 1)}>Prev</Button>
                    <span className="text-xs text-muted-foreground">{logPage} / {logPageCount}</span>
                    <Button size="sm" variant="outline" disabled={logPage >= logPageCount} onClick={() => setLogPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}

function StatusItem({ label, value }) {
  return (
    <div className="rounded-[1.25rem] border border-border/70 bg-background/60 p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function LogEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const { ts, level, event, ...rest } = entry;

  const summary = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 3)
    .map(([k, v]) => {
      const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}: ${display.length > 40 ? display.slice(0, 40) + '…' : display}`;
    })
    .join('  ·  ');

  const levelVariant = level === 'error' ? 'danger' : level === 'info' ? 'ok' : 'neutral';

  return (
    <div
      className="border-b border-border/70 last:border-0 cursor-pointer select-none"
      onClick={() => setOpen((o) => !o)}
    >
      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors">
        <Badge variant={levelVariant} className="shrink-0 w-10 justify-center">{level}</Badge>
        <span className="text-sm font-medium text-foreground shrink-0">{event}</span>
        {summary && (
          <span className="text-xs text-muted-foreground truncate flex-1">{summary}</span>
        )}
        <span className="text-xs text-muted-foreground shrink-0 ml-auto">{formatDateTime(ts)}</span>
      </div>
      {open && (
        <pre className="border-t border-border/70 bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-100 overflow-x-auto">{JSON.stringify(entry, null, 2)}</pre>
      )}
    </div>
  );
}

export default AppRouter;