# Fikeya 0.1.0-beta.8

Fikeya 0.1.0-beta.8 is a public-beta source candidate focused on reliable first-run coding and a clean Project-first desktop surface.

## First-run reliability

- Agent, parallel-agent, Plan, and Project requests now initialize a new workspace before accepting the composer request.
- Concurrent first requests share one initialization operation instead of racing multiple runtime and Qarinah setups.
- A failed initialization leaves the typed request available for correction or retry instead of recording a dead duplicate in Chat.
- Successful initialization prepares both Fikeya runtime state and the pinned Qarinah memory workspace.

## Files and folders

- Native Explorer drags can reach the first-party Fikeya Project and sidebar webviews.
- Fikeya recognizes both `ResourceURLs` and the workbench `CodeFiles` payload used by local Explorer drags.
- Dropped paths still pass through the existing workspace boundary, file-type, traversal, size, symlink, and count validation before content is read.

## Project UI

- Project UI owns the complete editor surface while active, with no redundant native editor tab or close action.
- The Project surface is protected from standard close commands while its extension lifecycle remains able to switch explicitly to Editor UI.
- Opening a normal file restores the ordinary editor title and tabs.

## Verification

- The focused extension suite passes 117 tests.
- Extension and Code OSS client type checking pass with the beta.8 changes.
- The source candidate remains a prerelease until signing and all stable-release gates pass. Local Windows artifacts are unsigned unless `release-verification.json` explicitly reports a valid signature.
