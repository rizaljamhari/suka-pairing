import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.join(__dirname, 'client-dist');
const clientEntryFile = path.join(clientDistDir, 'index.html');

function getRequiredEnv(name) {
  const value = process.env[name];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw new Error(`Missing required environment variable: ${name}`);
}

const port = Number(process.env.PORT || 8787);
const authUser = getRequiredEnv('AUTH_USER');
const authPassword = getRequiredEnv('AUTH_PASSWORD');
const appSessionSecret = getRequiredEnv('APP_SESSION_SECRET');
const appSessionTtlDays = Number(process.env.APP_SESSION_TTL_DAYS || 30);
const sessionCookieName = process.env.APP_SESSION_COOKIE_NAME || 'sooka_portal_session';
const appLogFile = process.env.APP_LOG_FILE || path.join(__dirname, '.logs', 'portal.log');
const appLogLevel = process.env.APP_LOG_LEVEL || 'debug';
const sookaAppUrl = (process.env.SOOKA_APP_URL || 'https://sooka.my').replace(/\/$/, '');
const sookaApiBaseUrl = (process.env.SOOKA_API_BASE_URL || 'https://api.vr.ctrp.sooka.my').replace(/\/$/, '');
const sookaPairTvUrl = process.env.SOOKA_PAIR_TV_URL || `${sookaAppUrl}/pair-tv`;
const sookaContactEndpoint = process.env.SOOKA_CONTACT_ENDPOINT || '/login/v1/contact';
const sookaRefreshEndpoint = process.env.SOOKA_REFRESH_ENDPOINT || '/login/auth/v1/refresh-token';
const sookaValidateEndpoint = process.env.SOOKA_VALIDATE_ENDPOINT || '/login/v1/smart-tv/validate';
const sookaStatusEndpoint = process.env.SOOKA_STATUS_ENDPOINT || '/login/pub/v1/smart-tv/status';
const sookaAccessToken = process.env.SOOKA_ACCESS_TOKEN || '';
const sookaRefreshToken = process.env.SOOKA_REFRESH_TOKEN || '';
const sookaLoginResponseJson = process.env.SOOKA_LOGIN_RESPONSE_JSON || '';
const sookaRequestHeadersJson = process.env.SOOKA_REQUEST_HEADERS_JSON || '';
const sookaSessionStoreFile = process.env.SOOKA_SESSION_STORE_FILE || path.join(__dirname, '.data', 'sooka-session.json');
const jobsStoreFile = process.env.APP_JOBS_FILE || path.join(__dirname, '.data', 'jobs.jsonl');
const sookaTenantIdentifier = process.env.SOOKA_TENANT_IDENTIFIER || 'master';
const sookaLanguage = process.env.SOOKA_LANGUAGE || 'eng';
const statusPollIntervalMs = Number(process.env.SOOKA_STATUS_POLL_INTERVAL_MS || 1800);
const statusTimeoutMs = Number(process.env.SOOKA_STATUS_TIMEOUT_MS || 90000);
const successRegex = new RegExp(process.env.SOOKA_STATUS_SUCCESS_REGEX || 'paired|success|linked|activated', 'i');
const failureRegex = new RegExp(process.env.SOOKA_STATUS_FAILURE_REGEX || 'failed|invalid|expired|denied|forbidden|error', 'i');

const jobs = new Map();

function loadPersistedJobs() {
  if (!existsSync(jobsStoreFile)) {
    return;
  }

  try {
    const raw = readFileSync(jobsStoreFile, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const job = JSON.parse(line);
        if (job && typeof job.id === 'string') {
          jobs.set(job.id, job);
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } catch (error) {
    console.error('Failed to load persisted jobs', error);
  }
}

function persistJob(job) {
  try {
    mkdirSync(path.dirname(jobsStoreFile), { recursive: true });

    if (!existsSync(jobsStoreFile)) {
      // First write — just append.
      appendFileSync(jobsStoreFile, `${JSON.stringify(job)}\n`, 'utf8');
      return;
    }

    const raw = readFileSync(jobsStoreFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const existingIndex = lines.findIndex((line) => {
      try {
        return JSON.parse(line).id === job.id;
      } catch {
        return false;
      }
    });

    if (existingIndex === -1) {
      // New job — append.
      appendFileSync(jobsStoreFile, `${JSON.stringify(job)}\n`, 'utf8');
    } else {
      // Existing job — replace that line.
      lines[existingIndex] = JSON.stringify(job);
      writeFileSync(jobsStoreFile, `${lines.join('\n')}\n`, 'utf8');
    }
  } catch (error) {
    console.error('Failed to persist job', error);
  }
}
const logLevelRank = {
  debug: 10,
  info: 20,
  error: 30,
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function normalizeLogValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }

    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeLogValue(entryValue, seen)]),
    );
  }

  return String(value);
}

function shouldLog(level) {
  const currentRank = logLevelRank[appLogLevel] || logLevelRank.info;
  const targetRank = logLevelRank[level] || logLevelRank.info;
  return targetRank >= currentRank;
}

const LOG_MAX_BYTES = 15 * 1024 * 1024;  // 15 MB
const LOG_KEEP_BYTES = 10 * 1024 * 1024; // keep last 10 MB after truncation

function writeLog(level, event, details = {}) {
  if (!shouldLog(level)) {
    return;
  }

  try {
    mkdirSync(path.dirname(appLogFile), { recursive: true });
    const entry = {
      ts: now(),
      level,
      event,
      ...normalizeLogValue(details),
    };
    appendFileSync(appLogFile, `${JSON.stringify(entry)}\n`, 'utf8');

    // Roll the log if it has grown too large.
    const fd = openSync(appLogFile, 'r');
    const { size } = fstatSync(fd);
    closeSync(fd);
    if (size > LOG_MAX_BYTES) {
      const keepFd = openSync(appLogFile, 'r');
      const start = size - LOG_KEEP_BYTES;
      const buf = Buffer.allocUnsafe(LOG_KEEP_BYTES);
      readSync(keepFd, buf, 0, LOG_KEEP_BYTES, start);
      closeSync(keepFd);
      // Drop the first (likely partial) line so we keep only complete JSON lines.
      const tail = buf.toString('utf8').replace(/^[^\n]*\n/, '');
      writeFileSync(appLogFile, tail, 'utf8');
    }
  } catch (error) {
    console.error('Failed to write log entry', error);
  }
}

