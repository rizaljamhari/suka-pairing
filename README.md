# Suka (read as Sooka) Pairing Portal

Internal family portal for pairing a TV to a Suka account.

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
2. Configure `AUTH_USER`, `AUTH_PASSWORD`, and `APP_SESSION_SECRET` in `.env`.
3. Start the application:
   ```bash
   npm start
   ```
4. Open `http://localhost:8787` in your browser.

---

## Configuration Variables

The application can be configured using the following environment variables in `.env`:

- `PORT=8787` - Server port
- `AUTH_USER=...` - Required portal login username
- `AUTH_PASSWORD=...` - Required portal login password
- `APP_SESSION_SECRET=...` - Required random secret used to sign session cookies
- `APP_SESSION_TTL_DAYS=30` - Portal session duration in days
- `APP_LOG_LEVEL=info` - Log level (`debug`, `info`, `error`)
- `APP_JOBS_FILE=.data/jobs.jsonl` - Pairing jobs database path

---

## Notes
- **Internet Exposure & Security Warning**: If you choose to expose this portal to the public internet (e.g., to allow family members to access it from their homes), **make sure you know what you are doing**. Since this portal stores a valid, active Suka streaming session (under `./data`), anyone who accesses the portal gains control over your session. Ensure you configure a very strong `AUTH_USER` and `AUTH_PASSWORD`, and serve it over HTTPS (e.g., behind a secure reverse proxy).
- Keep this on a trusted home network if not exposing it.
- `.env`, `./data`, and `./logs` are ignored by git and should stay local.
- Never commit credentials or session tokens to the repository.
