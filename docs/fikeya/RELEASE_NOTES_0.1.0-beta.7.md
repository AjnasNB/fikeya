# Fikeya 0.1.0-beta.7

Fikeya 0.1.0-beta.7 is a public-beta source candidate focused on dependable Project-first Chat input and workspace attachments.

## Project Chat

- Enter and the send arrow now submit the visible message directly.
- Plan mode creates a normal reviewable draft instead of invoking the separate audited-project command.
- The dedicated audited-project action remains available when a durable autonomous lifecycle is required.
- Project UI no longer shows a redundant layout dropdown inside Chat.
- Closing the Project Chat editor reopens it while Project UI is active; the native editor-title action remains the explicit way to switch to Editor UI.

## Files and folders

- Files can be dragged from the workspace Explorer onto the full Project Chat surface.
- Dropped folders are expanded within the open workspace using bounded traversal.
- Symlinks, excluded build or dependency directories, unsupported files, paths outside the workspace, and oversized collections are rejected.
- Existing image paste, operating-system file drop, folder upload, and `@` mention flows remain available.

## Verification

- The focused extension suite passes 116 tests.
- The real Electron proof passes provider-backed Chat, image paste, Explorer resource drop, `@` file mention, parallel agents, direct Plan creation, narrow layouts, Qarinah graph selection, exact approvals, verified receipts, Project Chat close recovery, and Editor UI with a terminal.
- The source candidate remains a prerelease until signing and all stable-release gates pass. Local Windows artifacts are unsigned unless `release-verification.json` explicitly reports a valid signature.
