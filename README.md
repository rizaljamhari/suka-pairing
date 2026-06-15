# Suka (read as Sooka) Pairing Portal

Internal family portal for pairing a TV to a Sooka account.

## Why this exists (Motivation)

I share one streaming account across multiple households for family members. They often need to pair their smart TVs at different times. Previously, they had to ask me directly, which meant they had to wait if I was busy or offline. 

This self-service portal allows family members to input their TV pairing code (or scan/upload a QR screenshot) and pair their devices independently, without needing my active intervention.

---

## Run with Docker (Recommended)

You can build and deploy the application using Docker and Docker Compose:

```bash
docker-compose up -d --build
```

- Portal will be listening on `http://localhost:8787` (or whatever port you mapped).
- Persistent data (jobs and session state) is stored in `./data`.
- Logs are outputted to `./logs`.

## Run locally

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
2. Configure `AUTH_USER`, `AUTH_PASSWORD`, `ADMIN_USER`, `ADMIN_PASSWORD`, and `APP_SESSION_SECRET` in `.env`.
3. Start the application:
   ```bash
   npm start
   ```
4. Open `http://localhost:8787` in your browser.

---

## Configuration Variables

The application can be configured using the following environment variables in `.env`:

- `PORT=8787` - Server port
- `AUTH_USER=...` - Required standard portal login username
- `AUTH_PASSWORD=...` - Required standard portal login password
- `ADMIN_USER=...` - Required admin portal login username
- `ADMIN_PASSWORD=...` - Required admin portal login password
- `APP_SESSION_SECRET=...` - Required random secret used to sign session cookies
- `APP_SESSION_TTL_DAYS=30` - Portal session duration in days
- `APP_LOG_LEVEL=info` - Log level (`debug`, `info`, `error`)
- `APP_JOBS_FILE=.data/jobs.jsonl` - Pairing jobs database path

---

## User Roles & Permissions

The portal supports two user roles to facilitate secure sharing with family members:

| Action / Access | Admin (`ADMIN_USER`) | Standard (`AUTH_USER`) |
| --- | --- | --- |
| **TV Pairing** | Yes | Yes |
| **View Session Status** | Yes | Yes |
| **Trigger Session Verification** | Yes | Yes |
| **Update Sooka Session Credentials** | Yes | No (Hidden) |
| **Purge Pairing History** | Yes | No (Hidden) |
| **View System Logs** | Yes | No (Hidden) |

---

## Notes
- **Internet Exposure & Security Warning**: If you choose to expose this portal to the public internet (e.g., to allow family members to access it from their homes), **make sure you know what you are doing**. Since this portal stores a valid, active Sooka streaming session (under `./data`), anyone who accesses the portal gains control over your session. Ensure you configure very strong credentials (especially for `ADMIN_USER` and `ADMIN_PASSWORD`), and serve it over HTTPS (e.g., behind a secure reverse proxy).
- Keep this on a trusted home network if not exposing it.
- `.env`, `./data`, and `./logs` are ignored by git and should stay local.
- Never commit credentials or session tokens to the repository.
