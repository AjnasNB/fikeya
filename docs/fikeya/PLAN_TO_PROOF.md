# Plan-to-proof product contract

Status: implemented beta contract for the durable planning path. Explicit gaps are listed below rather than presented as shipped behavior.

## Product promise

Fikeya is a free, bring-your-own-model coding workbench. A developer can describe a task in Chat, ask the selected provider for a strict draft plan, inspect that plan, review it, approve the exact step calls that may run, execute bounded work, and inspect verification and usage evidence.

Fikeya optimizes for verified work per token. It selects bounded, cited project evidence instead of replaying the whole repository by default. Any efficiency statement must come from a matched task receipt; it is not a promise that every provider, model, repository, or task costs less.

## Who the workflow serves

### Developer

- Opens a repository and reaches Chat immediately.
- Chooses a provider and model or continues with an already configured local profile.
- Sees the context sources, plan, exact tool requests, progress, changed files, tests, and usage without leaving the conversation.
- Can create a replacement draft, resume eligible interrupted work, or cancel a non-terminal plan. Direct step editing, reordering, generalized pause, and automatic retry remain follow-up work.

### Maintainer or team lead

- Can review the plan before execution and distinguish proposed work from completed work.
- Can inspect why each step exists, what it depends on, and what evidence it uses.
- Can review a compact proof bundle before accepting a change.

### Recommender, security reviewer, or platform engineer

- Can verify that network access, tools, workspace roots, and credentials have explicit boundaries.
- Can reproduce a published task from its fixture, source revision, plan, approvals, hashes, and verification result.
- Can recommend Fikeya without relying on unscoped cost or quality claims.

### Enterprise administrator

- Uses the separate private Maqam control plane for identity, policy, provider and model allowlists, budgets, revocation, central approvals, and audit export.
- Does not receive a copy of source code or chat bodies by default. Endpoints disclose only the policy and evidence fields the organization has configured.
- Can require human approval before high-risk execution and can stop or revoke an endpoint.

The public Fikeya runtime remains useful without Maqam. The enterprise boundary must not be simulated in the public client with a fake administrator selector.

## Canonical flow

1. **Open** - validate the workspace root and display initialization status.
2. **Ask** - accept the task in the right-side Chat surface.
3. **Compile context** - retrieve a bounded Qarinah pack with source event IDs and hashes.
4. **Draft plan** - make a planning-only provider call under the trusted `fikeya.plan-proposal.v1` output contract, validate the exact envelope, and persist ordered typed steps with dependencies, canonical calls, and expected verification. This call exposes no tools and cannot execute the plan.
5. **Review plan** - let the developer inspect the immutable draft and each exact tool-call digest, then mark the plan reviewed or create a replacement draft.
6. **Authorize tools** - request an exact one-use approval for each risky canonical tool call. Plan approval never implies tool approval.
7. **Execute** - run approved dependency-ready calls through the bounded broker and persist step state, execution outcomes, and recoverable interruption state.
8. **Verify** - run the declared checks and bind their exit status and output hashes to the step.
9. **Review outcome** - show execution and verification hashes, declared checks, provider-reported proposal usage, context status, and any incomplete or failure reason.
10. **Accept or continue deliberately** - inspect the content-free proof receipt, approve remaining pending work when appropriate, or create a new plan for follow-up work.

## Plan state machine

```text
draft
  -> reviewed
  -> awaiting_approval
  -> executing
  -> verifying
  -> succeeded

draft | reviewed | awaiting_approval | executing | verifying
  -> cancelled

executing | verifying
  -> failed

verifying
  -> verifying       (`plan resume` after an interrupted client)
```

The current store uses an optimistic, content-addressed revision for each transition; it does not yet expose a separate append-only plan-event history. Restarting the client must not turn an interrupted step into a success. A recovered `verifying` step can be verified from its persisted execution receipt, while a recovered `executing` step fails as uncertain instead of being replayed.

## Plan record

Every persisted plan currently has:

- stable plan and workspace identifiers; the provider proposal receipt separately carries its provider session and call identifiers;
- creation and update timestamps;
- current state and monotonically increasing revision;
- a content-addressed specification and append-only revisions;
- a separate proposal receipt containing provider profile/model call identity, provider-reported usage when present, and Qarinah context status;
- ordered steps and dependency edges;
- reviewed status and the exact approval references issued for its steps;
- execution, verification, record, and proof hashes; and
- terminal outcome or an explicit incomplete reason.

Every persisted step currently has:

- stable ID, title, canonical tool-call ID, tool name, and arguments;
- dependencies and display order;
- current status;
- exact tool requests and one-use approval references;
- approval issue and consumption timestamps, plus execution start and finish timestamps when applicable;
- execution status, exit code, output hash, and affected-path hashes when applicable; and
- verification expectations, checks, outcome status, timestamp, and outcome hash.

## Desktop information architecture

### Code-first layout

- The native editor remains central.
- **Fikeya Chat** opens beside the editor and is the default Fikeya surface.
- Primary destinations are **Chat**, **Plan**, **Context**, and **Usage**.
- Code, terminal, source control, review, and settings use their native workbench surfaces rather than duplicate miniature editors.
- The composer remains visible at the bottom while messages and receipts scroll above it.

### Chat

- Shows a bounded process-local multi-turn conversation; it is not provider-native session replay.
- Exposes provider, model, context mode, and effort or output budget without turning the composer into a settings page.
- Starts either an ordinary interactive agent run or a separate planning-only proposal call from the same composer.
- Provides direct actions for stop, create/open plan, open context, usage, and settings.

