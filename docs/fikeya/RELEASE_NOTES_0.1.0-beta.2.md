# Fikeya 0.1.0-beta.2

Fikeya 0.1.0-beta.2 is the current public-beta source candidate. It extends the local Desktop, VS Code extension, and CLI with one evidence-scoped path from a provider-generated draft plan to a verified terminal result.

## Plan to proof

- **Chat and planning remain separate.** An ordinary Chat turn uses the reviewed agent loop. **Create plan** starts a separate provider turn that receives a strict `fikeya.plan-proposal.v1` output contract and no execution-tool channel.
- **Provider output is only a proposal.** Valid output can persist a `draft`; it cannot approve a plan, grant a tool permission, or execute a workspace operation. Narrative, malformed, duplicate-key, oversized, or unsupported output fails closed without creating a plan.
- **Review precedes permission.** A developer reviews the durable draft. Plan review does not grant blanket execution authority. Each canonical tool call must receive its own exact, expiring, single-use approval.
- **Execution is bounded.** The runtime accepts only supported root-bound workspace and allowlisted process operations. Changed arguments, executable, working directory, environment keys, request digest, or checkpoint invalidate the approval.
- **Success requires verification.** Execution status, exit code, output hash, declared file-hash checks, verification checks, and the final proof hash remain distinct. A plan reaches `succeeded` only after every required step has a passed verification outcome.
- **Desktop and CLI share the durable record.** The Plan surface and the `fikeya plan` commands read the same persisted plan state rather than inferring completion from the chat transcript.

## CLI planning commands

The beta-2 runtime exposes:

- `fikeya plan propose` for one no-tool provider planning turn;
- `fikeya plan create` for a caller-supplied validated draft;
- `fikeya plan show` for the current durable record and content-free proof receipt;
- `fikeya plan review` for explicit developer review;
- `fikeya plan approve` for one exact pending step call;
- `fikeya plan run` for bounded execution until completion or the next approval boundary;
- `fikeya plan resume` for recoverable persisted work;
- `fikeya plan cancel` for a non-terminal plan.

## Explicit beta boundaries

- Planning is local and sequential. Transactional multi-file patch staging, generalized automatic retry, delegated worktrees, and a separate append-only plan-event stream are not claimed.
- A recovered `verifying` step can finish from its persisted execution receipt. A recovered `executing` step fails as uncertain instead of being silently replayed.
- The provider proposal receipt identifies the planning call, but provider reasoning and response bodies are not stored as proof.
- The beta-2 source candidate has not been published or Authenticode-signed. Treat any Windows build as unsigned unless its final `release-verification.json` reports `Valid`. Installer publisher metadata alone is not a trusted signature, and Windows can show an unknown-publisher warning.
- Beta 2 remains a prerelease. Signed cross-platform packages, clean-install evidence on Windows, macOS, and Linux, and a signature-verified Desktop update feed remain stable-release gates.

## Verification

Before installing a published beta-2 artifact, compare it with `SHA256SUMS.txt`, inspect `release-verification.json` for its source commit, byte length, digest, and Authenticode state, and review the attached GitHub provenance. Until beta-2 artifacts are published, the beta-1 release remains the latest downloadable build.
