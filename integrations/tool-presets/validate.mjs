#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TOP_LEVEL_KEYS = [
  "$schema",
  "schemaVersion",
  "id",
  "displayName",
  "summary",
  "enabledByDefault",
  "enablement",
  "transport",
  "dependency",
  "capabilities",
  "environment",
  "limits",
  "upstreamPolicyRequirements"
];
const LIMIT_BOUNDS = {
  startupTimeoutMs: [100, 30_000],
  requestTimeoutMs: [100, 120_000],
  shutdownTimeoutMs: [100, 30_000],
  maxConcurrentRequests: [1, 4],
  maxRequestsPerSession: [1, 500],
  maxSessionDurationMs: [1_000, 3_600_000],
  maxRequestBytes: [1_024, 8 * 1_024 * 1_024],
  maxResponseBytes: [1_024, 8 * 1_024 * 1_024]
};
const SECRET_VALUE_PATTERN = /(?:sk-(?:or-)?[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;
const SECRET_NAME_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;

const CONTRACTS = {
  "cockroach-browser": {
    command: "cockroach-browser",
    args: ["mcp"],
    dependency: {
      package: "cockroach-browser",
      versionRange: ">=0.4.1 <0.5.0",
      license: "AGPL-3.0-or-later",
      source: "https://github.com/AjnasNB/cockroach-browser",
      homepage: "https://cockroachbrowser.com"
    },
    effect: "read-and-propose",
    tools: [
      "browser_capabilities",
      "browser_health",
      "browser_sessions",
      "browser_snapshot",
      "browser_capture",
      "browser_network",
      "browser_audit",
      "browser_propose_action"
    ],
    fixedEnvironment: {},
    configuration: [
      {
        name: "COCKROACH_BROWSER_URL",
        required: false,
        format: "http-or-https-url-without-credentials"
      }
    ],
    secretReferences: [
      {
        name: "COCKROACH_BROWSER_TOKEN",
        required: true,
        source: "os-credential-store"
      }
    ]
  },
  "cockroach-crawler": {
    command: "cockroach-mcp",
    args: [],
    dependency: {
      package: "cockroach-crawler",
      versionRange: ">=0.7.0 <0.8.0",
      license: "MIT",
      source: "https://github.com/AjnasNB/cockroach-crawler",
      homepage: "https://cockroachcrawler.com"
    },
    effect: "read-only",
    tools: [
      "crawl",
      "map_site",
      "select",
      "find_similar",
      "relocate_element",
      "crawl_spider",
      "export_records",
      "extract_structured"
    ],
    fixedEnvironment: {
      COCKROACH_MAX_PAGES: "10",
      COCKROACH_MAX_DEPTH: "1",
      COCKROACH_MAX_REQUESTS: "50",
      COCKROACH_MAX_DURATION_MS: "60000"
    },
    configuration: [
      {
        name: "COCKROACH_ALLOWED_ORIGINS",
        required: true,
        format: "comma-separated-http-origins-without-credentials-or-paths"
      }
    ],
    secretReferences: []
  }
};

export class PresetValidationError extends Error {
  constructor(label, issues) {
    super(`${label} is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "PresetValidationError";
    this.issues = issues;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, location, issues) {
  if (!isRecord(value)) {
    issues.push(`${location} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    issues.push(`${location} keys must be exactly: ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function exactJson(actual, expected, location, issues) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    issues.push(`${location} does not match the reviewed preset contract`);
  }
}

function validateUrl(value, location, issues) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      issues.push(`${location} must be an HTTPS URL without embedded credentials`);
    }
  } catch {
    issues.push(`${location} must be a valid URL`);
  }
}

function scanSecretValues(value, location, issues) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) {
      issues.push(`${location} contains secret-shaped material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecretValues(entry, `${location}[${index}]`, issues));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => scanSecretValues(entry, `${location}.${key}`, issues));
  }
}

function validateEnvironmentEntry(entry, location, issues, secret) {
  const keys = secret ? ["name", "required", "source"] : ["name", "required", "format"];
  if (!exactKeys(entry, keys, location, issues)) return;
  if (!ENVIRONMENT_NAME_PATTERN.test(entry.name)) {
    issues.push(`${location}.name must be an uppercase environment variable name`);
  }
  if (typeof entry.required !== "boolean") {
    issues.push(`${location}.required must be boolean`);
  }
  if (secret) {
    if (!['os-credential-store', 'session-secret'].includes(entry.source)) {
      issues.push(`${location}.source must reference an approved secret store`);
    }
  } else if (typeof entry.format !== "string" || entry.format.length === 0) {
    issues.push(`${location}.format must be a non-empty string`);
  }
}

export function validatePreset(preset, label = "preset") {
  const issues = [];
  if (!exactKeys(preset, TOP_LEVEL_KEYS, "preset", issues)) {
    throw new PresetValidationError(label, issues);
  }
  const contract = CONTRACTS[preset.id];
  if (!contract) {
    issues.push("id is not a reviewed external tool preset");
  }
  if (preset.$schema !== "./preset.schema.json") issues.push("$schema must reference the local schema");
  if (preset.schemaVersion !== "fikeya.tool-preset.v1") issues.push("schemaVersion is unsupported");
  if (preset.enabledByDefault !== false) issues.push("enabledByDefault must be false");
  if (typeof preset.displayName !== "string" || preset.displayName.length < 1 || preset.displayName.length > 80) {
    issues.push("displayName must contain 1 to 80 characters");
  }
  if (typeof preset.summary !== "string" || preset.summary.length < 1 || preset.summary.length > 240) {
    issues.push("summary must contain 1 to 240 characters");
  }

  if (exactKeys(preset.enablement, ["mode", "scope", "confirmation"], "enablement", issues)) {
    if (preset.enablement.mode !== "explicit-user") issues.push("enablement.mode must be explicit-user");
    if (preset.enablement.scope !== "workspace") issues.push("enablement.scope must be workspace");
    if (preset.enablement.confirmation !== "required") issues.push("enablement.confirmation must be required");
  }

  if (exactKeys(preset.transport, ["type", "command", "args", "shell"], "transport", issues)) {
    if (preset.transport.type !== "stdio") issues.push("transport.type must be stdio");
    if (preset.transport.shell !== false) issues.push("transport.shell must be false");
    if (contract) {
      if (preset.transport.command !== contract.command) issues.push("transport.command is not the reviewed executable");
      exactJson(preset.transport.args, contract.args, "transport.args", issues);
    }
  }

  if (exactKeys(preset.dependency, ["package", "versionRange", "license", "source", "homepage"], "dependency", issues)) {
    validateUrl(preset.dependency.source, "dependency.source", issues);
    validateUrl(preset.dependency.homepage, "dependency.homepage", issues);
    if (contract) exactJson(preset.dependency, contract.dependency, "dependency", issues);
  }

  if (exactKeys(preset.capabilities, ["effect", "allowedTools", "deniedCapabilities"], "capabilities", issues)) {
    if (!Array.isArray(preset.capabilities.allowedTools) || preset.capabilities.allowedTools.length === 0) {
      issues.push("capabilities.allowedTools must be a non-empty array");
    } else {
      if (new Set(preset.capabilities.allowedTools).size !== preset.capabilities.allowedTools.length) {
        issues.push("capabilities.allowedTools must not contain duplicates");
      }
      if (contract) exactJson(preset.capabilities.allowedTools, contract.tools, "capabilities.allowedTools", issues);
    }
    if (!Array.isArray(preset.capabilities.deniedCapabilities) || preset.capabilities.deniedCapabilities.length === 0) {
      issues.push("capabilities.deniedCapabilities must be a non-empty array");
    }
    if (contract && preset.capabilities.effect !== contract.effect) {
      issues.push("capabilities.effect does not match the reviewed tool effect");
    }
  }

  if (exactKeys(preset.environment, ["fixed", "configuration", "secretReferences"], "environment", issues)) {
    if (!isRecord(preset.environment.fixed)) {
      issues.push("environment.fixed must be an object");
    } else {
      for (const [name, value] of Object.entries(preset.environment.fixed)) {
        if (!ENVIRONMENT_NAME_PATTERN.test(name)) issues.push(`environment.fixed.${name} has an invalid name`);
        if (SECRET_NAME_PATTERN.test(name)) issues.push(`environment.fixed.${name} may not contain credentials`);
        if (typeof value !== "string") issues.push(`environment.fixed.${name} must be a string`);
      }
      if (contract) exactJson(preset.environment.fixed, contract.fixedEnvironment, "environment.fixed", issues);
    }
    if (!Array.isArray(preset.environment.configuration)) {
      issues.push("environment.configuration must be an array");
    } else {
      preset.environment.configuration.forEach((entry, index) =>
        validateEnvironmentEntry(entry, `environment.configuration[${index}]`, issues, false));
      if (contract) exactJson(preset.environment.configuration, contract.configuration, "environment.configuration", issues);
    }
    if (!Array.isArray(preset.environment.secretReferences)) {
      issues.push("environment.secretReferences must be an array");
    } else {
      preset.environment.secretReferences.forEach((entry, index) =>
        validateEnvironmentEntry(entry, `environment.secretReferences[${index}]`, issues, true));
      if (contract) exactJson(preset.environment.secretReferences, contract.secretReferences, "environment.secretReferences", issues);
    }
  }

  if (exactKeys(preset.limits, Object.keys(LIMIT_BOUNDS), "limits", issues)) {
    for (const [name, [minimum, maximum]] of Object.entries(LIMIT_BOUNDS)) {
      const value = preset.limits[name];
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        issues.push(`limits.${name} must be an integer from ${minimum} to ${maximum}`);
      }
    }
  }
  if (!Array.isArray(preset.upstreamPolicyRequirements) || preset.upstreamPolicyRequirements.length === 0) {
    issues.push("upstreamPolicyRequirements must be a non-empty array");
  }

  scanSecretValues(preset, "preset", issues);
  if (issues.length) throw new PresetValidationError(label, issues);
  return preset;
}

export async function readPreset(file) {
  const text = await readFile(file, "utf8");
  let preset;
  try {
    preset = JSON.parse(text);
  } catch (error) {
    throw new PresetValidationError(path.basename(file), [`invalid JSON: ${error.message}`]);
  }
  return validatePreset(preset, path.basename(file));
}

export async function validateDirectory(directory = DIRECTORY) {
  const files = (await readdir(directory))
    .filter(file => file.endsWith(".preset.json"))
    .sort();
  if (files.length === 0) throw new PresetValidationError(directory, ["no preset files found"]);
  const presets = [];
  for (const file of files) presets.push(await readPreset(path.join(directory, file)));
  const ids = presets.map(preset => preset.id);
  if (new Set(ids).size !== ids.length) throw new PresetValidationError(directory, ["preset ids must be unique"]);
  return files;
}

async function main() {
  const files = await validateDirectory();
  for (const file of files) process.stdout.write(`[ok] ${file}\n`);
  process.stdout.write(`[ok] ${files.length} disabled-by-default external tool presets validated\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
