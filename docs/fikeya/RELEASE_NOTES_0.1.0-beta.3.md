# Fikeya 0.1.0-beta.3

Fikeya 0.1.0-beta.3 is the current public-beta source candidate. It keeps Chat as the primary workspace in both the complete Desktop and focused VS Code extension while retaining the editor, terminal, review, plan, context graph, usage, and provider setup surfaces.

## What changed

- Added one canonical JSON-RPC UI notification contract shared by Project UI and Editor UI.
- Added compact file, folder, image, paste, and drag-and-drop controls to Chat.
- Added bounded UTF-8 text and code attachments for Agent, Plan, and Research turns.
- Rejects credential files, unsafe relative paths, noncanonical text, oversized files, and excessive attachment batches before data reaches the extension host.
- Keeps raw attachment content ephemeral for the current turn. Optional workspace chat history stores only bounded, content-free attachment metadata and can be deleted from the Fikeya command palette.
- Preserves provider handoff, Qarinah context, one-use tool approvals, execution receipts, and provider-reported usage across the unified chat workflow.
- Refined the composer with compact menus, rounded focus treatment, attachment previews, and a visible drop state.

## Verified in source

- Shared protocol package: 8 tests passing.
- Focused Desktop extension: 96 tests passing.
- Python runtime and CLI: 121 tests passing.
- Native Python agent core: 39 tests passing.

The runtime test suite exercises bounded workspace reads and writes, exact text replacement, allowlisted process execution, approval consumption, evidence hashing, cancellation, and path-boundary rejection.

## Release status

This is a source candidate until the release workflow produces and verifies the VSIX, CLI archive, and Windows installer. An installer is not described as trusted or signed unless its release verification manifest records a valid timestamped Authenticode signature. The update feed remains disabled until a verified signed release is promoted.
