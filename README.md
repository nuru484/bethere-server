# <img src="public/assets/logo.png" alt="BeThere Logo" width="35" style="vertical-align: middle;"/> BeThere – Smart Attendance System Backend

**BeThere** is the backend that powers a full-stack **smart attendance system** that verifies **live presence**: a person scans a **rotating code shown on a screen at the venue** to prove they are physically there, then a short **face-liveness check** confirms it is really them, live. Both are verified **entirely on the server**, from raw camera frames, so the check cannot be faked by tampering with the app. It is built for organizations, schools, and recurring events where attendance records need to be genuinely hard to fake: you have to *be there*, in person.

This repository is the **API and background job engine**. It handles authentication, event and session scheduling, the rotating venue codes, server-side face verification, encrypted biometric storage, evidence/anomaly/audit trails, and organization-wide analytics. The companion frontend lives in [BeThere-client](https://github.com/nuru484/BeThere-client.git).

> **One-line pitch:** Verified live presence. Scan the venue's live code, then a real-time face check confirms it's you, all verified on the server, not your phone.

> **On the security claim:** no browser-based system is literally unfakeable (only a native app with hardware attestation fully closes live-relay collusion). BeThere is built to be *as close as a web app gets*: it defeats the practical attacks (posting a fake descriptor, replaying a photo, a stale screenshotted code) and leaves a reviewable evidence trail for the rest.

---

## How It Works

**1. Enrollment (consented, encrypted).**
A user enrolls their face once. The 128-dimension descriptor is produced in the browser with **face-api.js**, but the server stores it **AES-256-GCM encrypted at rest** (`faceScanEnc`) and decrypts it only in memory at match time; the raw descriptor never leaves the server. Enrollment requires explicit **biometric consent** (GDPR Art. 9 / BIPA), and deletion destroys the template.

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
* Enroll a face once (consented; stored encrypted on the server).
* Check in and out by scanning the venue's rotating code, then a live face-liveness check.
* View personal attendance history and event details.

### Admin Capabilities

* Create, update, and delete events (each gets a rotating venue code).
* Open the **venue-code display** for an event (the screen shown at the location).
* Define event recurrence, duration, and allowed check-in times.
* Manage user records and reset a user's face template when required.
* Review anomaly flags and check-in evidence; view attendance analytics and reports.

### Automated System Intelligence

* **BullMQ + Redis** power recurring event **session generation**.
* Rotating **venue codes** are stateless keyed hashes (no per-rotation DB load).
* **date-fns** manages all date and time calculations (windows in the venue timezone).
* A scheduled **retention sweep** purges expired auth material, challenges, evidence, and dormant biometric templates.
* Robust **error handling**, **role-based access control**, and **input validation** via *express-validator*.

### Authentication & Security

* **Cookie-only JWT** access + refresh tokens with **rotation and replay-as-theft detection**, plus a per-request session-epoch check for instant revocation.
* Passwordless **OTP login**, optional **2FA**, and a hashed-token **password reset** flow (`nodemailer` + EJS).
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
| **Email**              | nodemailer + EJS templates                    |
| **Validation**         | express-validator                              |
| **Logging**            | pino + pino-pretty, morgan (HTTP requests)    |
| **CORS**               | cors (trusted origins only)                   |
| **Deployment**         | Render (API + separate background worker)     |

---

## Architecture Overview

```
Frontend (face-api.js)
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

1. Enrollment: the client computes a face descriptor; the server stores it encrypted.
2. On sign-in/out, the client sends the scanned venue code, then uploads raw face frames.
3. The server validates both, from its own data and the pixels:

   * Presence: the scanned code matches the event's current rotating code.
   * Identity + liveness: the frames perform the randomized actions and match the enrolled template.
4. Validations pass -> Attendance record created (failed attempts -> flagged evidence + anomaly).
5. Background workers auto-generate sessions and run the retention sweep.

---

## Database Design

**Core Entities**

* **User**: stores user details, roles, and face scan embeddings.
* **Event**: base entity defining event metadata, recurrence, and location.
* **Session**: generated automatically for recurring or future events.
* **Attendance**: links users to sessions (with timestamps and status).
* **Location**: stores the venue's name, city, and country for each event (no coordinates: presence is proven by the rotating venue code, not GPS).

All schema relations and constraints are defined using **Prisma**.

---

## Background Jobs

### Purpose

Automates the creation of event sessions using **BullMQ** and **Redis**.

### Components

* `src/jobs/session-queue.js` → defines the job queue.
* `src/jobs/session-scheduler.js` → finds upcoming events and schedules session creation jobs.
* `src/jobs/session-worker.js` → executes session creation logic, ensuring no duplicates and respecting recurrence intervals.
* `src/jobs/token-cleanup.js` → queue for the daily retention sweep.
* `src/jobs/lifecycle.js` → starts/stops every worker and registers the daily repeatable jobs (session generation at midnight, retention sweep at 03:00). Shared by both entrypoints.
* `worker.js` → the dedicated worker process entrypoint: calls `startWorkers()` and manages graceful shutdown. The web process (`server.js`) runs the same workers in-process unless `WEB_DISABLE_WORKERS=true`.

---

## Getting Started

### Prerequisites

* **Node.js** ≥ 20.6 (the `dev`, `migrate`, `seed:dev`, `worker:dev`, and `studio` scripts use `node --env-file`, which landed in 20.6). Node **22** is what the Dockerfile builds and runs on and is the recommended version.
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
weights face-api.js publishes). Note that the client's `public/models` is **not** a
complete source: the browser only enrolls descriptors, so it ships just
`tiny_face_detector`, `face_landmark_68`, and `face_recognition`. The
`face_expression` net is server-only (the "smile" liveness action needs it), and a
missing set makes model loading, and therefore every check-in, fail.

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
tracking), `WEB_DISABLE_WORKERS` (`false`), and `PROCESS_TYPE` (`web`, read by
the Docker entrypoint).

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