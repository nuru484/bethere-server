// src/docs/openapi.js
//
// Assembles the OpenAPI document from docs/openapi/.
//
// The spec is split by domain so a 90-endpoint API stays reviewable: one file
// per domain under paths/, one under components/. This module merges them into
// a single document, which means every $ref in the spec is internal
// (#/components/...) and nothing has to resolve external files at serve time.
//
// Merging is shallow by design and collisions throw rather than overwrite. Two
// files silently declaring the same path or the same schema name is exactly
// the kind of drift a split spec invites, so it fails loudly at boot instead
// of shipping a document missing whichever half lost.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(HERE, "../../docs/openapi");

const readYaml = (file) => {
  const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  // An empty or comment-only file parses to null; treat it as "contributes
  // nothing" rather than crashing the merge.
  return parsed ?? {};
};

const yamlFilesIn = (dir) =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => path.join(dir, name));

/**
 * Merges `{ key: value }` fragments from several files, refusing to let one
 * file overwrite another's key. `label` and `origins` exist only to make the
 * thrown message name both files involved.
 */
function mergeUnique(target, fragment, { file, label, origins }) {
  for (const [key, value] of Object.entries(fragment)) {
    if (key in target) {
      throw new Error(
        `OpenAPI ${label} "${key}" is declared twice: ` +
          `${path.basename(origins[key])} and ${path.basename(file)}`
      );
    }
    target[key] = value;
    origins[key] = file;
  }
  return target;
}

/** paths/*.yaml each hold a map of path -> path item. */
function loadPaths() {
  const paths = {};
  const origins = {};
  for (const file of yamlFilesIn(path.join(DOCS_DIR, "paths"))) {
    mergeUnique(paths, readYaml(file), { file, label: "path", origins });
  }
  return paths;
}

/**
 * components/*.yaml each hold a map of component type (schemas, responses,
 * parameters, ...) -> map of name -> definition. Merging is per type, so
 * common.yaml can own `responses` while a domain file adds `schemas`, and two
 * domains can both add schemas without colliding.
 */
function loadComponents() {
  const components = {};
  const origins = {};
  for (const file of yamlFilesIn(path.join(DOCS_DIR, "components"))) {
    for (const [type, entries] of Object.entries(readYaml(file))) {
      components[type] ??= {};
      origins[type] ??= {};
      mergeUnique(components[type], entries, {
        file,
        label: `components.${type}`,
        origins: origins[type],
      });
    }
  }
  return components;
}

export function buildOpenApiDocument() {
  const root = readYaml(path.join(DOCS_DIR, "openapi.yaml"));
  return { ...root, paths: loadPaths(), components: loadComponents() };
}

// Built once per process. The spec is static files on disk, and re-reading and
// re-merging them on every docs page view would be pure waste.
let cached;

export function getOpenApiDocument() {
  cached ??= buildOpenApiDocument();
  return cached;
}

export default getOpenApiDocument;
