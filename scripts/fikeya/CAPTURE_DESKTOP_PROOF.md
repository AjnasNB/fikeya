# Capture the real Fikeya Chat and Plan proof

`capture-desktop-proof.ts` launches the development Fikeya Electron build with a fresh isolated profile, the local Fikeya Desktop extension, and a disposable project. It does not render a static HTML mock.

The recorded scenario:

1. opens a real project file and the real Fikeya Chat webview;
2. initializes Fikeya Runtime and Qarinah in that disposable project;
3. leaves a visible prompt in Chat without making a provider request;
4. creates a three-step durable plan through the Plan form;
5. reviews the immutable plan; and
6. starts it only far enough to prove that execution stops at the first exact approval boundary.

No provider credential is needed. The scenario never clicks an approval button and does not execute a workspace tool. It verifies DOM state separately from each click before the scenario runner records the passing screenshot.

## Run

Build the desktop checkout once if `.build/electron` and `out/main.js` do not exist:

```text
npm run electron
npm run transpile-client
```

Then capture the proof:

```text
node scripts/fikeya/capture-desktop-proof.ts
```

The helper compiles the current extension and scenario harness, launches the real app, and writes stable copies to `.build/fikeya-desktop-proof/`:

- `fikeya-chat-real.png`
- `fikeya-plan-draft-real.png`
- `fikeya-plan-reviewed-real.png`
- `fikeya-plan-awaiting-approval-real.png`
- `fikeya-desktop-proof.json`

The JSON manifest points to the original evidence directory, HTML report, captioned video when FFmpeg is available, Playwright trace, exact app version, platform, and SHA-256 of every copied screenshot. The original scenario bundle remains under `.build/vscode-playwright-mcp/evidence/`.

Use `--check` for a fast prerequisite check, `--output <dir>` to choose the stable-copy directory, or `--skip-compile` only when the extension and scenario runner were already compiled from the current sources.

The deterministic proof intentionally uses the explicit Plan JSON path. Turning arbitrary natural-language Chat into a plan requires a configured provider and network consent, so it cannot be a credential-free reproducible screenshot. That provider-backed path has separate runtime and extension tests; this capture proves the real local Chat surface and durable Plan state machine without pretending a model call occurred.
