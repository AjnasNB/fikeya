# Plan-to-proof product contract

Status: implementation contract for the next Fikeya public beta.

## Product promise

Fikeya is a free, bring-your-own-model coding workbench. A developer can describe a task in Chat, inspect and change the proposed plan, approve the exact work that may run, follow execution step by step, and inspect the resulting diff, tests, token usage, and evidence.

Fikeya optimizes for verified work per token. It selects bounded, cited project evidence instead of replaying the whole repository by default. Any efficiency statement must come from a matched task receipt; it is not a promise that every provider, model, repository, or task costs less.

## Who the workflow serves

### Developer

- Opens a repository and reaches Chat immediately.
- Chooses a provider and model or continues with an already configured local profile.
- Sees the context sources, plan, exact tool requests, progress, changed files, tests, and usage without leaving the conversation.
- Can edit, reorder, pause, resume, cancel, or retry eligible plan steps.

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
4. **Draft plan** - create ordered, typed steps with objectives, dependencies, risks, and expected verification.
5. **Review plan** - let the developer select every step, inspect its reasoning summary and evidence, edit eligible fields, and approve or return the plan for revision.
6. **Authorize tools** - request an exact one-use approval for each risky canonical tool call. Plan approval never implies tool approval.
7. **Execute** - stream step state, tool state, artifacts, and recoverable failures.
8. **Verify** - run the declared checks and bind their exit status and output hashes to the step.
9. **Review outcome** - show the diff, changed-file hashes, tests, provider-reported usage, context receipt, and unresolved warnings.
10. **Accept, retry, revert, or hand off** - preserve a durable content-bounded receipt and the Qarinah references needed for the next task.

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
  -> executing       (explicit bounded retry or resume)
```

Transitions are append-only events. A UI may derive the current state, but it must not overwrite the event history. Restarting the client must not turn an interrupted step into a success.

## Plan record

Every plan has:

- stable plan, session, workspace, and task identifiers;
- creation and update timestamps;
- current state and state-transition events;
- provider profile, model, and context-budget selection;
- a Qarinah context receipt or an explicit unavailable reason;
- ordered steps and dependency edges;
- plan-review identity and timestamp when present;
- aggregate provider-reported usage;
- result, diff, test, and evidence hashes; and
- terminal outcome or an explicit incomplete reason.

Every step has:

- stable ID, title, objective, and type;
- dependencies and display order;
- current status and attempt number;
- input evidence references;
- risk and permission class;
- exact tool requests and one-use approval references;
- started, finished, cancelled, and failed timestamps when applicable;
- changed paths and before/after hashes;
- verification command, exit state, and output hash; and
- a concise human-readable outcome.

## Desktop information architecture

### Code-first layout

- The native editor remains central.
- **Fikeya Chat** opens beside the editor and is the default Fikeya surface.
- Primary destinations are **Chat**, **Plan**, **Context**, and **Usage**.
- Code, terminal, source control, review, and settings use their native workbench surfaces rather than duplicate miniature editors.
- The composer remains visible at the bottom while messages and receipts scroll above it.

### Chat

- Shows a real bounded multi-turn conversation.
- Exposes provider, model, context mode, and effort or output budget without turning the composer into a settings page.
- Streams plan and execution summaries into the transcript.
- Provides direct actions for new chat, stop, open plan, open context, and open settings.

### Plan

- Displays a compact vertical timeline with states: proposed, needs review, waiting for approval, running, verifying, passed, failed, or cancelled.
- Selecting a step opens its objective, dependencies, evidence, tool requests, approvals, changed files, and checks.
- Provides explicit **Approve plan**, **Request changes**, **Run approved work**, **Pause**, **Resume**, **Retry**, and **Cancel** actions when those transitions are valid.
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

The CLI and Desktop consume the same serialized plan record and transition rules. The CLI must support deterministic commands to:

- create a plan;
- show the plan and one selected step;
- review or request changes;
- approve eligible plan execution;
- execute or resume approved work;
- cancel a run; and
- print the final proof receipt as JSON.

Prompts and credential values must not be placed in process arguments, logs, analytics, or committed project files.

## Qarinah recording

Qarinah records durable project evidence rather than acting as the execution authority. Fikeya records:

- the accepted task summary;
- plan identity and current state;
- reviewed decisions and their evidence;
- tool request and result hashes;
- changed-file hashes;
- verification outcomes;
- conflicts or incomplete reasons; and
- the final proof-receipt identity.

Raw provider secrets, hidden reasoning, and unrestricted tool output are excluded. A stale Qarinah derived index must be rebuilt and verified before its graph is used as release evidence.

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
3. A user can draft, inspect, revise, approve, execute, and verify a multi-step plan in Desktop.
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
