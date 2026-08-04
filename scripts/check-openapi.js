// scripts/check-openapi.js
//
// CI gate for the API reference. Two checks, both of which have to pass:
//
//   1. The assembled document is valid OpenAPI 3.1.
//   2. It describes exactly the routes the app actually mounts.
//
// The second check is the one that matters over time. A spec split across a
// dozen files is easy to write and easy to forget, and hand-maintained docs
// rot silently: the endpoint ships, nobody touches the YAML, and the reference
// quietly starts lying. Walking the live Express router and diffing it against
// the spec turns that from something a reviewer might notice into something
// the build refuses to let through.
//
// Run: npm run docs:check
import process from "node:process";
import { validate } from "@readme/openapi-parser";

// The app validates its environment at import time, and this script only needs
// the router tree, never a live connection. Placeholders keep the check
// runnable in CI without handing it production secrets.
const PLACEHOLDER_ENV = {
  ACCESS_TOKEN_SECRET: "openapi-check-placeholder",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_FIRSTNAME: "Check",
  ADMIN_LASTNAME: "Placeholder",
  ADMIN_PASSWORD: "Placeholder1",
  CLOUDINARY_API_KEY: "placeholder",
  CLOUDINARY_API_SECRET: "placeholder",
  CLOUDINARY_CLOUD_NAME: "placeholder",
  DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  // A syntactically valid 32-byte key. It never encrypts anything here; the
  // env module simply refuses to load without one.
  FACE_TEMPLATE_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  FRONTEND_URL: "http://localhost:5173",
  GMAIL_PASSWORD: "placeholder",
  GMAIL_USER: "placeholder@example.com",
  REDIS_URL: "redis://localhost:6379",
  REFRESH_TOKEN_SECRET: "openapi-check-placeholder",
  SMTP_HOST: "smtp.example.com",
};
for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[key] ??= value;
}
process.env.NODE_ENV ??= "test";

const { default: app } = await import("../app.js");
const { buildOpenApiDocument } = await import("../src/docs/openapi.js");

// The docs endpoints describe the API rather than being part of it, so they
// are intentionally absent from the spec and must not read as drift.
const IGNORED_PREFIXES = ["/api/docs"];

/**
 * Recovers a router's mount path from the regexp Express compiled it into.
 * `router.use("/auth", r)` produces /^\/auth\/?(?=\/|$)/, so everything before
 * the trailing optional-slash lookahead is the literal prefix.
 */
function mountPrefix(layer) {
  if (layer.regexp?.fast_slash) return "";
  const source = layer.regexp?.source ?? "";
  const end = source.indexOf("\\/?(?=");
  if (end === -1) return null;
  return source.slice(1, end).replace(/\\(.)/g, "$1");
}

/**
 * Express writes params as `:id`; OpenAPI writes them as `{id}`.
 *
 * A route registered at "/" on a mounted sub-router concatenates into
 * "/api/v1/users/", which Express serves at "/api/v1/users" too. The trailing
 * slash is an artifact of how the tree is assembled, not a second endpoint, so
 * it is dropped before comparing.
 */
const toOpenApiPath = (path) =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/(.)\/$/, "$1");

/** Every `METHOD path` the app actually serves. */
function mountedOperations(router, prefix = "", found = new Set()) {
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const path = toOpenApiPath(prefix + layer.route.path) || "/";
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        // Express registers an implicit HEAD alongside every GET.
        if (enabled && method !== "_all" && method !== "head") {
          found.add(`${method.toUpperCase()} ${path}`);
        }
      }
      continue;
    }
    if (layer.handle?.stack) {
      const nested = mountPrefix(layer);
      if (nested === null) {
        throw new Error(
          `Could not read the mount path of a nested router from ${layer.regexp}. ` +
            `The route walker needs updating before this check can be trusted.`
        );
      }
      mountedOperations(layer.handle, prefix + nested, found);
    }
  }
  return found;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "trace"];

/** Every `METHOD path` the spec claims exists. */
function documentedOperations(document) {
  const found = new Set();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) {
        found.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return found;
}

/**
 * operationId is what client generators turn into function names, so a
 * duplicate silently produces one method that shadows another. The spec is
 * written across a dozen files by different hands, which is exactly the
 * situation where two domains reach for the same obvious name.
 */
function duplicateOperationIds(document) {
  const seen = new Map();
  const duplicates = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const id = operation?.operationId;
      if (!id) {
        duplicates.push(`${method.toUpperCase()} ${path} has no operationId`);
        continue;
      }
      if (seen.has(id)) {
        duplicates.push(`"${id}" used by both ${seen.get(id)} and ${method.toUpperCase()} ${path}`);
      } else {
        seen.set(id, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return duplicates;
}

const ignored = (operation) =>
  IGNORED_PREFIXES.some((prefix) => operation.split(" ")[1].startsWith(prefix));

function reportGroup(title, items) {
  if (items.length === 0) return false;
  console.error(`\n${title}`);
  for (const item of items.sort()) console.error(`  ${item}`);
  return true;
}

const document = buildOpenApiDocument();

// validate() dereferences in place, so it gets a copy: the served document
// keeps its $refs, which is what makes the rendered page navigable.
const result = await validate(structuredClone(document));
if (!result.valid) {
  console.error("OpenAPI document is not valid:\n");
  console.error(result.errors ?? result);
  process.exit(1);
}

const mounted = [...mountedOperations(app._router ?? app.router)].filter(
  (operation) => !ignored(operation)
);
const documented = [...documentedOperations(document)];

const undocumented = mounted.filter((operation) => !documented.includes(operation));
const phantom = documented.filter((operation) => !mounted.includes(operation));

const failedIds = reportGroup(
  "operationId problems (each operation needs one, and it must be unique):",
  duplicateOperationIds(document)
);
const failedUndocumented = reportGroup(
  "Mounted but missing from the spec (add them to docs/openapi/paths/):",
  undocumented
);
const failedPhantom = reportGroup(
  "In the spec but not mounted by the app (stale, or a typo in the path):",
  phantom
);

if (failedIds || failedUndocumented || failedPhantom) {
  console.error(
    `\n${mounted.length} routes mounted, ${documented.length} documented, ` +
      `${undocumented.length} undocumented, ${phantom.length} stale.`
  );
  process.exit(1);
}

console.log(
  `OpenAPI 3.1 document is valid and covers all ${mounted.length} mounted routes.`
);

// Importing the app constructs the Prisma client and the Redis connection,
// and those keep handles open even though this check never issues a query.
// Without an explicit exit the process sits idle until CI's job timeout kills
// it, turning a passing check into a red build.
process.exit(0);
