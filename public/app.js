const authPill = document.getElementById('auth-pill');
const jobPill = document.getElementById('job-pill');
const sessionPill = document.getElementById('session-pill');
const quickAuth = document.getElementById('quick-auth');
const quickAuthMeta = document.getElementById('quick-auth-meta');
const quickSession = document.getElementById('quick-session');
const quickSessionMeta = document.getElementById('quick-session-meta');
const quickJobs = document.getElementById('quick-jobs');
const quickJobsMeta = document.getElementById('quick-jobs-meta');
const form = document.getElementById('pair-form');
const codeInput = document.getElementById('code-input');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const clearButton = document.getElementById('clear-button');
const bootstrapForm = document.getElementById('bootstrap-form');
const bootstrapLoginResponseInput = document.getElementById('bootstrap-login-response');
const bootstrapHeadersInput = document.getElementById('bootstrap-request-headers');
const bootstrapVerifyButton = document.getElementById('bootstrap-verify-button');
const bootstrapClearButton = document.getElementById('bootstrap-clear-button');
const logoutButton = document.getElementById('logout-button');
const progressBar = document.getElementById('progress-bar');
const stageLabel = document.getElementById('stage-label');
const progressLabel = document.getElementById('progress-label');
const statusLog = document.getElementById('status-log');
const consoleContext = document.getElementById('console-context');
const sessionGuidance = document.getElementById('session-guidance');
const sessionSummaryState = document.getElementById('session-summary-state');
const sessionSource = document.getElementById('session-source');
const sessionCustomerId = document.getElementById('session-customer-id');
const sessionCampaignId = document.getElementById('session-campaign-id');
const sessionProfileId = document.getElementById('session-profile-id');
const sessionExpiry = document.getElementById('session-expiry');
const sessionUpdatedAt = document.getElementById('session-updated-at');
const sessionHeaders = document.getElementById('session-headers');
const sessionIdentityName = document.getElementById('session-identity-name');
const sessionIdentityMeta = document.getElementById('session-identity-meta');
const sessionStoreFile = document.getElementById('session-store-file');
const timeline = Array.from(document.querySelectorAll('.timeline-item'));

let pollTimer = null;
const uiState = {
  authUser: null,
  openJobs: 0,
  session: null,
  contact: null,
  currentJob: null,
};

function setLog(message) {
  statusLog.textContent = message;
}

function setPill(element, text, tone = 'muted') {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.dataset.tone = tone;
}

function setBadge(element, text, tone = 'muted') {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.dataset.tone = tone;
}

function setBusy(isBusy) {
  form.querySelectorAll('button, textarea, input').forEach((node) => {
    node.disabled = isBusy;
  });
  clearButton.disabled = false;
}

