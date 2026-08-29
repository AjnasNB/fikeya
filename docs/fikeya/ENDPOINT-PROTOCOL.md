# Fikeya managed endpoint protocol

Fikeya exposes a strict, single-request command-line boundary for a controller
that needs to run one bounded coding-agent turn without receiving prompts,
answers, file contents, tool output, or credentials in the result. The execution
protocol is `maqam.endpoint-harness.v2`.

The boundary is intentionally fail-closed. It accepts one exact JSON object,
binds an expiring one-use authorization to the complete run scope, resolves an
exact local provider profile and workspace, and lets the existing Fikeya tool
broker execute only explicitly listed workspace capabilities. It does not add a
shell, process, browser, or MCP capability.

## Commands

Run the process with its current working directory set to the exact workspace
directory named by the request.

```console
fikeya endpoint version --protocol maqam.endpoint-harness.v2 --json
fikeya endpoint execute --protocol maqam.endpoint-harness.v2 --json < request.json
```

`version` returns one `maqam.endpoint-runtime.v1` discovery envelope containing
`name: "fikeya"` and the installed runtime version. The discovery-envelope
schema is independent of the v2 execution protocol. Any other execution
protocol value is rejected; there is no protocol downgrade or fallback.

`execute` reads at most 1,048,576 bytes from standard input. The input must be
one strict UTF-8 JSON object with no duplicate keys, non-finite numbers, or
unpaired Unicode surrogates.
An accepted execution writes one succeeded, failed, or cancelled JSON result
object to standard output.

## Canonical JSON and hashes

Protocol hashes use lowercase SHA-256 prefixed with `sha256:`. Their input is
UTF-8 canonical JSON with object keys sorted lexicographically, arrays kept in
their supplied order, no insignificant whitespace, and only finite JSON values.
All numeric request fields are integers.

- `authorization.scopeSha256` is the hash of the canonical request after
  removing the top-level `authorization` field.
- `requestSha256` is the hash of the complete canonical request, including
  `authorization`.
- `outcomeSha256` is the hash of the complete canonical result after removing
  the top-level `outcomeSha256` field.
- `provider.profileSha256` is the hash of the configured local provider's
  canonical non-secret metadata object: `apiMode`, `apiVersion`, `baseUrl`,
  `credentialType`, `kind`, `model`, `name`, `organization`, and `secretRef`.
  `secretRef` is an opaque OS-keyring reference, never the credential value.

The controller must hash the normalized object it actually sends. It must not
hash a template and then mutate a limit, model, prompt, path, capability, memory
setting, network setting, identifier, or authorization expiry.

## Request

The request schema is `maqam.endpoint-harness-request.v2`. Every object uses
exact fields: an unknown or missing field rejects the request.

| Field | Required value |
| --- | --- |
| `schema` | `maqam.endpoint-harness-request.v2` |
| `tenantId` | UUID |
| `endpointId` | UUID |
| `commandId` | UUID |
| `runId` | UUID |
| `toolCallId` | Non-empty UTF-8 string, at most 256 bytes |
| `authorization` | Exact authorization object described below |
| `access` | `read` or `write` |
| `prompt` | Non-empty UTF-8 string, at most 256 KiB |
| `workingDirectory` | Existing absolute directory, at most 4,096 UTF-8 bytes |
| `provider` | Exact provider object described below |
| `limits` | Exact limits object described below |
| `capabilities` | Exact capabilities object described below |
| `memory` | Exact memory object described below |
| `allowNetwork` | Boolean |

The exact nested objects are:

