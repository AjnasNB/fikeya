# Installed CLI to live Wrangler deployment proof

Date: 2026-08-25  
Fikeya surface: installed Windows CLI  
Result: passed

This proof used the installed `fikeya.exe`, a deterministic local test provider, a fresh initialized workspace, and an authenticated Wrangler installation. It did not call a paid model or expose a provider credential.

## Verified flow

1. Fikeya initialized a new workspace.
2. The agent received four exact, one-use approvals:
   - write `src/index.js`;
   - write `wrangler.jsonc`;
   - run a Wrangler dry-run;
   - run the live Wrangler deployment.
3. The process allowlist contained only `node`. On Windows, Fikeya invoked Wrangler's JavaScript entry point directly instead of trusting a shell shim.
4. Both Wrangler commands exited with code `0`.
5. An independent HTTP request to `/health` returned status `200` and the expected proof identity.

## Public result

- Worker: <https://fikeya-cli-proof-20260825165749.ajnasnb.workers.dev>
- Health check: <https://fikeya-cli-proof-20260825165749.ajnasnb.workers.dev/health>
- Cloudflare version: `1f5c5c72-96e0-41fe-a2ab-e62fe0c3adf5`
- Workspace ID: `ws_1427f7775fec4a8187250a153ed7a170`
- Session ID: `ses_7937d6c3850e4cd1b7c3bde103166d51`

Expected health response:

```json
{
  "ok": true,
  "proofId": "fikeya-cli-proof-20260825165749",
  "createdBy": "fikeya-agent-execute",
  "path": "/health"
}
```

## Receipts

| Operation | Result | Duration |
| --- | --- | ---: |
| Write Worker source | Passed | Not timed |
| Write Wrangler configuration | Passed | Not timed |
| Wrangler dry-run | Exit 0 | 1,641 ms |
| Wrangler deploy | Exit 0 | 16,469 ms |

The deterministic provider reported 288 input tokens and 72 output tokens across nine calls. These are provider-reported test values, not a cost claim or a comparison with another product.

The original local proof report has SHA-256 `afe8df5517c9ae8165ea1bffec1c332bf0dab14cc6a7060687ade9b146923c3a`. Source files, approval arguments, changed files, and tool outputs are separately hashed in that report.

## Reproduction boundary

The published Worker proves the installed Fikeya CLI can drive an approved code-and-deploy loop through Wrangler. The deterministic provider keeps the test reproducible; it does not measure model quality. A production model run must use the same approval and receipt contracts with a user-configured provider profile.