function setBootstrapBusy(isBusy) {
  if (!bootstrapForm) {
    return;
  }

  bootstrapForm.querySelectorAll('button, textarea, input').forEach((node) => {
    node.disabled = isBusy;
  });
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

function updateTimeline(stage) {
  const order = ['queued', 'validating', 'opening_sooka_session', 'submitting_code', 'waiting_confirmation', 'pairing', 'paired', 'pairing_failed', 'timed_out', 'blocked', 'rejected'];
  const index = order.indexOf(stage);
  timeline.forEach((item, itemIndex) => {
    item.classList.toggle('active', itemIndex === index || (index === -1 && itemIndex === 0));
    item.classList.toggle('done', index > -1 && itemIndex < index && index < 6);
  });
}

function formatVerifiedIdentity(result) {
  const contact = result?.contact;
  if (!contact) {
    return '';
  }

  const parts = [contact.name, contact.email, contact.customerId].filter(Boolean);
  return parts.length ? ` (${parts.join(' / ')})` : '';
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

function sessionTone(session) {
  if (!session?.hasAccessToken) {
    return 'danger';
  }

  if (session.accessTokenExpired) {
    return 'danger';
  }

  if (session.refreshRecommended) {
    return 'warn';
  }

  return 'ok';
}

function sessionStateLabel(session) {
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

function jobTone(stage) {
  if (!stage) {
    return 'muted';
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

  return 'muted';
}

function renderQuickStats() {
  if (quickAuth) {
    quickAuth.textContent = uiState.authUser || 'Unavailable';
  }
  if (quickAuthMeta) {
    quickAuthMeta.textContent = uiState.authUser
      ? 'Portal access is backed by the browser session cookie.'
      : 'The portal session could not be loaded.';
  }

  const session = uiState.session;
  const hasSession = Boolean(session?.hasAccessToken);
  if (quickSession) {
    quickSession.textContent = hasSession
      ? `${sessionStateLabel(session)}${session?.source ? ` • ${session.source}` : ''}`
      : 'Missing';
  }
  if (quickSessionMeta) {
    quickSessionMeta.textContent = hasSession
      ? (uiState.contact?.email || 'Persisted bearer session is available for pairing requests.')
      : 'Paste a valid `/login` response to attach Sooka auth.';
  }

  const activeJobCount = uiState.currentJob && !uiState.currentJob.terminal ? 1 : 0;
  const openJobs = Math.max(activeJobCount, uiState.openJobs || 0);
  if (quickJobs) {
    quickJobs.textContent = `${openJobs} active`;
  }
  if (quickJobsMeta) {
    quickJobsMeta.textContent = uiState.currentJob
      ? `Latest stage: ${uiState.currentJob.stage.replaceAll('_', ' ')}`
      : 'No active pairing job.';
  }
}

function renderContact(contact) {
  if (!sessionIdentityName || !sessionIdentityMeta) {
    return;
  }

  if (!contact) {
    sessionIdentityName.textContent = 'Not verified yet';
    sessionIdentityMeta.textContent = 'Run Verify Session to confirm the token against Sooka.';
    return;
  }

  sessionIdentityName.textContent = contact.name || contact.email || 'Verified';
  sessionIdentityMeta.textContent = [
    contact.email,
    contact.customerId,
    contact.partnerName,
  ].filter(Boolean).join(' • ') || 'Verified against the contact endpoint.';
}

function renderSessionSummary(session, contact = uiState.contact) {
  uiState.session = session || null;
  uiState.contact = contact || null;

  const tone = sessionTone(session);
  const label = sessionStateLabel(session);
  const source = session?.source || 'none';
  const pillText = session?.hasAccessToken
    ? `Session: ${label.toLowerCase()} (${source})`
    : 'Session: missing';

  setPill(sessionPill, pillText, tone);
  setBadge(sessionSummaryState, label, tone);

  if (sessionSource) {
    sessionSource.textContent = source;
  }
  if (sessionCustomerId) {
    sessionCustomerId.textContent = session?.customerId || 'Not provided';
  }
  if (sessionCampaignId) {
    sessionCampaignId.textContent = session?.campaignId || 'Not provided';
  }
  if (sessionProfileId) {
    sessionProfileId.textContent = session?.defaultProfileId ?? 'Not provided';
  }
  if (sessionExpiry) {
    if (!session?.hasAccessToken) {
      sessionExpiry.textContent = 'Missing token';
    } else if (session?.accessTokenExpiresAt) {
      const suffix = session.accessTokenExpired
        ? 'expired'
        : `${formatDuration(session.accessTokenExpiresInMs)} left`;
      sessionExpiry.textContent = `${formatDateTime(session.accessTokenExpiresAt)} (${suffix})`;
    } else {
      sessionExpiry.textContent = 'Expiry not available';
    }
  }
  if (sessionUpdatedAt) {
    sessionUpdatedAt.textContent = formatDateTime(session?.updatedAt || session?.savedAt);
  }
  if (sessionHeaders) {
    sessionHeaders.textContent = session?.headerKeys?.length
      ? session.headerKeys.join(', ')
      : 'No custom headers';
  }
  if (sessionStoreFile) {
    sessionStoreFile.textContent = session?.storeFile || '-';
  }

  renderContact(contact);
  renderQuickStats();
}

function renderJob(job) {
  uiState.currentJob = job;
  uiState.openJobs = job.terminal ? 0 : Math.max(uiState.openJobs, 1);
  setPill(jobPill, job.terminal ? `Job ${job.result || job.stage}` : `Job ${job.id.slice(0, 8)}`, jobTone(job.stage));
  setBadge(consoleContext, job.stage.replaceAll('_', ' '), jobTone(job.stage));
  progressBar.style.width = `${job.progress || 0}%`;
  stageLabel.textContent = job.stage.replaceAll('_', ' ');
  progressLabel.textContent = `${job.progress || 0}%`;
  setLog([
    `Stage: ${job.stage}`,
    `Message: ${job.message}`,
    job.resultDetails ? `Details: ${job.resultDetails}` : null,
    job.code ? `Code: ${job.code}` : 'Code: not accepted',
    `Updated: ${new Date(job.updatedAt).toLocaleTimeString()}`,
  ].filter(Boolean).join('\n'));
  updateTimeline(job.stage);
  renderQuickStats();
}

async function apiJson(url, init = {}, fallbackMessage = 'Request failed') {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (response.status === 401 && payload?.error === 'Authentication required') {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }

  if (response.redirected && response.url.endsWith('/login')) {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }

  if (!response.ok && payload) {
    return payload;
  }

  if (!response.ok && !payload) {
    throw new Error(fallbackMessage);
  }

  return payload;
}

async function fetchMe() {
  const payload = await apiJson('/api/me', {}, 'Unable to fetch authentication status');
  if (payload?.error) {
    throw new Error(payload.details || payload.error);
  }
  return payload;
}

async function fetchJob(jobId) {
  const payload = await apiJson(`/api/jobs/${jobId}`, {}, 'Job not found');
  if (payload?.error) {
    throw new Error(payload.details || payload.error);
  }
  return payload;
}

async function fetchBootstrapStatus() {
  const payload = await apiJson('/api/bootstrap/status', {}, 'Unable to load bootstrap session status');
  if (payload?.error) {
    throw new Error(payload.details || payload.error);
  }
  return payload;
}

async function saveBootstrapSession(loginResponse, requestHeaders) {
  return apiJson('/api/bootstrap/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ loginResponse, requestHeaders }),
  }, 'Unable to save session');
}

async function verifyBootstrapSession() {
  return apiJson('/api/bootstrap/verify', {
    method: 'POST',
  }, 'Unable to verify session');
}

async function clearBootstrapSession() {
  return apiJson('/api/bootstrap/clear', {
    method: 'POST',
  }, 'Unable to clear session');
}

async function logout() {
  await apiJson('/api/auth/logout', {
    method: 'POST',
  }, 'Unable to log out');
  window.location.assign('/login');
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startPolling(jobId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const job = await fetchJob(jobId);
      renderJob(job);
      if (job.terminal) {
        stopPolling();
        setBusy(false);
        uiState.openJobs = 0;
        renderQuickStats();
      }
    } catch (error) {
      setLog(`Polling failed: ${error.message}`);
      stopPolling();
      setBusy(false);
      uiState.openJobs = 0;
      renderQuickStats();
    }
  }, 900);
}

async function detectQrCode(file) {
  if (!('BarcodeDetector' in window)) {
    return null;
  }

  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const results = await detector.detect(canvas);
    return results[0]?.rawValue || null;
  } catch {
    return null;
  }
}