### Plan

- Displays a compact vertical timeline with states: proposed, needs review, waiting for approval, running, verifying, passed, failed, or cancelled.
- Selecting a step exposes its dependencies, canonical tool request and digest, approval, execution, and verification fields.
- Provides explicit **Review**, per-step or pending-step **Approve**, **Run approved work**, **Resume**, **Cancel**, and **New plan** actions when those transitions are valid.
- Never labels a proposed or approved action as completed.

### Context

- Fits inside a narrow editor column without horizontal clipping.
- Search, type filter, relationship filter, reset, and graph statistics wrap into a single-column control stack when space is constrained.
- The graph uses the available width, supports pan, zoom, drag, keyboard selection, and an **Open full graph** action.
- The selected-node inspector appears below the graph at narrow widths and beside it only when enough width exists.

### Usage and proof

- Separates provider-reported input, cached input, and output tokens from local estimates.
- Shows context-pack bytes and cited items independently from provider billing.
- Links a completed run to changed-file hashes, tests, receipts, and Qarinah evidence.

## CLI parity

The CLI and Desktop consume the same serialized plan record and transition rules. The implemented CLI commands are:

- `plan propose` - ask one provider for a strict draft, with the versioned request sent through stdin and no tools exposed;
- `plan create` - create a draft from a bounded local JSON specification sent through stdin;
- `plan show` - show the plan, steps, record hash, and proof receipt;
- `plan review` - mark the immutable draft reviewed;
- `plan approve` - issue exact single-use references for selected steps or all currently eligible pending steps;
- `plan run` - execute approved dependency-ready work and stop before unapproved work;
- `plan resume` - finish a persisted verifying step or continue after additional approvals; an uncertain executing step is not replayed; and
- `plan cancel` - cancel a non-terminal plan with a recorded reason.

Plan prompts and specifications enter through stdin rather than process arguments. Credential values must not be placed in arguments, logs, analytics, or committed project files. The prompt and raw provider response are ephemeral; durable state retains the validated draft and content-free proposal receipt.

## Qarinah recording boundary

Qarinah supplies cited project context and context receipts; it is not the execution authority. The current Fikeya plan store records:

- plan identity, specification digest, revision, and current state;
- exact approval references and tool-call digests;
- tool request and result hashes;
- verification outcomes;
- failure or incomplete reasons; and
- the final proof-receipt identity.

The provider proposal receipt separately records the provider call identity, provider-reported usage when supplied, and Qarinah context status. Raw provider secrets, hidden reasoning, plan prompts, raw provider responses, and unrestricted tool output are excluded. Automatic projection of every plan transition into the Qarinah ledger is not claimed by this beta; a stale Qarinah derived index must be rebuilt and verified before its graph is used as release evidence.

## Enterprise control boundary

Maqam is the optional private enterprise model gateway and agent safety/policy layer. It may add:

- SSO and directory-provisioned identity;
- tenant and project policy;
- allowed providers, models, tools, repositories, and networks;
- per-user, team, project, and model budgets;
- central or delegated human approval;
- endpoint enrollment, revocation, and offline expiry;
- audit, evidence export, and SIEM delivery; and
- fleet health and rollout controls.

Policy distribution and central approval do not replace endpoint enforcement. A disconnected endpoint must honor its signed policy expiry and fail closed for actions that require an online decision.

## Website structure

- **Home** - product promise, real Chat screenshot, centered download action, current release state.
- **Product** - code-first and agent-first layouts, Plan-to-proof workflow, Qarinah context, providers, and tools.
- **Proof** - reproducible fixtures, task receipts, benchmark method, security checks, and scoped results.
- **Docs** - install, initialize, configure a provider, run the first task, inspect the graph, and troubleshoot.
- **Enterprise** - Maqam safety/policy layer, deployment boundary, administrator workflow, and contact path.
- **Download** - Windows, VSIX, and CLI artifacts with version, checksums, signature state, and platform requirements.

The home page may call the editor free only with the nearby explanation that provider or infrastructure usage can still incur charges. It must not claim Fikeya is the only free editor.

## Release acceptance tests

The next beta is eligible only when all applicable checks pass:

1. A clean test repository initializes successfully.
2. Chat is the obvious default surface and remains usable at 320, 480, and 720 CSS pixels.
3. A user can draft, inspect, review, approve, execute, and verify a multi-step plan in Desktop.
4. The same plan can be shown and resumed through the CLI.
5. Every risky tool request requires an exact one-use approval.
6. Cancelled and failed runs remain cancelled or failed after restart.
7. A changed file has before/after hashes and a linked verification outcome.
8. Provider usage is labeled by source; absent usage stays unavailable rather than estimated as fact.
9. Qarinah context references resolve after rebuilding the derived index.
10. The extension, CLI package, Windows installer, checksums, provenance manifest, and website links agree on the version.
11. No artifact claims a trusted Windows publisher until a real code-signing certificate or Azure Artifact Signing path has signed and verified it.
12. The public proof uses a reproducible fixture and does not imply universal benchmark superiority.

## Adoption and enterprise research boundary

Prospect research should build a consent-based account and role list from public company pages, opt-in directories, conference speakers, public job descriptions, and direct referrals. It must not scrape private LinkedIn data, bypass access controls, auto-connect, or send unsolicited bulk messages. A human reviews every outreach message before it is sent.
