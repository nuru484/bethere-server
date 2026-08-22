// scripts/audit-gate.mjs
//
// CI gate over `npm audit --omit=dev --json`: fails on any HIGH/CRITICAL
// advisory in a production dependency EXCEPT the explicitly allowlisted ones
// below. npm audit has no native ignore mechanism, so this thin wrapper is
// the documented escape hatch for advisories that provably cannot apply to
// this app. Keep the list short and every entry justified.
import { execFile } from "node:child_process";

// GHSA id -> why it is acceptable to ship with.
//
// Empty, and that is the goal state. The brace-expansion DoS advisories are
// covered by the maintenance releases 1.1.18 and 2.1.4, pinned per major line
// in the package.json overrides. Prefer a same-major patch over an entry here:
// the cross-major 5.0.8 changes the CommonJS export shape and breaks the older
// minimatch versions in the ejs and exceljs chains.
const ALLOWLIST = {};

const FAIL_SEVERITIES = new Set(["high", "critical"]);

const audit = () =>
  new Promise((resolve) => {
    execFile(
      "npm",
      ["audit", "--omit=dev", "--json"],
      { maxBuffer: 32 * 1024 * 1024 },
      // npm audit exits non-zero when advisories exist; the JSON body is
      // still the report, so only a missing/unparsable body is fatal.
      (_error, stdout) => resolve(stdout)
    );
  });

const out = await audit();
let report;
try {
  report = JSON.parse(out);
} catch {
  console.error("audit-gate: could not parse `npm audit --json` output");
  process.exit(1);
}

const failures = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (!FAIL_SEVERITIES.has(vuln.severity)) continue;

  // Direct advisories on this package (transitive chains appear as strings).
  const advisories = (vuln.via ?? []).filter((v) => typeof v === "object");
  const blocking = advisories.filter((a) => {
    const id = (a.url ?? "").split("/").pop();
    return !ALLOWLIST[id];
  });

  // A package flagged only through allowlisted advisories (directly or via a
  // dependency chain that itself ends in allowlisted advisories) passes.
  if (blocking.length > 0) {
    failures.push({ name, severity: vuln.severity, blocking });
    continue;
  }
  if (advisories.length === 0) {
    // Purely transitive: fails only if some root advisory in the tree is not
    // allowlisted; those roots are reported on their own package entries, so
    // nothing to do here.
    continue;
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`audit-gate: ${f.severity} advisory in ${f.name}:`);
    for (const a of f.blocking) console.error(`  - ${a.title} (${a.url})`);
  }
  process.exit(1);
}

const allowed = Object.keys(ALLOWLIST).length;
console.log(
  `audit-gate: OK (no non-allowlisted high/critical production advisories; allowlist size ${allowed})`
);