async function handleFile(file) {
  if (!file) {
    return;
  }

  setPill(jobPill, 'Decoding QR image', 'muted');
  setBadge(consoleContext, 'decoding', 'muted');
  setLog(`Reading ${file.name}...`);

  const decoded = await detectQrCode(file);
  if (!decoded) {
    setLog('Could not decode a QR code from that image. Paste the 6-character code instead.');
    return;
  }

  codeInput.value = decoded;
  setLog(`Decoded input:\n${decoded}`);
}

async function submitPairing(rawInput) {
  const payload = await apiJson('/api/pair', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ rawInput }),
  }, 'Unable to start pairing');

  if (payload.error && !payload.code) {
    renderJob(payload);
    setBusy(false);
    return;
  }

  renderJob(payload);
  await startPolling(payload.id);
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const [file] = event.dataTransfer.files;
  await handleFile(file);
});
fileInput.addEventListener('change', async () => {
  const [file] = fileInput.files;
  await handleFile(file);
});

clearButton.addEventListener('click', () => {
  codeInput.value = '';
  fileInput.value = '';
  stopPolling();
  setBusy(false);
  uiState.currentJob = null;
  uiState.openJobs = 0;
  progressBar.style.width = '0%';
  stageLabel.textContent = 'Idle';
  progressLabel.textContent = '0%';
  setLog('Waiting for input.');
  setPill(jobPill, 'No active job', 'muted');
  setBadge(consoleContext, 'Idle', 'muted');
  updateTimeline('queued');
  renderQuickStats();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const rawInput = codeInput.value.trim();

  if (!sanitizeDisplayCode(rawInput)) {
    setLog('Enter a pairing code or drop a QR screenshot first.');
    return;
  }

  setBusy(true);
  setLog('Submitting pairing request...');

  try {
    await submitPairing(rawInput);
  } catch (error) {
    setBusy(false);
    setLog(`Pairing failed: ${error.message}`);
  }
});

