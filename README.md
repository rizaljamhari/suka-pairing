# Suka Pairing Portal

Internal family portal for pairing a TV to a Suka (read as Sooka) account.

## Why this exists (Motivation)

I share one streaming account across multiple households for family members. They often need to pair their smart TVs at different times. Previously, they had to ask me directly, which meant they had to wait if I was busy or offline. 

This self-service portal allows family members to input their TV pairing code (or scan/upload a QR screenshot) and pair their devices independently, without needing my active intervention.

The portal UI is a React + Vite single-page app served by `server.mjs` from `client-dist/`.

## What is implemented

- Portal login protects the site and API with an HTTP-only session cookie.
- The authenticated app uses tabbed screens for Pairing, Session, and Logging.
- QR image drop and pasted-code input are supported.
- QR decoding happens in the browser when the `BarcodeDetector` API is available.
- Pairing jobs are tracked server-side with live polling and recent-job history.
- Session status includes masked token previews, expiry, verify, and refresh actions.
- Structured logs are written to a file with `debug`, `info`, and `error` levels, including outgoing Sooka request/response headers and bodies.

## Run

```bash
cp .env.example .env
```

Set `AUTH_USER`, `AUTH_PASSWORD`, and `APP_SESSION_SECRET` in `.env`, then run:

```bash
npm start
```

`npm start` now builds the React frontend and then starts the Node server.

Then open `http://localhost:8787/login` and sign in with the portal credentials you configured.

## Frontend workflow

Production build output is written to `client-dist/`.

Useful commands:

```bash
npm run build
npm start
```

`npm run dev` still starts the Vite frontend only. Use it when working on UI code in isolation.

## Attach a persistent session

Paste the raw JSON response from Sooka's `/login` endpoint and optionally paste the authenticated
request headers as JSON when the API expects more than a bearer token.

1. Start the portal:

```bash
npm start
```

2. Log in through the portal form. The server will set an HTTP-only session cookie so the browser stops prompting for credentials on every request.

3. In the **Session** tab, use **Save session**.

4. Paste the raw `/login` response JSON. The portal extracts `data.accessToken`,
   `data.refreshToken`, `userDetails`, and `defaultProfileId` automatically.

5. If your authenticated Sooka requests always include extra headers, paste them into
   **Request headers JSON**. The portal merges them into every validate/status request.

6. Click **Save session**, then **Verify session** to confirm the persisted auth works against the Sooka API.
   Verification now calls the contact endpoint and returns the logged-in identity when the token is valid.

7. Use **Refresh token** when the saved access token is nearing expiry and you want the portal to rotate it immediately.

Persisted session location defaults to `.data/sooka-session.json` (override with `SOOKA_SESSION_STORE_FILE`).

API endpoints for bootstrap flow:
- `GET /api/bootstrap/status`
- `POST /api/bootstrap/session` with `{ "loginResponse": { ... }, "requestHeaders": { ... } }`
- `POST /api/bootstrap/verify`
- `POST /api/bootstrap/clear`
- `POST /api/session/refresh`

### Environment variables

- `AUTH_USER=...` required portal login username
- `AUTH_PASSWORD=...` required portal login password
- `APP_SESSION_SECRET=...` required secret used to sign the portal session cookie
- `APP_SESSION_TTL_DAYS=30` portal session lifetime
- `APP_SESSION_COOKIE_NAME=sooka_portal_session` portal session cookie name
- `APP_LOG_FILE=.logs/portal.log` structured JSONL log output
- `APP_LOG_LEVEL=debug` log level threshold: `debug`, `info`, or `error`
- `SOOKA_APP_URL=https://sooka.my` (default)
- `SOOKA_API_BASE_URL=https://api.vr.ctrp.sooka.my` (default)
- `SOOKA_PAIR_TV_URL=https://sooka.my/pair-tv` (default)
- `SOOKA_CONTACT_ENDPOINT=/login/v1/contact` (default)
- `SOOKA_REFRESH_ENDPOINT=/login/auth/v1/refresh-token` (default)
- `SOOKA_TENANT_IDENTIFIER=master` (default)
- `SOOKA_LANGUAGE=eng` (default)
- `SOOKA_VALIDATE_ENDPOINT=/login/v1/smart-tv/validate` (default)
- `SOOKA_STATUS_ENDPOINT=/login/pub/v1/smart-tv/status` (default)
- `SOOKA_ACCESS_TOKEN=...` optional direct access token override
- `SOOKA_REFRESH_TOKEN=...` optional direct refresh token override
- `SOOKA_LOGIN_RESPONSE_JSON={...}` optional raw `/login` response seed
- `SOOKA_REQUEST_HEADERS_JSON={...}` optional JSON object merged into every Sooka API request
- `SOOKA_STATUS_POLL_INTERVAL_MS=1800` (default)
- `SOOKA_SESSION_STORE_FILE=.data/sooka-session.json` (default)
- `SOOKA_STATUS_TIMEOUT_MS=90000` (default)

The job is marked `paired` either when Sooka validate returns an immediate success message or when a later status response reaches a success terminal state.

## Notes

- Keep this on a trusted home network.
- `.env`, `.data/`, and `.logs/` should stay local and are ignored for git.
- `APP_SESSION_SECRET` is mandatory; without it the server refuses to start.
- Do not commit real portal credentials, session secrets, tokens, logs, or persisted session files.
- Cookies are no longer used for API calls here; bearer auth comes from the `/login` response.