```json
{
  "authorization": {
    "decision": "allow",
    "approvalId": "one-use-controller-reference",
    "expiresAt": "2026-08-29T12:00:00.000Z",
    "scopeSha256": "sha256:<64 lowercase hexadecimal characters>"
  },
  "provider": {
    "profileName": "configured-profile-name",
    "profileSha256": "sha256:<64 lowercase hexadecimal characters>",
    "model": "exact-configured-model"
  },
  "limits": {
    "timeoutMs": 300000,
    "maxOutputTokens": 8192,
    "maxSteps": 32,
    "maxToolCalls": 24
  },
  "capabilities": {
    "allowedTools": [
      "workspace.list_files",
      "workspace.read_file",
      "workspace.search_text"
    ]
  },
  "memory": {
    "mode": "auto",
    "contextMaxCharacters": 12000,
    "rebuild": false,
    "adapter": {
      "kind": "qarinah-node-sidecar",
      "nodeExecutable": "/canonical/path/to/node",
      "nodeSha256": "sha256:<64 lowercase hexadecimal characters>",
      "sidecarPath": "/canonical/path/to/qarinah-sidecar.mjs",
      "sidecarSha256": "sha256:<64 lowercase hexadecimal characters>",
      "packageJsonPath": "/canonical/path/to/qarinah-artifact/package.json",
      "packageJsonSha256": "sha256:<64 lowercase hexadecimal characters>",
      "artifactRoot": "/canonical/path/to/qarinah-artifact",
      "artifactSha256": "sha256:<64 lowercase hexadecimal characters>",
      "version": "registered-version"
    }
  }
}
```

The fragment illustrates nested shapes; it is not a complete request and its
digest placeholders are not valid wire values.

### Authorization

`decision` must be `allow`. `approvalId` is non-empty and at most 256 UTF-8
bytes. `expiresAt` uses exactly `YYYY-MM-DDTHH:MM:SS(.1-6)?Z` and must remain in
the future. Offsets, a space separator, comma fractions, and more than six
fractional digits are rejected. `scopeSha256` must match the exact scope hash.

Fikeya consumes `approvalId` atomically before the agent starts. Reuse is
rejected. Scope, expiry, provider identity, capability membership, and the tool
call ceiling are rechecked at each internal approval boundary. Scope, expiry,
and provider identity are checked again before any final success is accepted.
The expiry boundary is exclusive: authorization is invalid when current UTC
time equals `expiresAt`. A controller should therefore issue an expiry covering
dispatch time, `timeoutMs`, and its settlement grace. The whole-run
authorization does not become blanket tool approval: each proposed tool call
receives a distinct one-use decision only when its tool name is in
`allowedTools` and the call count remains below `maxToolCalls`.

### Provider binding

`profileName` is at most 128 UTF-8 bytes and `model` is at most 256 UTF-8 bytes.
The named provider must already exist in the endpoint's local Fikeya
configuration. Its configured model and complete non-secret metadata digest
must exactly match the request. Fikeya repeats that check before internal tool
approval, so a profile changed during a run fails closed. Provider credentials
remain in the local OS credential mechanism and never cross this protocol.
`fikeya provider list --json` returns `profileSha256` for each configured
profile, so a controller does not need to reconstruct metadata or access a
credential in order to bind this field.

### Limits and memory

| Limit | Range |
| --- | --- |
| `timeoutMs` | 1 to 900,000 |
| `maxOutputTokens` | 1 to 32,768 |
| `maxSteps` | 1 to 64 |
| `maxToolCalls` | 0 to 128 |
| `memory.contextMaxCharacters` | 512 to 64,000 |

`maxToolCalls` must be zero exactly when `allowedTools` is empty. A non-empty
allowlist requires a positive ceiling. `memory.mode` is `auto`, `off`, or
`required`; `required` fails rather than running without the requested bounded
Qarinah context.

Managed memory never discovers Qarinah or Node from `PATH`. For `off`,
`memory.adapter` is null. For `auto` or `required`, the controller binds the
canonical Node executable, production sidecar, package manifest, and complete
sidecar artifact tree with their exact SHA-256 values. The package manifest
must identify `@fikeya/qarinah-sidecar` and its exact pinned Qarinah version.
Fikeya invokes the bound Node and sidecar directly with `shell=false`, checks
the `runtime.version` identity before consuming authorization, and rechecks the
files and tree after retrieval and after the run. `memory.rebuild` must be
false. Managed `memory.prepare` also forces `updateCheckpoint:false`, so it
never repairs or rewrites `.qarinah`; `required` fails closed on unavailable or
stale state and `auto` records unavailable memory.

