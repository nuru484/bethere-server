// src/config/env.js
//
// Typed, fail-fast environment access. Every variable is read exactly once,
// through a reader that validates its SHAPE, not just its presence - a
// mistyped PORT dies at boot with the variable named instead of silently
// falling back to a default mid-request. App code imports ENV and never
// touches process.env.

/**
 * Reads a boolean environment variable. Absent or empty applies the default;
 * anything other than exactly "true"/"false" throws so a typo ("1", "TRUE")
 * fails at startup instead of silently meaning false.
 */
function envBool(name, defaultValue = false) {
  const v = process.env[name];
  if (!v?.length) return defaultValue;
  if (v !== "true" && v !== "false") {
    throw new Error(
      `Invalid boolean for env variable ${name}: "${v}". Use "true" or "false".`
    );
  }
  return v === "true";
}

/**
 * Reads a numeric environment variable.
 * - If a defaultValue is provided, it acts as an optional numeric var.
 * - If no defaultValue is provided, the variable is treated as required.
 * Throws on NaN so bad values (e.g. "abc") don't silently produce a fallback.
 */
function envNumber(name, defaultValue) {
  const v = process.env[name];
  if (!v?.length) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required env variable: ${name}`);
  }
  const parsed = Number(v);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for env variable: ${name}`);
  }
  return parsed;
}

/**
 * Reads an optional environment variable. Returns undefined (rather than an
 * empty string) when the variable is absent or set to "", keeping downstream
 * consumers clean.
 */
function envOptional(name) {
  const v = process.env[name];
  return v?.length ? v : undefined;
}

/**
 * Reads the auth-cookie domain. Trimmed, and validated against the same shape
 * Express's `cookie` serializer accepts - a malformed value (stray space,
 * quotes, a full URL) would otherwise make `res.cookie` throw "option domain
 * is invalid" and 500 EVERY login/refresh. Invalid input degrades to
 * host-only cookies with a warning instead of taking auth down.
 */
function envCookieDomain(name) {
  const raw = process.env[name];
  if (!raw?.length) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const DOMAIN_RE =
    /^\.?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (!DOMAIN_RE.test(value)) {
    console.warn(
      `Ignoring invalid ${name} "${raw}": not a valid cookie domain. ` +
        `Using host-only cookies. Unset it, or use a bare domain like ".example.com".`
    );
    return undefined;
  }
  return value;
}

/**
 * Reads a required environment variable. Throws at startup if the variable is
 * missing or empty, so misconfigured deployments fail fast rather than at
 * runtime.
 */
function envRequired(name) {
  const v = process.env[name];
  if (!v?.length) throw new Error(`Missing required env variable: ${name}`);
  return v;
}


/** Decodes a 32-byte AES key from a 64-char hex or a base64 string. */
function decodeKey32(raw, label) {
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      `${label} must decode to 32 bytes (use \`openssl rand -hex 32\`).`
    );
  }
  return key;
}

/**
 * Resolves the biometric-template encryption keyring at BOOT so a short or
 * garbled key fails fast with the variable named, rather than surfacing as a
 * 500 on a user's first enrollment. Returns { keys: Map<id, Buffer(32)>,
 * activeId }.
 *
 * Configure it either way:
 *  - FACE_TEMPLATE_ENC_KEYS = "id1:material1,id2:material2,..." with an
 *    optional FACE_TEMPLATE_ENC_ACTIVE_KEY_ID (default: the last id). New
 *    templates encrypt under the active id; older ones keep decrypting under
 *    whichever id they were written with, so the active key rotates WITHOUT
 *    re-enrolling everyone. Keep an old key in the ring until nothing uses it.
 *  - FACE_TEMPLATE_ENC_KEY = "material" (the original single-key form) still
 *    works: it becomes a one-entry ring { v1: material } active "v1", which is
 *    also the id any pre-keyring ciphertext was written with.
 */
