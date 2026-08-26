# Fikeya efficiency benchmark foundation

This directory compares **already completed** baseline and Fikeya task-attempt receipts. It is intentionally offline and dependency-free.

It does not run an agent, prove that Fikeya is cheaper or better, or authorize a marketing claim. The checked-in fixtures are synthetic parser and arithmetic fixtures. They are not product evidence.

## What it rejects

The comparator fails closed when:

- either JSONL input is empty or malformed;
- a required measurement is absent, negative, or internally inconsistent;
- the files contain duplicate task/trial pairs;
- either arm is missing a matching task/trial pair;
- the task prompt, starting state, grader, model, pricing snapshot, tool contract, environment, network policy, or execution limits differ between a pair.

The agent name, version, and agent-specific configuration hash are recorded but deliberately differ between arms. They describe the intervention being compared.

## Receipt contract

[`receipt.schema.json`](./receipt.schema.json) documents one task attempt. A `.jsonl` input contains one object per non-empty line.

Important fields:

- `task.*` pins the suite, task, trial, prompt, starting state, and grader.
- `model.*` pins provider, model/API version, reasoning effort, temperature, and output limit.
- `conditions.*` pins the externally visible tool contract and network allowlist.
- `environment.*` pins the image, OS, architecture, and network policy.
- `limits.*` pins time, turns, tool calls, and retries.
- `pricing.*` records a dated USD price snapshot used for both arms.
- `outcome.*` records an externally graded result.
- `usage.*` records billed tokens and explicit non-token tool fees.
- `timing.durationMs` records end-to-end wall time.

`reasoningTokens` is recorded as a diagnostic subset of `outputTokens`; it is not billed twice.

## Metrics and formulas

Each receipt is one independently graded task attempt. `verifiedSolveRate` is verified attempts divided by all attempts. When repeated trials are used, the `trial` number keeps pairing deterministic.

```text
run cost =
  uncached input tokens × uncached input rate / 1,000,000
  + cached input tokens × cached input rate / 1,000,000
  + output tokens × output rate / 1,000,000
  + explicit tool fees

cost per verified task = total cost across every attempt / verified attempts
```

Failed attempts remain in total cost. If an arm solves zero tasks, `costPerVerifiedTaskUsd` is `null`, because the value is mathematically undefined.

Latency p50 and p95 use linear interpolation at position `(n - 1) × probability` after sorting durations.

## Run the offline checks

From this directory:

```powershell
npm test
npm run compare:fixtures
```

Or invoke the comparator directly:

```powershell
node compare.mjs --baseline path\to\baseline.jsonl --fikeya path\to\fikeya.jsonl
```

A valid comparison prints a JSON report to standard output. Any incomplete or unmatched comparison exits non-zero and prints a rejection reason to standard error.

To display a valid aggregate in Fikeya's local Usage view, write the comparator output to the initialized workspace without committing it:

```powershell
node compare.mjs --baseline path\to\baseline.jsonl --fikeya path\to\fikeya.jsonl > path\to\workspace\.fikeya\matched-efficiency.json
fikeya stats --workspace path\to\workspace --json
```

The runtime revalidates the bounded aggregate, computes its SHA-256 receipt, and rejects malformed or unmatched reports. Raw task receipts remain outside the workspace dashboard.

## Before a real benchmark

Pre-register the task list, trial count, model/version, prices, limits, tool contract, network policy, grader, and primary metric. Preserve the raw receipts and grader outputs. Do not replace these synthetic fixtures with real results; store real runs outside the source tree or in a separately reviewed evidence package.