Release packages include `fikeya-qarinah-sidecar-<version>.zip`. Its external
`qarinah-sidecar-binding.json` records the content-free artifact manifest,
digests, package identity, protocol, and Node engine range. Operators bind the
exact deployment Node executable separately because the runtime binary is not
embedded in that archive.

`maxOutputTokens` applies to each provider call in the bounded multi-step run;
it is not an aggregate whole-run token budget. `maxSteps`, `maxToolCalls`, and
`timeoutMs` are whole-run ceilings.

`allowNetwork` controls provider network permission for this run. It does not
add browser, crawler, process, shell, or MCP tools to the endpoint capability
set.

### Path binding

`workingDirectory` must resolve to an existing absolute directory and must
match the endpoint process's resolved current working directory. Fikeya must be
initialized there, and the resolved directory must remain inside that
workspace's root. Its supplied spelling must already be lexically normalized;
dot segments, duplicate separators, surrounding whitespace, and link aliases
are rejected before request hashing. This prevents a controller request from
selecting a different checkout, worktree, or path after process launch.

## Capabilities

`allowedTools` is a sorted, unique array. `read` access permits only:

- `workspace.list_files`
- `workspace.read_file`
- `workspace.search_text`

`write` access permits those three tools plus:

- `workspace.replace_text`
- `workspace.write_file`

The v2 endpoint deliberately excludes `process.run`, browser automation,
external tool presets, MCP tools, raw shell strings, and arbitrary executable
access. A capability outside the access-level set rejects the request. A model
that proposes an unlisted tool receives a denial and the run settles as failed,
even if it later produces an answer.

## Result and usage

The result schema is `maqam.endpoint-harness-result.v2` and contains exactly:

```json
{
  "schema": "maqam.endpoint-harness-result.v2",
  "status": "succeeded",
  "errorCode": null,
  "sessionId": "ses_endpoint_...",
  "requestSha256": "sha256:<64 lowercase hexadecimal characters>",
  "outcomeSha256": "sha256:<64 lowercase hexadecimal characters>",
  "provider": "configured-profile-name",
  "model": "exact-configured-model",
  "effects": {
    "measurement": "local-receipt-chain",
    "complete": true,
    "receiptSha256": "sha256:<64 lowercase hexadecimal characters>",
    "toolCallCount": 1,
    "writeCount": 0
  },
  "memory": {
    "mode": "off",
    "status": "off",
    "complete": true,
    "receiptId": null,
    "responseSha256": null,
    "evidenceCount": 0
  },
  "usage": {
    "measurement": "provider-reported",
    "complete": true,
    "inputTokens": 1200,
    "cachedInputTokens": 200,
    "outputTokens": 350,
    "reasoningTokens": null,
    "costMicros": null,
    "currency": null
  }
}
```

`status` is `succeeded`, `failed`, or `cancelled`. `errorCode` is null exactly
for `succeeded` and is a bounded machine code for every other status. The
provider and model report the exact local selection. The two hashes let a
controller correlate the result to the complete request and verify the complete
outcome envelope.

`effects.measurement: "local-receipt-chain"` binds the ordered local tool
receipts to `receiptSha256`. The digest input is stable canonical JSON of
`{"schema":"maqam.endpoint-effect-chain.v1","receipts":[...]}`. Each receipt
contains exactly `argumentsSha256`, `callId`,
`outputSha256`, `status`, and `tool`; neither arguments nor output bodies enter
the wire. Counts are derived from that same array, with `writeCount` covering
successful `workspace.write_file` and `workspace.replace_text` receipts. A
successful no-tool run uses the deterministic digest
`sha256:29ca707cbd81c124eaa849d792efe7aa8c2e1c1a875b689c87d100c42fbc43dd`,
counts zero, and `complete: true`.
Failure or cancellation uses a complete partial local chain when the runtime
returned one, otherwise `measurement: "unavailable"`, `complete: false`, and
null digest/counts. This proves Fikeya's local receipt chain. It is not an
independent attestation that an external system observed an effect.

