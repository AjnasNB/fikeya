# Fikeya 0.1.0-beta.6

Fikeya 0.1.0-beta.6 is a public-beta source candidate focused on dependable Project-first Chat, bounded file mentions, and explicit workspace layout switching.

## What changed

- Type `@` in Chat or use the mention menu to attach up to ten supported UTF-8 workspace files.
- Use the same menu to select supported text or code files from elsewhere on the computer. External absolute paths are not sent to the model.
- Likely credential and key files are blocked, each file is limited to 96 KB, and the message total is limited to 384 KB.
- Explorer now exposes **Mention Files in Fikeya Chat** for selected files.
- The composer retains its prompt and attachments until the extension accepts the exact request. Rejected requests remain editable.
- Webview generation preserves JavaScript escape sequences, preventing the blank Chat pane observed after Send.
- The visible Project UI dropdown now switches directly to Editor + Chat, and the selected layout is rendered immediately.
- The desktop evidence run covers ordinary Chat, pasted images, `@README.md`, parallel agents, Qarinah graph navigation, a complete reviewed plan, and the Project UI to Editor + Chat transition.

## Safety boundary

Mentioned file content is ephemeral to the current request. Persisted conversation state retains bounded attachment metadata, not complete mentioned-file contents. Fikeya rejects unsupported, binary, non-canonical UTF-8, oversized, and likely secret-bearing files before provider delivery.

## Packaging boundary

- Beta.6 packages Windows x64 Desktop, a Windows x64 VSIX, the standalone CLI archive, and Python distributions.
- The candidate is not a stable release and must be treated as unsigned unless `release-verification.json` reports a valid trusted Authenticode signature.
- macOS, Linux, Windows ARM64, and macOS ARM64 installers are not shipped in this candidate.