function envKeyring() {
  const multi = envOptional("FACE_TEMPLATE_ENC_KEYS");
  const single = envOptional("FACE_TEMPLATE_ENC_KEY");
  const keys = new Map();

  if (multi) {
    for (const entry of multi.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      if (sep <= 0) {
        throw new Error(
          `Invalid FACE_TEMPLATE_ENC_KEYS entry "${entry}": expected "id:material".`
        );
      }
      const id = trimmed.slice(0, sep).trim();
      if (!/^[a-z0-9_-]{1,32}$/i.test(id)) {
        throw new Error(
          `Invalid key id "${id}" in FACE_TEMPLATE_ENC_KEYS: use [a-z0-9_-], up to 32 chars.`
        );
      }
      if (keys.has(id)) {
        throw new Error(`Duplicate key id "${id}" in FACE_TEMPLATE_ENC_KEYS.`);
      }
      keys.set(
        id,
        decodeKey32(trimmed.slice(sep + 1), `FACE_TEMPLATE_ENC_KEYS key "${id}"`)
      );
    }
    if (keys.size === 0) {
      throw new Error("FACE_TEMPLATE_ENC_KEYS was set but held no valid keys.");
    }
  } else if (single) {
    keys.set("v1", decodeKey32(single, "FACE_TEMPLATE_ENC_KEY"));
  } else {
    throw new Error(
      "Missing biometric key: set FACE_TEMPLATE_ENC_KEY (or FACE_TEMPLATE_ENC_KEYS)."
    );
  }

  const requestedActive = envOptional("FACE_TEMPLATE_ENC_ACTIVE_KEY_ID");
  if (requestedActive && !keys.has(requestedActive)) {
    throw new Error(
      `FACE_TEMPLATE_ENC_ACTIVE_KEY_ID "${requestedActive}" is not one of the configured keys.`
    );
  }
  // The newest configured key by default (last entry), or "v1" single-key.
  const activeId = requestedActive ?? [...keys.keys()].at(-1);

  return { keys, activeId };
}

const FACE_KEYRING = envKeyring();

