// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { PresetValidationError, validateDirectory, validatePreset } from "../validate.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRECTORY, "..");

async function load(name) {
  return JSON.parse(await readFile(path.join(ROOT, `${name}.preset.json`), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

test("validates every checked-in preset", async () => {
  const files = await validateDirectory(ROOT);

  assert.deepEqual(files, ["cockroach-browser.preset.json", "cockroach-crawler.preset.json"]);
});

test("pins Cockroach Browser RC1 and its read-only engine negotiation tools", async () => {
  const preset = await load("cockroach-browser");

  assert.equal(preset.dependency.versionRange, ">=0.5.0-rc.1 <0.6.0");
  assert.deepEqual(preset.capabilities.allowedTools.slice(0, 3), [
    "browser_capabilities",
    "browser_engines",
    "browser_engine_preflight"
  ]);
});

test("rejects implicit enablement", async () => {
  const preset = clone(await load("cockroach-browser"));
  preset.enabledByDefault = true;

  assert.throws(() => validatePreset(preset), /enabledByDefault must be false/);
});

test("rejects shell execution or command substitution", async () => {
  const preset = clone(await load("cockroach-browser"));
  preset.transport.shell = true;
  preset.transport.command = "sh";
  preset.transport.args = ["-c", "cockroach-browser mcp"];

  assert.throws(
    () => validatePreset(preset),
    error => error instanceof PresetValidationError
      && error.issues.includes("transport.shell must be false")
      && error.issues.includes("transport.command is not the reviewed executable")
  );
});

test("rejects credentials embedded in fixed environment", async () => {
  const preset = clone(await load("cockroach-crawler"));
  preset.environment.fixed.MODEL_API_KEY = "example-secret-value";

  assert.throws(() => validatePreset(preset), /may not contain credentials/);
});

test("rejects secret-shaped material anywhere in a preset", async () => {
  const preset = clone(await load("cockroach-crawler"));
  preset.summary = "credential sk-or-1234567890abcdefghijklmnop";

  assert.throws(() => validatePreset(preset), /contains secret-shaped material/);
});

test("rejects widened crawler process limits", async () => {
  const preset = clone(await load("cockroach-crawler"));
  preset.environment.fixed.COCKROACH_MAX_PAGES = "1000";
  preset.limits.maxConcurrentRequests = 20;

  assert.throws(
    () => validatePreset(preset),
    error => error instanceof PresetValidationError
      && error.issues.includes("environment.fixed does not match the reviewed preset contract")
      && error.issues.some(issue => issue.startsWith("limits.maxConcurrentRequests"))
  );
});

test("rejects undeclared MCP tools", async () => {
  const preset = clone(await load("cockroach-browser"));
  preset.capabilities.allowedTools.push("browser_dispatch_action");

  assert.throws(() => validatePreset(preset), /allowedTools does not match/);
});

test("rejects unreviewed license or source metadata", async () => {
  const preset = clone(await load("cockroach-browser"));
  preset.dependency.license = "MIT";
  preset.dependency.source = "https://example.com/not-upstream";

  assert.throws(() => validatePreset(preset), /dependency does not match/);
});

test("rejects secret references with inline values", async () => {
  const preset = clone(await load("cockroach-browser"));
  preset.environment.secretReferences[0].value = "not-allowed";

  assert.throws(() => validatePreset(preset), /secretReferences\[0\] keys must be exactly/);
});
