# Fikeya External Tool Presets

This directory contains reviewed Model Context Protocol presets for separately installed command-line tools. A preset is configuration data, not bundled tool code. Fikeya does not install, fork, relicense, or silently start either external package.

The checked-in presets are disabled by default. A Fikeya host may use one only after the user explicitly enables it for the current workspace, reviews its declared tools and limits, supplies required non-secret configuration, and confirms the launch. The host must spawn the fixed executable and argument vector directly with `shell: false`.

## Presets

| Preset | Standard transport | External command | Declared effect |
| --- | --- | --- | --- |
| Cockroach Browser | MCP over stdio | `cockroach-browser mcp` | Read authorized browser state and prepare non-executing action proposals |
| Cockroach Crawler | MCP over stdio | `cockroach-mcp` | Read-only public-web collection and deterministic transformation |

Neither preset contains an API key, bearer token, password, cookie, origin, or provider credential. Environment inheritance is not implied by the files. A host must construct a minimal environment from the reviewed fixed values, explicit workspace configuration, and named credential references.

## Cockroach Browser

Install Cockroach Browser independently and configure its authenticated daemon according to its upstream documentation. The preset may reference `COCKROACH_BROWSER_TOKEN` only through an operating-system credential store. It never contains the token value. `COCKROACH_BROWSER_URL` is optional non-secret configuration and must be an HTTP(S) URL without embedded user information.

The exposed MCP tools inspect capabilities, health, authorized sessions, semantic snapshots, paired captures, network records, and audits. `browser_propose_action` only creates a canonical proposal. It does not dispatch an action. Session creation, login or profile management, origin expansion, and direct action dispatch are excluded.

The preset's process limits bound Fikeya's MCP client. Cockroach Browser's own session origin allowlist, action budget, duration, tab, download, upload, snapshot, network, and evidence limits remain mandatory upstream controls. This preset cannot create or widen them.

## Cockroach Crawler

Install Cockroach Crawler independently. Before enablement, the operator must provide `COCKROACH_ALLOWED_ORIGINS` as one or more explicit HTTP(S) origins without credentials or paths. The upstream CLI refuses to start its MCP server without this value.

The preset fixes the following upper bounds in the child process environment:

- 10 returned pages
- depth 1
- 50 network requests
- 60 seconds of crawl time

The allowed MCP tools crawl or map authorized origins, query caller-supplied markup, find or relocate elements, run a rule-bounded spider, serialize caller-supplied records, and perform deterministic structured extraction. Credentials, private-network access, challenge bypass, and model-controlled origin expansion are excluded.

## Host Enforcement Contract

The preset schema records process and response limits, but a JSON document cannot enforce them alone. A consuming Fikeya host must:

1. Require explicit workspace-scoped enablement every time the stored approval is absent or the preset digest changes.
2. Resolve only the reviewed executable on `PATH`, verify a compatible installed version, and avoid `npx` or implicit package downloads.
3. Spawn the exact argument vector without a shell and without inheriting the whole parent environment.
4. Materialize secret references only at launch time from an approved credential store, redact child-process errors, and never write secret values into project configuration or receipts.
5. Admit only `capabilities.allowedTools`, reject undeclared tools and resources, and enforce request count, concurrency, duration, timeout, and message-size ceilings.
6. Stop the process on cancellation, timeout, protocol violation, limit exhaustion, or workspace revocation.
7. Preserve the external package name, version, source, and license in execution receipts.

The Fikeya Runtime CLI provides workspace-scoped `tool list`, `tool enable`, `tool disable`, and `tool status` commands. Enablement stores only the exact manifest digest and timestamp, and a digest change requires confirmation again. Enabling a preset never launches it.

`fikeya_runtime.mcp_stdio.McpStdioHost` is the process-owning host for an enabled preset. It rechecks the exact preset digest, delegates launch preparation and spawning to `ToolPresetLoader`, negotiates MCP initialization, checks the server package name and compatible stable version, validates the complete declared tool set, and exposes typed `tools/list` and `tools/call` results. JSON-RPC identifiers and schemas, request/response sizes, request counts, timeouts, session duration, stderr retention, and process shutdown are bounded. Resolved credentials are redacted from discovered definitions, typed results, remote errors, stderr, and diagnostics. A timeout, oversized line, protocol violation, failed initialization, or broker shutdown terminates the complete POSIX process group or Windows Job Object rather than only the direct child.

This remains an optional local integration. It does not cryptographically prove the installed executable's artifact provenance, provide operating-system sandbox isolation, or add the enable/disable flow to Fikeya Desktop. Exact approval determines when Fikeya calls a reviewed tool; it does not restrict that executable's desktop-user filesystem or network permissions. The minimal child environment omits home/profile directories and provider credentials, but environment minimization is not a sandbox. Arbitrary `.cmd`, `.bat`, `.ps1`, and `.sh` wrappers are rejected. On Windows, Fikeya recognizes only the exact npm-generated `.cmd` form for a reviewed preset, validates its canonical package target, package name, version, and bin mapping, and launches the target with the absolute native `node.exe` path without a shell. The server-reported package version is checked again during MCP initialization, but signed-package verification remains a separate distribution control.

## Validation

The validator has no third-party dependencies and never starts an external CLI:

```console
node integrations/tool-presets/validate.mjs
npm --prefix integrations/tool-presets test
```

It rejects default-on presets, shell execution, command or argument substitution, unreviewed tools, widened fixed limits, altered source or license metadata, inline secret fields, and common secret-shaped values.

## Licensing and Attribution

The preset schema, validator, tests, and documentation are Fikeya-owned code under `AGPL-3.0-or-later`, consistent with the repository's product-layer licensing. The external programs retain their own licenses:

- [Cockroach Browser](https://github.com/AjnasNB/cockroach-browser), `AGPL-3.0-or-later`
- [Cockroach Crawler](https://github.com/AjnasNB/cockroach-crawler), `MIT`

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the reviewed package versions and source links. Installing or distributing either external package may create obligations under that package's license; this preset does not change them.