const ENV = {
  ACCESS_TOKEN_SECRET: envRequired("ACCESS_TOKEN_SECRET"),

  /**
   * ADMIN_*: read ONLY by `npm run seed`, which asserts them itself. Optional
   * here so the API and the worker boot without them - seeding is a local
   * chore, and production has no reason to carry the admin credentials in its
   * environment.
   */
  ADMIN_EMAIL: envOptional("ADMIN_EMAIL"),
  ADMIN_FIRSTNAME: envOptional("ADMIN_FIRSTNAME"),
  ADMIN_LASTNAME: envOptional("ADMIN_LASTNAME"),
  ADMIN_PASSWORD: envOptional("ADMIN_PASSWORD"),
  ADMIN_PHONE: envOptional("ADMIN_PHONE"),
  /** Gate for `npm run bootstrap`: false (default) makes it a no-op, so the
   * first-admin step only fires on the deploy that is meant to create it. */
  ADMIN_BOOTSTRAP_ENABLED: envBool("ADMIN_BOOTSTRAP_ENABLED"),
  /** Gate for `npm run seed`: false (default) makes the seed a no-op, so a
   * deploy can never silently plant demo credentials in production. */
  ADMIN_SEED_ENABLED: envBool("ADMIN_SEED_ENABLED"),

  CLOUDINARY_API_KEY: envRequired("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: envRequired("CLOUDINARY_API_SECRET"),
  CLOUDINARY_CLOUD_NAME: envRequired("CLOUDINARY_CLOUD_NAME"),

  /**
   * One-click demo login (portfolio). When true, POST /auth/demo-login signs
   * into a seeded demo account for the requested role WITHOUT any credentials
   * in the client bundle. Off by default so a real deployment never exposes it
   * unintentionally.
   */
  DEMO_LOGIN_ENABLED: envBool("DEMO_LOGIN_ENABLED"),
  /**
   * Email of the seeded DEDICATED demo admin - deliberately NOT the primary
   * admin, so enabling demo login never hands out the real admin account.
   */
  DEMO_ADMIN_EMAIL: envOptional("DEMO_ADMIN_EMAIL") ?? "demo-admin@bethere.app",
  /** Email of the seeded dedicated demo ATTENDANT. */
  DEMO_ATTENDANT_EMAIL:
    envOptional("DEMO_ATTENDANT_EMAIL") ?? "demo-attendant@bethere.app",

  /** Cookie scope for the auth cookies (unset = current host only). A
   * malformed value degrades to host-only instead of 500-ing every login. */
  COOKIE_DOMAIN: envCookieDomain("COOKIE_DOMAIN"),
  CORS_ACCESS: envOptional("CORS_ACCESS"),
  /** The venue timezone the "HH:MM" event windows are written in. */
  EVENT_TIMEZONE: envOptional("EVENT_TIMEZONE") ?? "Africa/Accra",
  DATABASE_URL: envRequired("DATABASE_URL"),

  /**
   * The biometric-template encryption keyring (AES-256-GCM), resolved and
   * validated at boot by envKeyring() above. `FACE_TEMPLATE_ENC_KEYS` is a
   * Map<keyId, Buffer(32)>; `FACE_TEMPLATE_ENC_ACTIVE_KEY_ID` is the id new
   * templates are encrypted under. Biometric data must never sit in the DB in
   * plaintext. Rotating the active key no longer invalidates existing
   * templates - old keys stay in the ring until nothing references them.
   */
  FACE_TEMPLATE_ENC_KEYS: FACE_KEYRING.keys,
  FACE_TEMPLATE_ENC_ACTIVE_KEY_ID: FACE_KEYRING.activeId,
  /**
   * Server-side liveness verification switch. On by default; tests and local
   * flows without the ML models set it false to skip the heavy face engine.
   */
  LIVENESS_ENABLED: envBool("LIVENESS_ENABLED", true),
  /** Directory holding the face-api model weights (see README setup). */
  FACE_MODELS_PATH: envOptional("FACE_MODELS_PATH") ?? "./models",
  /** Euclidean match threshold for the enrolled vs captured descriptor. */
  FACE_MATCH_THRESHOLD: envNumber("FACE_MATCH_THRESHOLD", 0.6),

  /**
   * Masthead logo in every email, fetched by the recipient's client. It only
   * resolves once it is a public https URL - an inbox cannot fetch localhost.
   */
  EMAIL_LOGO_URL: envOptional("EMAIL_LOGO_URL"),

  FRONTEND_URL: envRequired("FRONTEND_URL"),

  /** Frog (Wigal) SMS credentials - all three unset means log-only SMS. */
  FROG_API_KEY: envOptional("FROG_API_KEY"),
  FROG_SENDER_ID: envOptional("FROG_SENDER_ID"),
  FROG_USERNAME: envOptional("FROG_USERNAME"),


  /**
   * Google Gemini for the admin analytics AI narrative. Optional: unset leaves
   * the AI summary feature inert (the endpoint reports it is not configured
   * rather than erroring), so nothing breaks without a key.
   */
  GEMINI_API_KEY: envOptional("GEMINI_API_KEY"),
  GEMINI_MODEL: envOptional("GEMINI_MODEL") ?? "gemini-2.5-flash",

  /** Pino level override; defaults by NODE_ENV (silent in tests). */
  /** From-address on outgoing mail, e.g. "BeThere <no-reply@bethere.app>". */
  MAIL_FROM: envOptional("MAIL_FROM") ?? "BeThere <onboarding@resend.dev>",

  LOG_LEVEL: envOptional("LOG_LEVEL"),

  NODE_ENV: envOptional("NODE_ENV") ?? "development",
  PORT: envNumber("PORT", 8080),

  /**
   * Express trust-proxy setting. Default "1" (exactly one hop: the platform's
   * load balancer). Set to "false" when the app is exposed directly, so a
   * client cannot spoof X-Forwarded-For into req.ip - the value rate limiting
   * keys on and the audit trail records. Accepts false | true | a hop count.
   */
  TRUST_PROXY: (() => {
    const raw = envOptional("TRUST_PROXY") ?? "1";
    if (raw === "false") return false;
    if (raw === "true") return true;
    const hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(
        `Invalid TRUST_PROXY "${raw}": use "false", "true", or a hop count.`
      );
    }
    return hops;
  })(),

  /**
   * Seeds five SAMPLE attendants (random passwords) alongside the demo data.
   * Separate from ADMIN_SEED_ENABLED so creating the first real admin in
   * production never also plants example accounts.
   */
  SEED_SAMPLE_DATA: envBool("SEED_SAMPLE_DATA"),

  REDIS_URL: envRequired("REDIS_URL"),

  /** Resend API key. Unset means the mailer logs instead of sending. */
  RESEND_API_KEY: envOptional("RESEND_API_KEY"),
  REFRESH_TOKEN_SECRET: envRequired("REFRESH_TOKEN_SECRET"),

  /** Error tracking (Sentry). Optional: unset disables reporting. */
  SENTRY_DSN: envOptional("SENTRY_DSN"),


  /**
   * The web process runs the BullMQ workers in-process by default (single
   * deployment). Set to true on the WEB process when a dedicated worker
   * process runs `npm run worker`, so jobs are never processed twice.
   */
  WEB_DISABLE_WORKERS: envBool("WEB_DISABLE_WORKERS"),

  /**
   * Port for the dedicated worker process's minimal health endpoint (the
   * Docker HEALTHCHECK hits it). 0 disables it.
   */
  WORKER_HEALTH_PORT: envNumber("WORKER_HEALTH_PORT", 8081),
};

// Fail closed: LIVENESS_ENABLED=false swaps in a verifier that passes EVERY
// check-in without looking at a single frame. That is a legitimate switch for
// local work and tests, but in production it would silently turn verified
// presence into self-reported presence, and the resulting attendance rows are
// indistinguishable from genuine ones. Refuse to boot instead.
if (ENV.NODE_ENV === "production" && !ENV.LIVENESS_ENABLED) {
  throw new Error(
    "LIVENESS_ENABLED=false is not permitted when NODE_ENV=production: it " +
      "disables face verification entirely and every check-in would pass. " +
      "Unset it (defaults to true) or run with NODE_ENV!=production."
  );
}

export default ENV;