`memory` records only content-free retrieval provenance. Memory-off runs use
the exact `off` object shown above. A used `auto` or `required` retrieval has
`status: "used"`, `complete: true`, a bounded receipt identifier, the Qarinah
response digest, and a non-negative evidence count. An optional retrieval that
cannot run reports `status: "unavailable"`, `complete: false`, and null receipt,
digest, and count. A successful `required` run must report a complete used
receipt. The memory object is part of `outcomeSha256`; no retrieved content is
returned.

Usage is never inferred. `measurement: "provider-reported"` means the provider
supplied validated non-negative token counts; the current runtime returns
`complete: true` with input, cached-input, and output counts. Reasoning tokens,
cost, and currency remain null when the provider/runtime did not report them.
`measurement: "unavailable"` requires `complete: false` and every numeric and
currency field to be null. A controller must never reinterpret unavailable
usage as zero.

No prompt, response, file content, raw tool arguments, tool output, credential,
exception text, or Qarinah context body appears in this envelope.

## Rejection and settled failure

Schema, UTF-8, size, path, workspace, authorization, replay, or provider-binding
errors happen before agent execution. The CLI rejects them with a non-zero exit
and a safe generic JSON error; it does not fabricate a v2 result or usage
receipt. A controller must treat that as a rejected command, not a completed
run.

After authorization is consumed and execution starts, operational outcomes are
settled in a content-free v2 result. The current runtime emits these machine
codes:

| Status | Error code | Meaning |
| --- | --- | --- |
| `cancelled` | `FIKEYA_TIMEOUT` | Wall-clock limit elapsed |
| `cancelled` | `FIKEYA_CANCELLED` | Cooperative or caller cancellation |
| `failed` | `FIKEYA_RUNTIME_FAILED` | Runtime failed without disclosing internals |
| `failed` | `FIKEYA_CAPABILITY_DENIED` | An unlisted or excess tool call was proposed |
| `failed` | `FIKEYA_LIMIT_EXCEEDED` | Step or tool-call ceiling was exceeded |
| `failed` | `FIKEYA_AUTHORIZATION_EXPIRED` | Whole-run authorization expired after execution started |
| `failed` | `FIKEYA_AGENT_FAILED` | The bounded agent did not complete |
| `failed` | `FIKEYA_USAGE_INVALID` | Reported usage was malformed or contradictory |

A failed or cancelled result can contain valid provider-reported usage that was
observed before failure. Otherwise it uses the unavailable/null form. Result
status and hash verification, not process exit alone, determine settlement.

## Controller checklist

1. Launch the exact reviewed Fikeya artifact in the intended workspace.
2. Verify support for `maqam.endpoint-harness.v2` with `endpoint version`.
3. Select an existing local provider profile and bind its exact model and
   non-secret metadata digest.
4. Normalize the complete request scope, choose the minimum sorted tool set and
   limits, then calculate `scopeSha256`.
5. Add a fresh, expiring, one-use authorization and calculate the complete
   request hash for later correlation.
6. Send one request on stdin and close stdin.
7. Distinguish pre-start rejection from a settled v2 result.
8. Verify `requestSha256` and `outcomeSha256`, retain the status/error code, and
   preserve unavailable usage as unavailable.

The versioned cross-language canonicalization fixture is
`fikeya-runtime/tests/fixtures/endpoint-v2-conformance.json`. It contains one
content-free valid request/result hash pair and named invalid expiry, path, and
identity cases for controller CI.
