# <img src="public/assets/logo.png" alt="BeThere Logo" width="35" style="vertical-align: middle;"/> BeThere – Smart Attendance System Backend

**BeThere** is the backend that powers a full-stack **smart attendance system** that verifies **live presence**: a person scans a **rotating code shown on a screen at the venue** to prove they are physically there, then a short **face-liveness check** confirms it is really them, live. Both are verified **entirely on the server**, from raw camera frames, so the check cannot be faked by tampering with the app. It is built for organizations, schools, and recurring events where attendance records need to be genuinely hard to fake: you have to *be there*, in person.

This repository is the **API and background job engine**. It handles authentication, event and session scheduling, the rotating venue codes, server-side face verification, encrypted biometric storage, evidence/anomaly/audit trails, and organization-wide analytics. The companion frontend lives in [BeThere-client](https://github.com/nuru484/BeThere-client.git).

> **One-line pitch:** Verified live presence. Scan the venue's live code, then a real-time face check confirms it's you, all verified on the server, not your phone.

> **On the security claim:** no browser-based system is literally unfakeable (only a native app with hardware attestation fully closes live-relay collusion). BeThere is built to be *as close as a web app gets*: it defeats the practical attacks (posting a fake descriptor, replaying a photo, a stale screenshotted code) and leaves a reviewable evidence trail for the rest.

---

## How It Works

**1. Enrollment (consented, encrypted).**
A user enrolls their face once through the same guided liveness capture used at check-in: the browser uploads raw frames, and the **server** derives the 128-dimension descriptor from them with **@vladmandic/face-api** (no descriptor is ever computed in, or accepted from, the browser). The template is stored **AES-256-GCM encrypted at rest** (`faceScanEnc`, bound to its owner through the cipher's additional authenticated data) and decrypted only in memory at match time; the raw descriptor never leaves the server. Enrollment requires explicit **biometric consent** (GDPR Art. 9 / BIPA), and deletion destroys the template.

**2. Presence: the rotating venue code.**
Each event has a server-side secret. A screen at the venue shows a QR that rotates every **30 seconds**; the codes are stateless keyed hashes of the secret and the current time window, so nothing polls or writes the database to rotate them (the display fetches a batch and cycles locally). Scanning the current code is the presence gate. A screenshotted code is stale within seconds.

**3. Identity: server-side liveness.**
Check-in and check-out are a two-step handshake. A fail-fast preflight (valid venue code + enrollment + session window) issues a **randomized action sequence** (turn, blink, smile) and a single-use challenge token. The client uploads raw frames performing those actions, and the server verifies, from the pixels: the actions happened, the face matches the enrolled template, it is not a replayed descriptor, and it is one continuous person. Only then is attendance recorded (**PRESENT / LATE**). Failed attempts are retained as flagged evidence and an anomaly for review.

**4. Automated recurring sessions.**
Events can be one-off or **recurring** (every X days, with a duration and a daily open/close window). A **BullMQ + Redis** pipeline (`session-scheduler.js` -> `session-worker.js`, wired up by `src/jobs/lifecycle.js`) automatically generates `Session` records for upcoming occurrences and deduplicates them. It runs in-process on the web server by default, or in a **separate worker process** (`worker.js`) when `WEB_DISABLE_WORKERS=true` is set on the web process. **date-fns** handles all date math.

**5. Roles, dashboards, and audit.**
Two roles (`ADMIN`, `USER`). **Users** check in/out and view their own history. **Admins** create/update/delete events, open the venue-code display, manage users, reset a user's face scan, review anomaly flags and evidence, and pull organization-wide analytics. Every check-in and biometric action is written to an append-only **audit log**.

**6. Auth & security.**
Cookie-only **JWT** access + refresh tokens with **refresh-token rotation and replay-as-theft detection**, a per-request session-epoch check, role-based access control, passwordless OTP login and optional 2FA, password reset via hashed tokens (nodemailer + EJS), **Cloudinary** for image storage, CORS locked to trusted origins, Redis-backed rate limiting, and structured logging with **pino**. A scheduled retention sweep purges expired auth material, challenges, evidence, and dormant biometric templates.

---

## Table of Contents

* [API Reference](#-api-reference)
* [Features](#-features)
* [Tech Stack](#-tech-stack)
* [Architecture Overview](#-architecture-overview)
* [Database Design](#-database-design)
* [Background Jobs](#-background-jobs)
* [Getting Started](#-getting-started)
* [Environment Variables](#-environment-variables)
* [Project Structure](#-project-structure)
* [Deployment](#-deployment)
* [Contributing](#-contributing)
* [License](#-license)

---

## API Reference

Interactive docs for every endpoint: **[api.bethere.manuru.dev/api/docs](https://api.bethere.manuru.dev/api/docs)**

The raw OpenAPI 3.1 document is at `/api/docs.json`, so you can import the whole
API into Postman or Insomnia, or point a client generator at it.

**Trying it out.** Auth is an httpOnly cookie, not a bearer token, so there is
nothing to paste into the Authorize dialog. Call `POST /api/v1/auth/demo-login`
with `{"role": "ADMIN"}` from the docs page itself: the browser stores the
session cookie and every other endpoint becomes callable.

**How the spec is maintained.** It lives in `docs/openapi/`, split one file per
domain under `paths/` and `components/`, and is assembled at boot by
`src/docs/openapi.js`. Because hand-written docs rot, `npm run docs:check`
validates the document and diffs it against the routes Express actually mounts;
CI fails on an endpoint that ships without documentation or a documented path
that no longer exists.

---

## Features

### User Capabilities

* Register and authenticate (passwordless OTP login or password + optional 2FA).
* Enroll a face once (consented; derived and stored encrypted on the server), on the current device or from a phone paired by QR code.
* Check in and out by scanning the venue's rotating code, then a live face-liveness check; either step can be handed to a paired phone.
* View personal attendance history, event details, and a personal dashboard.

### Admin Capabilities

* Create, update, and delete events (each gets a rotating venue code).
* Open the **venue-code display** for an event (the screen shown at the location).
* Define event recurrence, duration, and allowed check-in times.
* Manage user records and reset a user's face template when required.
* Review anomaly flags and check-in evidence; view attendance analytics and reports, export them to Excel, and generate an AI-written narrative of the numbers (Gemini, optional).
* Every admin and biometric action lands in an append-only audit log.

### Automated System Intelligence

* **BullMQ + Redis** power recurring event **session generation**, a **session finalizer** that marks absentees and auto-checks-out open check-ins once a session's grace period has passed, and a **mail queue** with retries for email nobody is waiting on screen for.
* Rotating **venue codes** are stateless keyed hashes (no per-rotation DB load).
* **date-fns** manages all date and time calculations (windows in the venue timezone).
* A scheduled **retention sweep** purges expired auth material, challenges, pairing sessions, evidence, and dormant biometric templates.
* Robust **error handling**, **role-based access control**, and **input validation** via *express-validator*.

### Authentication & Security

* **Cookie-only JWT** access + refresh tokens with **rotation and replay-as-theft detection**, plus a per-request session-epoch check for instant revocation.
* Passwordless **OTP login**, optional **2FA**, and a hashed-token **password reset** flow (Resend + EJS templates).
* **Server-side face verification** with **randomized-action liveness**; biometric templates **AES-256-GCM encrypted at rest**, decrypted only in memory.
* **Consent + retention** for biometric data; flagged-attempt **evidence**, **anomaly flags**, and an append-only **audit log**.
* Redis-backed **rate limiting**, `helmet`, bcrypt password hashing, **Cloudinary** image storage (parsed with `multer`), and CORS locked to trusted origins.

---

## Tech Stack

| Layer                  | Technology / Library                          |
| ---------------------- | --------------------------------------------- |
| **Framework**          | Express.js (JavaScript – ES Modules)          |
| **Database**           | PostgreSQL (`pg` + `@prisma/adapter-pg`)      |
| **ORM**                | Prisma                                         |
| **Authentication**     | JWT (`jsonwebtoken`) access + refresh tokens  |
| **Password Hashing**   | bcrypt                                          |
| **Cookies**            | cookie-parser (refresh-token cookie)          |
| **Job Queue**          | Redis + BullMQ (via ioredis)                  |
| **Face verification**  | @vladmandic/face-api on the tfjs WASM backend |
| **Presence**           | Rotating venue codes (HMAC-SHA256, time-windowed) |
| **Biometric crypto**   | AES-256-GCM (templates encrypted at rest)     |
| **Date Handling**      | date-fns                                        |
| **File Uploads**       | multer (multipart parsing)                    |
| **File Storage**       | Cloudinary                                      |
| **Email**              | Resend + EJS templates (queued via BullMQ)    |
| **Validation**         | express-validator                              |
| **Logging**            | pino + pino-http (request-correlated), Sentry |
| **CORS**               | cors (trusted origins only)                   |
| **Deployment**         | Render (API + separate background worker)     |

---

## Architecture Overview

```
Frontend (React; MediaPipe FaceLandmarker only gates when frames are captured)
   ↓
API Gateway (Express.js)
   ↓
Controllers → Prisma ORM → PostgreSQL
   ↓
Redis (BullMQ)
   ↓
Session Scheduler → Session Worker (background)
```

**Key Data Flow:**

1. Enrollment: the client uploads raw frames from a guided liveness capture; the server verifies them, derives the face descriptor, and stores it encrypted.
2. On sign-in/out, the client sends the scanned venue code, then uploads raw face frames.
3. The server validates both, from its own data and the pixels:

   * Presence: the scanned code matches the event's current rotating code.
   * Identity + liveness: the frames perform the randomized actions and match the enrolled template.
4. Validations pass -> Attendance record created (failed attempts -> flagged evidence + anomaly).
5. Background workers auto-generate sessions and run the retention sweep.

---

## Database Design

**Core Entities** (14 Prisma models)

* **User**: an attendant; profile, consent, the encrypted face template (`faceScanEnc`), and the session epoch (`tokenVersion`).
* **Admin**: staff, a separate table from users with its own lifecycle and no biometrics.
* **Event**: base entity defining event metadata, recurrence, the venue-code secret, and location.
* **Session**: one occurrence of an event, generated automatically for recurring or future events and finalized once its window and grace have passed.
* **Attendance**: links users to sessions (PRESENT / LATE / ABSENT, with timestamps and an auto-check-out flag).
* **Location**: stores the venue's name, city, and country for each event (no coordinates: presence is proven by the rotating venue code, not GPS).
* **LivenessChallenge** and **PairingSession**: the single-use challenge with its randomized action sequence, and the QR hand-off that lets a phone enroll or check in on behalf of the signed-in device.
* **AnomalyFlag**, **AttendanceEvidence**, **AuditLog**: the review trail for failed or suspicious attempts, and the append-only record of every security-relevant action.
* **RefreshToken**, **OtpCode**, **PasswordReset**: hashed, single-use auth material.

All schema relations and constraints are defined using **Prisma**.

---

## Background Jobs

### Purpose

Automates session creation and finalization, the daily retention sweep, and queued email using **BullMQ** and **Redis**.

### Components

* `src/jobs/session-queue.js` → defines the job queue.
* `src/jobs/session-scheduler.js` → finds upcoming events and schedules session creation jobs.
* `src/jobs/session-worker.js` → executes session creation logic, ensuring no duplicates and respecting recurrence intervals.
* `src/jobs/session-finalizer.js` → queue for the session-finalization sweep (absence marking and auto check-out, every few minutes; `SESSION_FINALIZER.CRON_PATTERN`).
* `src/jobs/token-cleanup.js` → queue for the daily retention sweep.
* `src/jobs/mail-queue.js` / `mail-worker.js` → email that must not fail the action that triggered it (reset links, deferred codes) is queued with retries; mail a person is waiting for on screen stays awaited at the call site.
* `src/jobs/lifecycle.js` → starts/stops every worker and registers the repeatable jobs (session generation at midnight, retention sweep at 03:00, session finalization on its own cron), running the scheduler and finalizer once on boot so a deploy that was down over a boundary catches up. Shared by both entrypoints.
* `worker.js` → the dedicated worker process entrypoint: calls `startWorkers()` and manages graceful shutdown. The web process (`server.js`) runs the same workers in-process unless `WEB_DISABLE_WORKERS=true`.

---

## Getting Started

### Prerequisites

* **Node.js 22**, the exact version pinned in `.nvmrc` (`nvm use` picks it up; CI and the deploy workflow install the same one, and the Dockerfile builds on `node:22`). The `dev`, `migrate`, `worker:dev`, and `studio` scripts use `node --env-file`, so anything below 20.6 will not run them.
* **PostgreSQL** ≥ 14
* **Redis** (for BullMQ queue management)

### Installation

```bash
# Clone repository
git clone git@github.com:your-username/bethere-server.git
cd bethere-server

# Install dependencies
npm install
```

### Face models & the biometric key

Server-side face verification needs two things in place:

**1. Model weights.** They must live under `FACE_MODELS_PATH` (default `./models`) and
**already ship in this repo's `./models` directory**, so a fresh clone needs no extra
step. `src/lib/face-engine.js` loads four nets, which means these nine files:

```
models/
├── tiny_face_detector_model-weights_manifest.json
├── tiny_face_detector_model-shard1
├── face_landmark_68_model-weights_manifest.json
├── face_landmark_68_model-shard1
├── face_recognition_model-weights_manifest.json
├── face_recognition_model-shard1
├── face_recognition_model-shard2
├── face_expression_model-weights_manifest.json
└── face_expression_model-shard1
```

If you ever need to restore them, take them from the `model/` directory of the
[@vladmandic/face-api](https://github.com/vladmandic/face-api) repository (the same
weights face-api.js publishes). The client is not a source for them: it ships
only the MediaPipe FaceLandmarker bundle under `public/models/mediapipe`, which
guides the capture and never produces a descriptor. Every face-api net,
including `face_expression` (the "smile" liveness action needs it), is
server-only, and a missing set makes model loading, and therefore every
enrollment and check-in, fail.

**2. The biometric encryption key.** Generate it and put it in `.env`:

```bash
openssl rand -hex 32   # -> FACE_TEMPLATE_ENC_KEY
```

> The face engine runs on the pure-JS **tfjs WASM backend** (no native build), so it
> installs anywhere. Budget ~1 GB RAM for the process holding the models. Set
> `LIVENESS_ENABLED=false` to skip the models in local/dev flows that don't need them.

### Database Setup

```bash
# Initialize and apply migrations
npm run migrate
```

> **Seed the Database**
>
> Creates the first admin and base configuration. The seed is **opt-in**: without
> `ADMIN_SEED_ENABLED=true` in the environment it logs "Seed skipped" and does
> nothing, so a deploy can never silently plant credentials in production.
> `npm run seed` expects the variables to already be in the environment; use
> `npm run seed:dev` to load them from `.env`.
>
> ```bash
> npm run seed:dev
> ```

### Running the Server

```bash
# Development mode
npm run dev

# Production (reads config from the real environment, not .env)
npm start
```

### Running Background Worker

The web process already runs the workers in-process, so this is only needed when
you want them isolated. If you run it, set `WEB_DISABLE_WORKERS=true` on the web
process so jobs are not processed twice.

```bash
# Run worker (session creation + scheduler + retention sweep)
npm run worker:dev
```

**API Base URL** → [https://api.bethere.manuru.dev/](https://api.bethere.manuru.dev/)

---

## Environment Variables

Copy [`.env.example`](./.env.example) to `.env` and fill it in; it is the
authoritative list and tags every variable `(required)` or `(optional)`.

Every **required** variable is read through a fail-fast reader in
`src/config/env.js`, so a missing one throws at boot with the variable named
rather than failing mid-request. The full required set is:

```bash
# --- Core ---
DATABASE_URL="postgresql://user:pass@localhost:5432/bethere?schema=public"

# --- Auth / cookies ---
ACCESS_TOKEN_SECRET="long random string"
REFRESH_TOKEN_SECRET="long random string, different from the access secret"
FRONTEND_URL="https://your-frontend.example"

# --- Face templates ---
FACE_TEMPLATE_ENC_KEY=   # 32-byte AES-256-GCM key: openssl rand -hex 32

# --- Media (Cloudinary) ---
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# --- Redis (sessions, rate limits, job queue) ---
REDIS_URL="redis://localhost:6379"

```

Email is **optional**: with no `RESEND_API_KEY` the mailer logs messages
instead of sending them, so the auth flows stay exercisable without an
account.

The admin credentials are read **only** by `npm run seed`, which asserts them
itself, so a production environment never needs them: `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `ADMIN_FIRSTNAME`, `ADMIN_LASTNAME`, `ADMIN_PHONE`.

Everything else is **optional** and falls back to a default:
`NODE_ENV` (`development`), `PORT` (`8080`), `CORS_ACCESS` (extra allowed
origins, comma-separated), `COOKIE_DOMAIN` (blank = host-only cookies),
`ADMIN_PHONE`, `ADMIN_SEED_ENABLED` (`false`), `DEMO_LOGIN_ENABLED` (`false`),
`DEMO_ADMIN_EMAIL`, `DEMO_ATTENDANT_EMAIL`, `LIVENESS_ENABLED` (`true`),
`FACE_MODELS_PATH` (`./models`), `FACE_MATCH_THRESHOLD` (`0.6`),
`RESEND_API_KEY` (blank = log-only email), `MAIL_FROM` (from-address on
outgoing mail), `EMAIL_LOGO_URL` (absolute https URL of the logo in email
mastheads), `FROG_API_KEY` / `FROG_USERNAME` / `FROG_SENDER_ID` (all blank = log-only SMS),
`EVENT_TIMEZONE` (`Africa/Accra`), `SENTRY_DSN` (blank disables error
tracking), `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`),
`SENTRY_TRACES_SAMPLE_RATE` (`0`), `SENTRY_RELEASE` (defaults to
`RENDER_GIT_COMMIT`, which Render sets itself), `LOG_LEVEL` (one of pino's
`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`; any other value
refuses to boot; defaults to `info` in production, `debug` in development,
`silent` in tests), `WEB_DISABLE_WORKERS` (`false`), and `PROCESS_TYPE`
(`web`, read by the Docker entrypoint).

### Logging and request correlation

Every request gets an id (an inbound `X-Request-Id` is reused, otherwise one
is minted), echoed on the response header and in any error body. The id is
held in an `AsyncLocalStorage` store (`src/lib/request-context.js`) for the
rest of the request, so `requestLogger()` in `src/utils/logger.js` returns a
child logger bound to it from anywhere in the call chain, and work queued
during the request (session creation, deferred email) carries it in the job
payload. Workers run each job inside that same context, so job logs, job
failure reports and Sentry events all trace back to the originating request.

### Error tracking (Sentry)

Sentry is inert until `SENTRY_DSN` is set, so local runs need no account.
To enable it on a deployment:

1. Create a Node.js project at [sentry.io](https://sentry.io) and copy its DSN.
2. Set `SENTRY_DSN` on **both** the web and the worker process.
3. Set `SENTRY_ENVIRONMENT` (`production`, `staging`) so events from each
   deployment are filtered apart; it defaults to `NODE_ENV`.
4. Optionally set `SENTRY_TRACES_SAMPLE_RATE` (for example `0.1`) to sample
   request performance; `0` reports errors only.
5. Events are tagged with the release: `SENTRY_RELEASE` if set, else the
   `RENDER_GIT_COMMIT` Render provides, so nothing is needed on Render.

What gets reported: 5xx and high-severity errors from the central error
handler (expected 4xx responses are logged, never sent), failed queue jobs,
and uncaught exceptions or unhandled rejections, which are flushed to Sentry
before the process shuts down. Every event carries the `requestId` a client
sees in its error response, and an authenticated request is attributed to the
principal's opaque id only (no email, phone or name). `sendDefaultPii` is off,
and a `beforeSend` scrubber masks the same sensitive keys the error handler
redacts (credentials, one-time codes, biometrics, cookies) in event extras,
contexts, request data and exception messages before anything is sent.

> `LIVENESS_ENABLED=false` is refused when `NODE_ENV=production`: it would make
> every check-in pass without looking at a frame.

---

## Project Structure

```
bethere-server/
│
├── prisma/                  # Prisma schema, migrations & seeds
│
├── src/
│   ├── config/              # Env, constants, Prisma, Redis, Multer configs
│   ├── controllers/         # Request/response handling per resource
│   ├── services/            # Business logic (attendance, events, auth, face scan)
│   ├── jobs/                # BullMQ queues, schedulers, workers, lifecycle
│   ├── lib/                 # Face engine, Redis client, Sentry
│   ├── middleware/          # Auth, error handling, role validation, rate limits
│   ├── routes/              # API routes
│   ├── utils/               # Logger, token verification, crypto, cloud helpers
│   └── validation/          # Input validations
│
├── models/                  # face-api model weights (FACE_MODELS_PATH)
├── app.js                   # Express app assembly
├── server.js                # Web process entry point
├── worker.js                # Dedicated background worker entry point
└── package.json
```

---

## Deployment

Deployed on **Render** with the following configuration:

| Component        | Platform / Service      |
| ---------------- | ----------------------- |
| **Backend API**  | Render                  |
| **Database**     | Managed PostgreSQL      |
| **Queue / Jobs** | Redis Cloud + BullMQ    |
| **File Storage** | Cloudinary              |
| **Logs**         | pino + Render Dashboard |

> **Note:** Worker process is deployed separately using Render background workers to handle job queues efficiently.

### First admin on a fresh deployment

```bash
npm run bootstrap   # creates ONE admin from ADMIN_EMAIL / ADMIN_FIRSTNAME /
                    # ADMIN_LASTNAME, with a GENERATED temporary password
                    # printed once. Nothing else - no demo data.
```

It runs from the **deploy workflow**, not from the build command - the platform
only installs, builds and starts. It is idempotent (an existing admin holding
those contacts is left untouched) and **skips with a notice** when the
`ADMIN_*` variables are absent, which is the normal state once the admin
exists. Set `ADMIN_EMAIL`, `ADMIN_FIRSTNAME` and `ADMIN_LASTNAME` as repository
secrets for the one deploy that should create it. `npm run seed` is the development
counterpart: demo accounts, sample attendants, events and attendance.

### Render commands

| Field | Value |
| --- | --- |
| Build Command | `npm run deploy` (`npm ci && npm run build`) |
| Start Command | `npm start` (`node server.js`) |
| Auto-Deploy | **No** - the deploy workflow owns it |

`npm ci` is the install; `npm run build` is `prisma generate`. There is no
compile step - this service runs JavaScript directly.

### Database migrations on deploy

Which path applies depends on how the service is running:

- **Source deploy (Render today):** migrations run from
  `.github/workflows/deploy.yml`, after CI passes and before Render is asked
  to build. This is the ONLY automatic path here - the platform runs the
  build command and then `npm start`, so `docker-entrypoint.sh` never
  executes.
- **Container deploy:** the entrypoint runs `npx prisma migrate deploy`
  before the app boots, on the **web process only**
  (`PROCESS_TYPE != worker`), so worker containers never race the web
  container. The Prisma CLI is a runtime dependency, so the image carries the
  pinned version. `RUN_MIGRATIONS=false` opts out.

`migrate deploy` is idempotent, so the two paths do not conflict. CI also
verifies on every change that `prisma/migrations` exactly reproduces
`schema.prisma`, so a schema edit cannot land without its migration.

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, on the Node version in `.nvmrc`, against a real Postgres 16 and
Redis 7: `npm run lint`, `npm run docs:check` (the OpenAPI reference must
match the mounted routes), the production dependency audit gate
(`scripts/audit-gate.mjs`, fails on high or critical advisories), the
migration drift gate (`prisma migrate diff` from `prisma/migrations` to
`schema.prisma`), and `npm run test:coverage`, which fails below the
coverage floors in `vitest.config.js`. A separate job builds the Dockerfile
so the image cannot rot unnoticed. Superseded runs on the same ref are
cancelled.

### GitHub secrets the deploy needs

`.github/workflows/deploy.yml` runs after CI passes on `main`, applies
migrations, triggers Render, waits for the build, and checks the deployed API
answers. It reads these from the repository's **`production` environment**
(Settings -> Environments):

| Secret | Required | Where it comes from, and what breaks without it |
| --- | --- | --- |
| `RENDER_DEPLOY_HOOK_URL` | yes | Render -> service -> Settings -> Deploy Hook. Without it the whole workflow skips with a notice, and nothing deploys. Holding this URL is enough to trigger a deploy, so treat it as a credential. |
| `PRODUCTION_DATABASE_URL` | strongly | The Render Postgres **External** connection string (the internal one is unreachable from a GitHub runner). Without it the workflow warns and deploys **without migrating** - and on a source deploy nothing else will. |
| `RENDER_API_KEY` | optional | Render -> Account Settings -> API Keys. Lets the workflow wait for the build instead of firing and forgetting, so a failed Render build fails the job. |
| `RENDER_SERVICE_ID` | optional | The `srv-…` id in the service's dashboard URL. Needed together with the API key. |
| `RENDER_HEALTH_URL` | optional | e.g. `https://api.example.com/health`. The post-deploy readiness gate. |
| `ADMIN_BOOTSTRAP_ENABLED` | only once | `true` for the single deploy that should create the first admin, then remove it. Unset (the normal state) makes the bootstrap a no-op. |
| `ADMIN_EMAIL` | with the above | The admin's address. The temporary password is generated and printed in that step's log - read it, change it at first sign-in, then delete the run. |
| `ADMIN_FIRSTNAME` / `ADMIN_LASTNAME` | with the above | The admin's name. |

---

## Contributing

Contributions are welcome! If you'd like to improve this project, feel free to:

- **Fork** the repository
- **Create a feature branch** (`git checkout -b feature/amazing-feature`)
- **Commit your changes** (`git commit -m 'Add some amazing feature'`)
- **Push to the branch** (`git push origin feature/amazing-feature`)
- **Open a Pull Request**

Please ensure your code follows the project's style guidelines and includes appropriate tests where applicable.

For major changes, please open an issue first to discuss what you would like to change.

Questions or suggestions?
**[abdulmajeednurudeen47@gmail.com](mailto:abdulmajeednurudeen47@gmail.com)**

---

## License

**MIT License**

Copyright (c) 2025 Nurudeen Abdul-Majeed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.