function logDebug(event, details = {}) {
  writeLog('debug', event, details);
}

function logInfo(event, details = {}) {
  writeLog('info', event, details);
}

function logError(event, details = {}) {
  writeLog('error', event, details);
}

function parseJsonObject(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeHeaderMap(input) {
  if (!isRecord(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => key && value !== undefined && value !== null && `${value}`.trim())
      .map(([key, value]) => [key, String(value)]),
  );
}

function extractLoginResponseFields(loginResponse) {
  const data = isRecord(loginResponse?.data) ? loginResponse.data : {};
  const userDetails = isRecord(data.userDetails) ? data.userDetails : {};

  return {
    accessToken: typeof data.accessToken === 'string' ? data.accessToken.trim() : '',
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken.trim() : '',
    customerId: typeof userDetails.customerId === 'string' ? userDetails.customerId : null,
    campaignId: typeof userDetails.campaignId === 'string' ? userDetails.campaignId : null,
    defaultProfileId: data.defaultProfileId ?? null,
  };
}

function normalizeSessionState(input = {}) {
  const loginResponse = isRecord(input.loginResponse) ? input.loginResponse : null;
  const derived = loginResponse ? extractLoginResponseFields(loginResponse) : {};
  const accessToken = typeof input.accessToken === 'string' && input.accessToken.trim()
    ? input.accessToken.trim()
    : (derived.accessToken || '');
  const refreshToken = typeof input.refreshToken === 'string' && input.refreshToken.trim()
    ? input.refreshToken.trim()
    : (derived.refreshToken || '');

  return {
    accessToken,
    refreshToken,
    customerId: input.customerId ?? derived.customerId ?? null,
    campaignId: input.campaignId ?? derived.campaignId ?? null,
    defaultProfileId: input.defaultProfileId ?? derived.defaultProfileId ?? null,
    loginResponse,
    requestHeaders: normalizeHeaderMap(input.requestHeaders),
    lastVerifiedContact: isRecord(input.lastVerifiedContact) ? input.lastVerifiedContact : null,
    lastVerifiedAt: typeof input.lastVerifiedAt === 'string' ? input.lastVerifiedAt : null,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : null,
    source: input.source || (accessToken || refreshToken || loginResponse ? 'env' : 'none'),
  };
}

function defaultSessionState() {
  return normalizeSessionState({
    accessToken: sookaAccessToken,
    refreshToken: sookaRefreshToken,
    loginResponse: parseJsonObject(sookaLoginResponseJson),
    requestHeaders: parseJsonObject(sookaRequestHeadersJson),
    source: sookaAccessToken || sookaRefreshToken || sookaLoginResponseJson ? 'env' : 'none',
  });
}

function loadPersistedSessionState() {
  const initial = defaultSessionState();
  if (!existsSync(sookaSessionStoreFile)) {
    return initial;
  }

  try {
    const raw = readFileSync(sookaSessionStoreFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return initial;
    }

    return normalizeSessionState({
      accessToken: typeof parsed.accessToken === 'string'
        ? parsed.accessToken
        : (typeof parsed.bearerToken === 'string' ? parsed.bearerToken : initial.accessToken),
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : initial.refreshToken,
      customerId: parsed.customerId ?? null,
      campaignId: parsed.campaignId ?? null,
      defaultProfileId: parsed.defaultProfileId ?? null,
      loginResponse: isRecord(parsed.loginResponse) ? parsed.loginResponse : null,
      requestHeaders: isRecord(parsed.requestHeaders) ? parsed.requestHeaders : {},
      lastVerifiedContact: isRecord(parsed.lastVerifiedContact) ? parsed.lastVerifiedContact : null,
      lastVerifiedAt: typeof parsed.lastVerifiedAt === 'string' ? parsed.lastVerifiedAt : null,
      source: 'persisted',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
    });
  } catch {
    return initial;
  }
}

let sessionState = loadPersistedSessionState();
let refreshInFlight = null;

function persistSessionState(nextState) {
  const dir = path.dirname(sookaSessionStoreFile);
  mkdirSync(dir, { recursive: true });
  const normalized = normalizeSessionState(nextState);
  const withMeta = {
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken,
    customerId: normalized.customerId,
    campaignId: normalized.campaignId,
    defaultProfileId: normalized.defaultProfileId,
    loginResponse: normalized.loginResponse,
    requestHeaders: normalized.requestHeaders,
    lastVerifiedContact: normalized.lastVerifiedContact,
    lastVerifiedAt: normalized.lastVerifiedAt,
    updatedAt: now(),
    savedAt: now(),
  };
  writeFileSync(sookaSessionStoreFile, JSON.stringify(withMeta, null, 2), 'utf8');
  sessionState = {
    ...withMeta,
    source: 'persisted',
  };
  return sessionState;
}

function clearPersistedSessionState() {
  if (existsSync(sookaSessionStoreFile)) {
    try {
      unlinkSync(sookaSessionStoreFile);
    } catch {
      // Ignore cleanup errors; state still falls back to env/default.
    }
  }
  sessionState = defaultSessionState();
  return sessionState;
}

function sessionSummary() {
  const accessTokenExpiresAtMs = getAccessTokenExpiryMs(sessionState.accessToken);
  const accessTokenExpiresInMs = accessTokenExpiresAtMs
    ? accessTokenExpiresAtMs - Date.now()
    : null;

  const maskToken = (token) => {
    if (typeof token !== 'string' || !token) {
      return null;
    }

    if (token.length <= 12) {
      return `${token.slice(0, 4)}...${token.slice(-4)}`;
    }

    return `${token.slice(0, 8)}...${token.slice(-6)}`;
  };

  return {
    source: sessionState.source,
    hasAccessToken: Boolean(sessionState.accessToken),
    hasRefreshToken: Boolean(sessionState.refreshToken),
    hasLoginResponse: Boolean(sessionState.loginResponse),
    headerKeys: Object.keys(sessionState.requestHeaders || {}),
    customerId: sessionState.customerId,
    campaignId: sessionState.campaignId,
    defaultProfileId: sessionState.defaultProfileId,
    accessTokenPreview: maskToken(sessionState.accessToken),
    refreshTokenPreview: maskToken(sessionState.refreshToken),
    updatedAt: sessionState.updatedAt,
    savedAt: sessionState.savedAt,
    lastVerifiedContact: sessionState.lastVerifiedContact || null,
    lastVerifiedAt: sessionState.lastVerifiedAt || null,
    accessTokenExpiresAt: accessTokenExpiresAtMs ? new Date(accessTokenExpiresAtMs).toISOString() : null,
    accessTokenExpiresInMs,
    accessTokenExpired: Number.isFinite(accessTokenExpiresInMs) ? accessTokenExpiresInMs <= 0 : false,
    refreshRecommended: shouldRefreshAccessToken(sessionState),
    storeFile: sookaSessionStoreFile,
    appUrl: sookaAppUrl,
    apiBaseUrl: sookaApiBaseUrl,
    pairTvUrl: sookaPairTvUrl,
    contactEndpoint: sookaContactEndpoint,
    refreshEndpoint: sookaRefreshEndpoint,
    configuredHeaderKeys: Object.keys(normalizeHeaderMap(parseJsonObject(sookaRequestHeadersJson))),
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length < 2) {
    return null;
  }

  try {
    const [, payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function getAccessTokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return null;
  }

  return payload.exp * 1000;
}

function shouldRefreshAccessToken(candidate = sessionState, bufferMs = 10 * 60 * 1000) {
  const expiryMs = getAccessTokenExpiryMs(candidate?.accessToken);
  if (!expiryMs) {
    return false;
  }

  return (expiryMs - Date.now()) <= bufferMs;
}

async function refreshSessionTokens(force = false) {
  if (refreshInFlight) {
    logDebug('session.refresh.wait_existing', { force });
    return refreshInFlight;
  }

  if (!force && !shouldRefreshAccessToken(sessionState)) {
    return {
      refreshed: false,
      session: sessionState,
      reason: 'not_needed',
    };
  }

  if (!sessionState.refreshToken) {
    throw new Error('Cannot refresh session without a refresh token.');
  }

  const activeSession = normalizeSessionState(sessionState);
  refreshInFlight = (async () => {
    logInfo('session.refresh.start', {
      force,
      currentExpiry: getAccessTokenExpiryMs(activeSession.accessToken),
      hasRefreshToken: Boolean(activeSession.refreshToken),
    });

    const response = await sookaRequest(
      sookaRefreshEndpoint,
      'POST',
      { refreshToken: activeSession.refreshToken },
      null,
      activeSession,
      { skipPreflightRefresh: true, isRefreshCall: true, retryOnAuthFailure: false },
    );

    if (!response.ok || response.json?.status !== true) {
      logError('session.refresh.failed', {
        status: response.status,
        responseBody: response.json || response.text,
      });
      throw new Error(response.json?.message || `Refresh failed (HTTP ${response.status}).`);
    }

    const data = isRecord(response.json?.data) ? response.json.data : {};
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken.trim() : '';
    if (!accessToken || !refreshToken) {
      logError('session.refresh.invalid_payload', {
        responseBody: response.json || response.text,
      });
      throw new Error('Refresh succeeded but did not return both accessToken and refreshToken.');
    }

    const nextState = persistSessionState({
      ...activeSession,
      accessToken,
      refreshToken,
      customerId: activeSession.customerId,
      campaignId: activeSession.campaignId,
      defaultProfileId: activeSession.defaultProfileId,
      loginResponse: response.json,
      updatedAt: now(),
      savedAt: now(),
    });

    logInfo('session.refresh.ok', {
      previousExpiry: getAccessTokenExpiryMs(activeSession.accessToken),
      nextExpiry: getAccessTokenExpiryMs(nextState.accessToken),
      accessTokenChanged: accessToken !== activeSession.accessToken,
      refreshTokenChanged: refreshToken !== activeSession.refreshToken,
    });

    return {
      refreshed: true,
      session: nextState,
      response,
    };
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function parseRequestHeaderOverrides(input) {
  if (isRecord(input)) {
    return {
      ok: true,
      value: normalizeHeaderMap(input),
    };
  }

  if (typeof input === 'string') {
    const parsed = parseJsonObject(input);
    if (parsed) {
      return {
        ok: true,
        value: normalizeHeaderMap(parsed),
      };
    }

    if (!input.trim()) {
      return {
        ok: true,
        value: {},
      };
    }

    return {
      ok: false,
      error: 'Invalid requestHeaders JSON. Provide a JSON object.',
    };
  }

  if (input === undefined || input === null) {
    return {
      ok: true,
      value: {},
    };
  }

  return {
    ok: false,
    error: 'requestHeaders must be a JSON object or JSON string.',
  };
}

function parseLoginResponseInput(input) {
  if (isRecord(input)) {
    return {
      ok: true,
      value: input,
    };
  }

  if (typeof input === 'string') {
    const parsed = parseJsonObject(input);
    if (parsed) {
      return {
        ok: true,
        value: parsed,
      };
    }

    return {
      ok: false,
      error: 'Invalid loginResponse JSON. Paste the raw /login response object.',
    };
  }

  return {
    ok: false,
    error: 'loginResponse must be a JSON object or JSON string.',
  };
}

function buildSessionCandidate(body) {
  const loginResponseInput = body.loginResponse ?? body.session ?? null;
  const loginResponseResult = parseLoginResponseInput(loginResponseInput);
  if (!loginResponseResult.ok) {
    return loginResponseResult;
  }

  const requestHeadersResult = parseRequestHeaderOverrides(body.requestHeaders ?? body.headers);
  if (!requestHeadersResult.ok) {
    return requestHeadersResult;
  }

  const candidate = normalizeSessionState({
    loginResponse: loginResponseResult.value,
    accessToken: typeof body.accessToken === 'string' ? body.accessToken.trim() : '',
    refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '',
    requestHeaders: requestHeadersResult.value,
  });

  if (!candidate.accessToken) {
    return {
      ok: false,
      error: 'Missing access token in loginResponse.data.accessToken.',
    };
  }

  return {
    ok: true,
    value: candidate,
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonWithHeaders(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendRedirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    Location: location,
    'Content-Length': '0',
  });
  res.end();
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  if (!raw) {
    return {};
  }

  return Object.fromEntries(
    raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) {
          return [part, ''];
        }

        return [
          decodeURIComponent(part.slice(0, separatorIndex).trim()),
          decodeURIComponent(part.slice(separatorIndex + 1).trim()),
        ];
      }),
  );
}

function signSessionPayload(payload) {
  return createHmac('sha256', appSessionSecret).update(payload).digest('base64url');
}

function createSessionToken(username) {
  const ttlDays = Number.isFinite(appSessionTtlDays) && appSessionTtlDays > 0 ? appSessionTtlDays : 30;
  const payload = {
    u: username,
    exp: Date.now() + (ttlDays * 24 * 60 * 60 * 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signSessionPayload(encoded);
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex === -1) {
    return null;
  }

  const encoded = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  const expectedSignature = signSessionPayload(encoded);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || payload.u !== authUser || typeof payload.exp !== 'number') {
      return null;
    }

    if (payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function sessionCookieValue(token, maxAgeSeconds) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  return parts.join('; ');
}

function clearSessionCookieValue() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getAuthenticatedUser(req) {
  const token = parseCookies(req)[sessionCookieName];
  const payload = verifySessionToken(token);
  return payload?.u || null;
}

function isPublicAssetPath(pathname) {
  return isStaticAssetPath(pathname);
}

function isStaticAssetPath(pathname) {
  return pathname.startsWith('/public/')
    || /\.(css|js|map|png|jpg|jpeg|gif|svg|ico|webp|avif)$/i.test(pathname);
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function hasClientBuild() {
  return existsSync(clientEntryFile);
}

function sendMissingClientBuild(res) {
  sendText(res, 503, 'Frontend build not found. Run npm start or npm run build before opening the portal.');
}

function serializeJob(job) {
  return {
    ...job,
    terminal: Boolean(job.terminal),
  };
}

function listJobs() {
  return [...jobs.values()]
    .map(serializeJob)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function readRecentLogs(minutes = 60) {
  if (!existsSync(appLogFile)) {
    return [];
  }

  const windowMs = Math.max(1, Math.min(minutes, 60 * 24)) * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  // Read only the tail of the file to avoid OOM on very large log files.
  const MAX_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB
  let raw;
  try {
    const fd = openSync(appLogFile, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, start);
    closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && typeof entry.ts === 'string')
    .filter((entry) => {
      const timestamp = new Date(entry.ts).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .sort((left, right) => new Date(right.ts).getTime() - new Date(left.ts).getTime());
}

function sanitizeCodeInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    return null;
  }

  const trimmed = rawInput.trim();

  try {
    const parsedUrl = new URL(trimmed);
    const candidate = parsedUrl.searchParams.get('code') || parsedUrl.searchParams.get('pair') || parsedUrl.searchParams.get('token');
    if (candidate) {
      const cleanedCandidate = candidate.trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(cleanedCandidate)) {
        return cleanedCandidate;
      }
    }
  } catch {
    // Not a URL. Fall through.
  }

  const cleaned = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z0-9]{6}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

function createJob(rawInput) {
  const code = sanitizeCodeInput(rawInput);
  const id = randomUUID();

  const job = {
    id,
    createdAt: now(),
    updatedAt: now(),
    rawInput,
    code,
    stage: code ? 'queued' : 'rejected',
    progress: code ? 5 : 0,
    message: code
      ? 'Queued for pairing.'
      : 'Invalid pairing code. Enter the 6-character TV code or a Sooka pair-tv URL containing code=... ',
    terminal: !code,
    result: null,
  };

  jobs.set(id, job);
  persistJob(job);
  logInfo('pairing.job.created', {
    jobId: id,
    rawInput,
    normalizedCode: code,
    accepted: Boolean(code),
  });
  return job;
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: now(),
  };

  jobs.set(jobId, next);
  persistJob(next);
  return next;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSookaHeaders(override = null) {
  const active = normalizeSessionState(override || sessionState);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: sookaAppUrl,
    Referer: sookaPairTvUrl,
    tenant_identifier: sookaTenantIdentifier,
    language: sookaLanguage,
    ...normalizeHeaderMap(parseJsonObject(sookaRequestHeadersJson)),
    ...active.requestHeaders,
  };

  if (active.accessToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${active.accessToken}`;
  }

  return headers;
}

function parseJsonSafe(rawText) {
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function compactPreview(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) {
    return '';
  }
  return raw.length > 280 ? `${raw.slice(0, 277)}...` : raw;
}

function headersToObject(headers) {
  if (!headers) {
    return {};
  }

  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  if (isRecord(headers)) {
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
  }

  return {};
}

async function sookaRequest(pathname, method, payload = null, query = null, authOverride = null, options = {}) {
  const {
    skipPreflightRefresh = false,
    isRefreshCall = false,
    retryOnAuthFailure = true,
  } = options;
  let activeAuth = normalizeSessionState(authOverride || sessionState);
  if (!skipPreflightRefresh && !authOverride && !isRefreshCall) {
    try {
      const refreshResult = await refreshSessionTokens(false);
      activeAuth = normalizeSessionState(refreshResult.session || sessionState);
    } catch (error) {
      logError('session.refresh.preflight_failed', {
        pathname,
        method,
        error,
      });
      throw error;
    }
  }

  const url = new URL(`${sookaApiBaseUrl}${pathname}`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const requestId = randomUUID();
  const headers = buildSookaHeaders(activeAuth);
  const requestBody = payload ? JSON.stringify(payload) : null;
  logDebug('sooka.request', {
    requestId,
    method,
    url: url.toString(),
    headers,
    body: requestBody,
  });

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: requestBody || undefined,
    });
  } catch (error) {
    logError('sooka.request.error', {
      requestId,
      method,
      url: url.toString(),
      headers,
      body: requestBody,
      error,
    });
    throw error;
  }

  const text = await response.text();
  const json = parseJsonSafe(text);
  logDebug('sooka.response', {
    requestId,
    method,
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    headers: headersToObject(response.headers),
    body: text,
  });

  if (
    retryOnAuthFailure
    && !authOverride
    && !isRefreshCall
    && (response.status === 401 || response.status === 403)
  ) {
    logInfo('session.refresh.retry_on_auth_failure', {
      pathname,
      method,
      status: response.status,
    });

    const refreshResult = await refreshSessionTokens(true);
    return sookaRequest(pathname, method, payload, query, refreshResult.session, {
      skipPreflightRefresh: true,
      isRefreshCall: false,
      retryOnAuthFailure: false,
    });
  }

  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    text,
    json,
  };
}

async function verifySessionCandidate(candidate) {
  logInfo('session.verify.start', {
    hasAccessToken: Boolean(candidate?.accessToken),
    hasRefreshToken: Boolean(candidate?.refreshToken),
    headerKeys: Object.keys(candidate?.requestHeaders || {}),
  });
  const probe = await sookaRequest(sookaContactEndpoint, 'GET', null, null, candidate);

  if (probe.status === 401 || probe.status === 403) {
    logError('session.verify.rejected', {
      status: probe.status,
      responseHeaders: probe.contentType,
      body: probe.text,
    });
    return {
      ok: false,
      message: `Sooka rejected the session (HTTP ${probe.status}).`,
      probe,
    };
  }

  const looksLikeHtml = (probe.contentType || '').includes('text/html') || /<!doctype html/i.test(probe.text || '');
  if (looksLikeHtml) {
    logError('session.verify.html_response', {
      status: probe.status,
      contentType: probe.contentType,
      body: probe.text,
    });
    return {
      ok: false,
      message: 'Sooka returned an HTML login/app page instead of API status JSON. Session is likely not authenticated.',
      probe,
    };
  }

  if (!probe.ok) {
    logError('session.verify.http_error', {
      status: probe.status,
      contentType: probe.contentType,
      body: probe.text,
    });
    return {
      ok: false,
      message: `Sooka contact health check failed (HTTP ${probe.status}).`,
      probe,
    };
  }

  if (probe.json?.status !== true) {
    logError('session.verify.non_success_payload', {
      status: probe.status,
      payload: probe.json,
      rawBody: probe.text,
    });
    return {
      ok: false,
      message: 'Sooka contact health check returned a non-success payload.',
      probe,
    };
  }

  const contact = isRecord(probe.json?.data) ? probe.json.data : null;
  const identity = [contact?.name, contact?.email, contact?.customerId].filter(Boolean).join(' / ');
  logInfo('session.verify.ok', {
    status: probe.status,
    contact,
  });
  return {
    ok: true,
    message: identity
      ? `Session verified via contact endpoint for ${identity}.`
      : `Session verified via contact endpoint (HTTP ${probe.status}).`,
    probe,
    contact,
  };
}

function flattenValues(input, output = []) {
  if (input === null || input === undefined) {
    return output;
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    output.push(String(input));
    return output;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => flattenValues(item, output));
    return output;
  }

  if (typeof input === 'object') {
    Object.entries(input).forEach(([key, value]) => {
      output.push(String(key));
      flattenValues(value, output);
    });
  }

  return output;
}

function detectTerminalState(statusPayload) {
  if (!statusPayload) {
    return { terminal: false, state: 'pending', reason: 'No status payload yet.' };
  }

  const haystack = flattenValues(statusPayload).join(' | ');

  if (failureRegex.test(haystack)) {
    return { terminal: true, state: 'failed', reason: 'Sooka status indicates failure.' };
  }

  if (successRegex.test(haystack)) {
    return { terminal: true, state: 'paired', reason: 'Sooka status indicates successful pairing.' };
  }

  return { terminal: false, state: 'pending', reason: 'Still waiting for a terminal Sooka status.' };
}

function detectImmediateValidateSuccess(validatePayload) {
  if (!validatePayload) {
    return false;
  }

  const haystack = flattenValues(validatePayload).join(' | ');
  return /paired|linked|activated/i.test(haystack);
}

async function validateSookaCode(code, jobId = null) {
  const payload = { code };
  const response = await sookaRequest(sookaValidateEndpoint, 'POST', payload);
  if (response.ok) {
    logInfo('pairing.validate.ok', {
      jobId,
      code,
      requestPayload: payload,
      status: response.status,
      responseBody: response.json || response.text,
    });
    return {
      ok: true,
      requestPayload: payload,
      response,
    };
  }

  logError('pairing.validate.failed', {
    jobId,
    code,
    status: response?.status,
    responseBody: response?.json || response?.text,
  });
  return {
    ok: false,
    requestPayload: payload,
    response,
  };
}

async function querySookaStatus(code, jobId = null) {
  const attempts = [
    () => sookaRequest(sookaStatusEndpoint, 'GET', null, { code }),
    () => sookaRequest(sookaStatusEndpoint, 'GET', null, { pairingCode: code }),
    () => sookaRequest(sookaStatusEndpoint, 'GET', null, { smartTvCode: code }),
  ];

  let last = null;
  for (const attempt of attempts) {
    const result = await attempt();
    last = result;
    if (result.ok) {
      logDebug('pairing.status.ok', {
        jobId,
        code,
        status: result.status,
        responseBody: result.json || result.text,
      });
      return result;
    }
  }

  logDebug('pairing.status.not_ready', {
    jobId,
    code,
    status: last?.status,
    responseBody: last?.json || last?.text,
  });
  return last;
}

async function runPairing(jobId) {
  const code = jobs.get(jobId)?.code;
  if (!code) {
    logError('pairing.job.rejected', {
      jobId,
      reason: 'invalid_code',
    });
    updateJob(jobId, {
      stage: 'rejected',
      progress: 0,
      terminal: true,
      message: 'The provided input did not contain a valid 6-character pairing code.',
      result: 'invalid_code',
    });
    return;
  }

  logInfo('pairing.job.start', {
    jobId,
    code,
  });
  updateJob(jobId, {
    stage: 'validating',
    progress: 20,
    message: `Accepted code ${code}. Preparing the pairing session.`,
  });
  await wait(700);

  updateJob(jobId, {
    stage: 'opening_sooka_session',
    progress: 40,
    message: 'Opening the authenticated Sooka session and navigating to pair-tv.',
  });
  await wait(900);

  updateJob(jobId, {
    stage: 'submitting_code',
    progress: 45,
    message: `Submitting code ${code} to Sooka validate endpoint.`,
  });

  try {
    const validation = await validateSookaCode(code, jobId);
    if (!validation.ok) {
      logError('pairing.job.validate_failed', {
        jobId,
        code,
        status: validation.response?.status,
        responseBody: validation.response?.json || validation.response?.text,
      });
      updateJob(jobId, {
        stage: 'pairing_failed',
        progress: 100,
        terminal: true,
        message: `Sooka validation request failed (HTTP ${validation.response?.status || 'n/a'}).`,
        result: 'validate_failed',
        resultDetails: compactPreview(validation.response?.json || validation.response?.text),
      });
      return;
    }

    const validationPayload = validation.response?.json || validation.response?.text || null;
    if (detectImmediateValidateSuccess(validationPayload)) {
      logInfo('pairing.job.paired_immediately', {
        jobId,
        code,
        validationPayload,
      });
      updateJob(jobId, {
        stage: 'paired',
        progress: 100,
        terminal: true,
        message: 'TV pairing completed successfully from Sooka validate response.',
        result: 'paired',
        resultDetails: compactPreview(validationPayload),
      });
      return;
    }

    updateJob(jobId, {
      stage: 'waiting_confirmation',
      progress: 60,
      message: 'Code submitted. Waiting for Sooka status confirmation.',
      resultDetails: compactPreview(validationPayload),
    });

    const deadline = Date.now() + statusTimeoutMs;
    while (Date.now() < deadline) {
      const statusResponse = await querySookaStatus(code, jobId);
      const statusPayload = statusResponse?.json || statusResponse?.text || null;

      if (!statusResponse?.ok) {
        logDebug('pairing.job.status_retry', {
          jobId,
          code,
          status: statusResponse?.status,
          responseBody: statusPayload,
        });
        updateJob(jobId, {
          stage: 'waiting_confirmation',
          progress: 70,
          message: `Status check not ready yet (HTTP ${statusResponse?.status || 'n/a'}). Retrying...`,
          resultDetails: compactPreview(statusPayload),
        });
        await wait(statusPollIntervalMs);
        continue;
      }

      const state = detectTerminalState(statusPayload);
      if (state.terminal && state.state === 'paired') {
        logInfo('pairing.job.paired', {
          jobId,
          code,
          statusPayload,
        });
        updateJob(jobId, {
          stage: 'paired',
          progress: 100,
          terminal: true,
          message: 'TV pairing completed successfully and confirmed by Sooka status.',
          result: 'paired',
          resultDetails: compactPreview(statusPayload),
        });
        return;
      }

      if (state.terminal && state.state === 'failed') {
        logError('pairing.job.failed_terminal_state', {
          jobId,
          code,
          statusPayload,
        });
        updateJob(jobId, {
          stage: 'pairing_failed',
          progress: 100,
          terminal: true,
          message: 'Sooka status returned a failure terminal state.',
          result: 'pairing_failed',
          resultDetails: compactPreview(statusPayload),
        });
        return;
      }

      updateJob(jobId, {
        stage: 'waiting_confirmation',
        progress: 75,
        message: 'Sooka has not reached a terminal pairing state yet. Polling again...',
        resultDetails: compactPreview(statusPayload),
      });
      await wait(statusPollIntervalMs);
    }

    updateJob(jobId, {
      stage: 'timed_out',
      progress: 100,
      terminal: true,
      message: 'Timed out waiting for Sooka to confirm pairing completion.',
      result: 'status_timeout',
    });
    logError('pairing.job.timed_out', {
      jobId,
      code,
      timeoutMs: statusTimeoutMs,
    });
  } catch (error) {
    logError('pairing.job.integration_error', {
      jobId,
      code,
      error,
    });
    updateJob(jobId, {
      stage: 'pairing_failed',
      progress: 100,
      terminal: true,
      message: 'Unexpected error while executing Sooka pairing flow.',
      result: 'integration_error',
      resultDetails: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseRequestBody(req, requestId = null) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        logError('portal.request.body_too_large', {
          requestId,
          method: req.method,
          url: req.url,
          bytes: body.length,
        });
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        logDebug('portal.request.body', {
          requestId,
          method: req.method,
          url: req.url,
          rawBody: '',
        });
        resolve({});
        return;
      }

      try {
        logDebug('portal.request.body', {
          requestId,
          method: req.method,
          url: req.url,
          rawBody: body,
        });
        resolve(JSON.parse(body));
      } catch (error) {
        logError('portal.request.body_invalid_json', {
          requestId,
          method: req.method,
          url: req.url,
          rawBody: body,
          error,
        });
        reject(error);
      }
    });
    req.on('error', (error) => {
      logError('portal.request.stream_error', {
        requestId,
        method: req.method,
        url: req.url,
        error,
      });
      reject(error);
    });
  });
}

async function serveStatic(res, pathname, rootDir = clientDistDir) {
  const resolvedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(rootDir, resolvedPath));

  const safeRootDir = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (!filePath.startsWith(safeRootDir) && filePath !== rootDir) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Content-Length': content.length,
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

async function serveFrontendEntry(res) {
  if (!hasClientBuild()) {
    sendMissingClientBuild(res);
    return true;
  }

  return serveStatic(res, '/index.html', clientDistDir);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = requestUrl;
  const query = Object.fromEntries(requestUrl.searchParams.entries());
  const authenticatedUser = getAuthenticatedUser(req);
  const shouldLogPortalRequest = !isStaticAssetPath(pathname);
  let responseHeaders = {};
  let responseBody = '';
  const shouldLogResponseBody = pathname.startsWith('/api/');
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);

  res.writeHead = function patchedWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    const headers = isRecord(statusMessageOrHeaders)
      ? statusMessageOrHeaders
      : (isRecord(maybeHeaders) ? maybeHeaders : {});
    responseHeaders = {
      ...responseHeaders,
      ...headersToObject(headers),
    };
    return originalWriteHead(statusCode, statusMessageOrHeaders, maybeHeaders);
  };

  res.end = function patchedEnd(chunk, encoding, callback) {
    if (shouldLogResponseBody && chunk) {
      responseBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    return originalEnd(chunk, encoding, callback);
  };

  if (shouldLogPortalRequest) {
    logDebug('portal.request.start', {
      requestId,
      method: req.method,
      path: pathname,
      query,
      headers: headersToObject(req.headers),
      remoteAddress: req.socket.remoteAddress,
      authenticatedUser,
    });
  }

  res.on('finish', () => {
    if (shouldLogPortalRequest) {
      logDebug('portal.request.finish', {
        requestId,
        method: req.method,
        path: pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        responseHeaders,
        responseBody: shouldLogResponseBody ? responseBody : undefined,
        authenticatedUser: getAuthenticatedUser(req),
      });
    }
  });

  if (req.method === 'GET' && pathname === '/robots.txt') {
    sendText(res, 200, 'User-agent: *\nDisallow: /\n');
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    try {
      const body = await parseRequestBody(req, requestId);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (username !== authUser || password !== authPassword) {
        logError('auth.login.invalid_credentials', {
          requestId,
          username,
        });
        sendJson(res, 401, {
          error: 'Invalid credentials',
          details: 'Use the portal username and password configured on the server.',
        });
        return;
      }

      const token = createSessionToken(username);
      const ttlDays = Number.isFinite(appSessionTtlDays) && appSessionTtlDays > 0 ? appSessionTtlDays : 30;
      sendJsonWithHeaders(res, 200, {
        ok: true,
        user: username,
      }, {
        'Set-Cookie': sessionCookieValue(token, ttlDays * 24 * 60 * 60),
      });
      logInfo('auth.login.ok', {
        requestId,
        username,
      });
      return;
    } catch (error) {
      logError('auth.login.invalid_body', {
        requestId,
        error,
      });
      sendJson(res, 400, {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    logInfo('auth.logout', {
      requestId,
      authenticatedUser,
    });
    sendJsonWithHeaders(res, 200, { ok: true }, {
      'Set-Cookie': clearSessionCookieValue(),
    });
    return;
  }

  if (!authenticatedUser) {
    if (req.method === 'GET' && (pathname === '/login' || pathname === '/login.html')) {
      await serveFrontendEntry(res);
      return;
    }

    if (req.method === 'GET' && isPublicAssetPath(pathname)) {
      const served = await serveStatic(res, pathname);
      if (served) {
        return;
      }
    }

    if (pathname.startsWith('/api/')) {
      logDebug('auth.required', {
        requestId,
        method: req.method,
        path: pathname,
      });
      sendJson(res, 401, {
        error: 'Authentication required',
        details: 'Log in to the portal before using the API.',
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      sendRedirect(res, '/login');
      return;
    }

    sendRedirect(res, '/login');
    return;
  }

  if (req.method === 'GET' && (pathname === '/login' || pathname === '/login.html')) {
    sendRedirect(res, '/');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    sendJson(res, 200, {
      user: authenticatedUser,
      openJobs: [...jobs.values()].filter((job) => !job.terminal).length,
      session: sessionSummary(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap/status') {
    sendJson(res, 200, {
      session: sessionSummary(),
      guidance: 'Paste the raw /login JSON response and optional request headers JSON from an authenticated Sooka API request.',
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/bootstrap/session') {
    try {
      const body = await parseRequestBody(req, requestId);
      const candidateResult = buildSessionCandidate(body);
      if (!candidateResult.ok) {
        logError('session.bootstrap.invalid_payload', {
          requestId,
          error: candidateResult.error,
          body,
        });
        sendJson(res, 400, {
          error: 'Invalid session payload',
          details: candidateResult.error,
        });
        return;
      }

      const verification = await verifySessionCandidate(candidateResult.value);
      if (!verification.ok) {
        logError('session.bootstrap.verify_failed', {
          requestId,
          details: verification.message,
          probeStatus: verification.probe.status,
          probeBody: verification.probe.json || verification.probe.text,
        });
        sendJson(res, 401, {
          error: 'Session bootstrap failed',
          details: verification.message,
          probeStatus: verification.probe.status,
          probePreview: compactPreview(verification.probe.json || verification.probe.text),
        });
        return;
      }

      const next = persistSessionState({
        ...candidateResult.value,
        lastVerifiedContact: verification.contact || null,
        lastVerifiedAt: verification.contact ? now() : null,
      });
      logInfo('session.bootstrap.persisted', {
        requestId,
        source: next.source,
        customerId: next.customerId,
        campaignId: next.campaignId,
      });
      sendJson(res, 200, {
        message: 'Sooka login session saved to persistent store.',
        session: sessionSummary(),
        probeStatus: verification.probe.status,
        probePreview: compactPreview(verification.probe.json || verification.probe.text),
        contact: verification.contact || null,
        source: next.source,
      });
      return;
    } catch (error) {
      logError('session.bootstrap.invalid_body', {
        requestId,
        error,
      });
      sendJson(res, 400, {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/bootstrap/verify') {
    try {
      const verification = await verifySessionCandidate(sessionState);
      if (!verification.ok) {
        logError('session.verify.failed', {
          requestId,
          details: verification.message,
          probeStatus: verification.probe.status,
          probeBody: verification.probe.json || verification.probe.text,
        });
        sendJson(res, 401, {
          ok: false,
          details: verification.message,
          session: sessionSummary(),
          probeStatus: verification.probe.status,
          probePreview: compactPreview(verification.probe.json || verification.probe.text),
        });
        return;
      }

      if (verification.contact) {
        persistSessionState({
          ...sessionState,
          lastVerifiedContact: verification.contact,
          lastVerifiedAt: now(),
        });
      }

      logInfo('session.verify.api_ok', {
        requestId,
        contact: verification.contact,
      });
      sendJson(res, 200, {
        ok: true,
        details: verification.message,
        session: sessionSummary(),
        probeStatus: verification.probe.status,
        probePreview: compactPreview(verification.probe.json || verification.probe.text),
        contact: verification.contact || null,
      });
      return;
    } catch (error) {
      logError('session.verify.api_error', {
        requestId,
        error,
      });
      sendJson(res, 500, {
        ok: false,
        error: 'Verification failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/session/refresh') {
    try {
      const result = await refreshSessionTokens(true);
      sendJson(res, 200, {
        ok: true,
        refreshed: result.refreshed,
        session: sessionSummary(),
      });
      return;
    } catch (error) {
      logError('session.refresh.api_error', {
        requestId,
        error,
      });
      sendJson(res, 400, {
        ok: false,
        error: 'Session refresh failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/bootstrap/clear') {
    const next = clearPersistedSessionState();
    logInfo('session.clear', {
      requestId,
      source: next.source,
    });
    sendJson(res, 200, {
      message: 'Persisted session cleared.',
      session: {
        ...sessionSummary(),
        source: next.source,
      },
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
    const jobId = pathname.split('/').pop();
    const job = jobId ? jobs.get(jobId) : null;
    if (!job) {
      logError('pairing.job.not_found', {
        requestId,
        jobId,
      });
      sendJson(res, 404, { error: 'Job not found' });
      return;
    }

    sendJson(res, 200, job);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    const items = listJobs();
    sendJson(res, 200, {
      items,
      summary: {
        total: items.length,
        active: items.filter((job) => !job.terminal).length,
        paired: items.filter((job) => job.stage === 'paired').length,
        failed: items.filter((job) => ['pairing_failed', 'timed_out', 'blocked', 'rejected'].includes(job.stage)).length,
      },
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const minutes = Number(query.minutes || 60);
    const level = typeof query.level === 'string' ? query.level.toLowerCase() : '';
    const eventFilter = typeof query.event === 'string' ? query.event.toLowerCase() : '';
    const items = readRecentLogs(minutes).filter((entry) => {
      if (level && entry.level !== level) {
        return false;
      }

      if (eventFilter && !String(entry.event || '').toLowerCase().includes(eventFilter)) {
        return false;
      }

      return true;
    });

    sendJson(res, 200, {
      items,
      rangeMinutes: Math.max(1, Math.min(minutes, 60 * 24)),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/pair') {
    try {
      const body = await parseRequestBody(req, requestId);
      const rawInput = typeof body.rawInput === 'string' ? body.rawInput : '';
      const job = createJob(rawInput);

      if (!job.code) {
        logError('pairing.request.invalid_code', {
          requestId,
          rawInput,
          jobId: job.id,
        });
        sendJson(res, 400, job);
        return;
      }

      logInfo('pairing.request.accepted', {
        requestId,
        jobId: job.id,
        code: job.code,
      });
      sendJson(res, 202, job);
      void runPairing(job.id);
      return;
    } catch (error) {
      logError('pairing.request.invalid_body', {
        requestId,
        error,
      });
      sendJson(res, 400, {
        error: 'Invalid request body',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
      return;
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/app')) {
    await serveFrontendEntry(res);
    return;
  }

  const served = await serveStatic(res, pathname);
  if (served) {
    return;
  }

  logError('portal.not_found', {
    requestId,
    method: req.method,
    path: pathname,
  });
  sendText(res, 404, 'Not found');
});

loadPersistedJobs();

server.listen(port, () => {
  console.log(`Suka pairing portal listening on http://localhost:${port}`);
  console.log(`Portal login user: ${authUser}`);
  console.log(`App log file: ${appLogFile}`);
  logInfo('server.started', {
    port,
    user: authUser,
    logFile: appLogFile,
    logLevel: appLogLevel,
  });
});
