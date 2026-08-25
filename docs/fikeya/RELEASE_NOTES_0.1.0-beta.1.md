# Fikeya 0.1.0-beta.1

This public beta packages the branded Fikeya Desktop, the focused VS Code extension, and the local Python CLI/runtime from one reviewed source revision.

## Included

- Windows x64 user installer with Fikeya product and publisher metadata;
- focused Windows x64 VSIX with its own pinned runtime and Qarinah sidecar;
- Agent Core, Runtime, and ACP/Codex/MCP interop wheels and source distributions;
- CLI bundle, installation instructions, SHA-256 checksums, and a machine-readable verification manifest;
- local provider profiles, measured usage receipts, reviewed coding turns, Qarinah initialization and interactive graph inspection;
- GitHub build provenance for workflow-produced artifacts.

## Windows trust notice

The `0.1.0-beta.1` Windows installer is not Authenticode-signed because a trusted code-signing certificate has not yet been configured. Windows can therefore display an unknown-publisher warning. Verify `SHA256SUMS.txt` before installation. The release workflow is ready to sign and verify future builds when the protected certificate secrets are supplied.

## Verification

Compare a downloaded file with `SHA256SUMS.txt`, then inspect `release-verification.json` for its byte length, source commit, digest, and Authenticode status.