if (bootstrapForm) {
  bootstrapForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const loginResponse = bootstrapLoginResponseInput.value.trim();
    const requestHeaders = bootstrapHeadersInput.value.trim();

    if (!loginResponse) {
      setLog('Paste the raw /login JSON response before saving the Sooka session.');
      return;
    }

    setBootstrapBusy(true);
    setLog('Saving Sooka session...');
    try {
      const result = await saveBootstrapSession(loginResponse, requestHeaders);
      if (result.error) {
        setLog(`Session save failed: ${result.details || result.error}`);
      } else {
        renderSessionSummary(result.session, result.contact || null);
        setLog(`Session saved. Health check ok${formatVerifiedIdentity(result)}. HTTP ${result.probeStatus}.`);
      }
    } catch (error) {
      setLog(`Session save failed: ${error.message}`);
    } finally {
      setBootstrapBusy(false);
    }
  });
}

if (bootstrapVerifyButton) {
  bootstrapVerifyButton.addEventListener('click', async () => {
    setBootstrapBusy(true);
    setLog('Verifying persisted Sooka session...');
    try {
      const result = await verifyBootstrapSession();
      renderSessionSummary(result.session, result.contact || null);
      if (result.ok) {
        setLog(`Session verification ok${formatVerifiedIdentity(result)}. HTTP ${result.probeStatus}.`);
      } else {
        setLog(`Session verification failed: ${result.details || 'Unknown error'}`);
      }
    } catch (error) {
      setLog(`Session verification failed: ${error.message}`);
    } finally {
      setBootstrapBusy(false);
    }
  });
}

if (bootstrapClearButton) {
  bootstrapClearButton.addEventListener('click', async () => {
    setBootstrapBusy(true);
    setLog('Clearing persisted Sooka session...');
    try {
      const result = await clearBootstrapSession();
      bootstrapLoginResponseInput.value = '';
      bootstrapHeadersInput.value = '';
      renderSessionSummary(result.session, null);
      setLog('Persisted Sooka session was cleared.');
    } catch (error) {
      setLog(`Clear session failed: ${error.message}`);
    } finally {
      setBootstrapBusy(false);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await logout();
    } catch (error) {
      logoutButton.disabled = false;
      setLog(`Logout failed: ${error.message}`);
    }
  });
}

async function boot() {
  try {
    const [me, bootstrap] = await Promise.all([fetchMe(), fetchBootstrapStatus()]);
    uiState.authUser = me.user;
    uiState.openJobs = me.openJobs || 0;
    setPill(authPill, `Portal: ${me.user}`, 'ok');
    renderSessionSummary(bootstrap.session || me.session, null);
    if (sessionGuidance && bootstrap.guidance) {
      sessionGuidance.textContent = bootstrap.guidance;
    }
    setLog('Ready. Drop a QR screenshot or paste the pairing code.');
    renderQuickStats();
  } catch (error) {
    uiState.authUser = null;
    uiState.openJobs = 0;
    setPill(authPill, 'Portal: unavailable', 'danger');
    renderSessionSummary(null, null);
    setLog(error.message);
  }
}

boot();
