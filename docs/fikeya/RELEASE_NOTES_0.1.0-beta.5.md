# Fikeya 0.1.0-beta.5

Fikeya 0.1.0-beta.5 is a public-beta source candidate focused on a durable, audited Project workflow and approval-gated browser verification.

## What changed

- Project Chat exposes five explicit agent intents: Ask, Plan, Build, Review, and Research.
- The durable Project lifecycle records `plan -> audit plan -> execute -> audit code -> verify` transitions in workspace SQLite and can resume after a normal process restart.
- Plan review, one-use execution approval, and proof of execution remain separate. Completion requires matching plan, audit, deterministic workspace-snapshot, and verification evidence.
- Runtime leases fence concurrent owners, support stale-owner recovery, and project cancellation propagates to provider, process, and browser work.
- Bounded read-only advisers can investigate concurrently while one selected lead remains the only approval-gated writer.
- Native Playwright actions can navigate, inspect, click, type, scroll, wait, assert visible text, capture a bounded screenshot, and close the browser through reviewed tool calls.
- Browser URLs, credentials, selectors, input, output, redirects, time, screenshots, and session limits are validated. Private or loopback targets require separate explicit consent.
- The Windows x64 Desktop and Windows x64 VSIX runtime embed a pinned, hash-verified Chromium Headless Shell payload with retained license evidence.
- Desktop renders the recorded Project stage, revision history, next action, plan review, pending approval, and recovery controls instead of fabricating progress in the webview.
- CLI exposes `fikeya project start`, `resume`, `show`, and `cancel` over a bounded JSON-lines protocol.

## Deliberate stop conditions

Project mode persists toward verified completion, but it is not an unbounded autonomous process. It stops safely when a person cancels, an approval is denied or expires, a provider or tool cannot make bounded progress, retry or transition budgets are exhausted, evidence no longer matches the reviewed plan or workspace, or a security policy rejects the next operation.

## Packaging boundary

- Beta.5 packages Windows x64 Desktop, a Windows x64 VSIX, the standalone CLI archive, and Python distributions.
- Only the Windows x64 Desktop and VSIX runtime embed the reviewed browser payload. Source and standalone CLI installations must install the Runtime `browser` extra and provision the matching Playwright browser separately.
- macOS, Linux, Windows ARM64, and macOS ARM64 installers are not shipped in this candidate.
- The tagged release workflow requires a trusted, timestamped signature before publishing and verifies the outer Windows installer. Nested executables, the VSIX, wheels, and source archives are covered by release hashes and provenance; they are not represented as independently Authenticode-signed.

## Remaining prerelease gates

Beta.5 is not a stable release. Stable promotion still requires clean-install, launch, update, cancellation, recovery, and uninstall verification for every claimed platform; trusted platform signing; a verified update feed; broader hostile-page and sandbox testing; and closure of the published security gates.
