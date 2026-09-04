# Cockroach Browser open-source integration map

This guide defines which open-source technologies fit the Fikeya + Cockroach Browser architecture, what each component is allowed to do, and the order in which integrations should ship. It is an implementation roadmap, not a claim that every listed component is already integrated.

## Product rule

Cockroach Browser should remain one governed, engine-neutral browser runtime. An AI framework may propose an operation, but Cockroach Browser owns capability negotiation, policy, approval, engine selection, process isolation, budgets, and evidence. Fikeya owns the coding workflow, changed-file evidence, tests, review, and Qarinah context.

```text
AI clients and framework adapters
              |
observe / act / extract / assert / record / handoff
              |
capability check -> policy -> exact approval
              |
engine router
  |-- Obscura lightweight lane
  |-- Chromium full-fidelity lane
  |-- Firefox full-fidelity lane
  |-- WebKit full-fidelity lane
  `-- isolated experimental lanes
              |
screenshots / traces / network / file diffs / test receipts
              |
Fikeya history + Qarinah evidence
```

No adapter can authorize itself, widen an origin, reuse a credential, select an unapproved proxy, or silently fall back to another engine.

## Current verified boundary

- Fikeya has a reviewed local Cockroach Browser MCP preset for observation, capability preflight, health, inspection, and canonical non-executing action proposals.
- The current Fikeya preset does not dispatch Cockroach Browser actions or create browser sessions.
- Cockroach Browser `v0.5.0-rc.1` is the pinned release used by the current capability and benchmark evidence.
- Obscura `0.2.1` is the pinned upstream lightweight engine.
- The verified constrained non-visual fixture recorded a maximum complete owned browser process-tree RSS of **29,622,272 bytes, exactly 28.25 MiB**, over 20 measured launches after one warmup.
- The Node coordinator was measured separately. The result is not Fikeya Desktop memory, whole-application memory, a rendered-page result, an arbitrary-site result, or Chromium, Firefox, or WebKit memory.

Read the [technical and market paper](/papers/fikeya-cockroach-browser/) and the [pinned benchmark with raw samples](https://github.com/AjnasNB/cockroach-browser/blob/v0.5.0-rc.1/docs/benchmarks/obscura-non-visual-2026-09-03.md).

## Integration priorities

| Priority | Technology | Cockroach Browser role | Integration boundary |
| --- | --- | --- | --- |
| P0 | [WebDriver BiDi](https://www.selenium.dev/documentation/webdriver/bidi/) | Standards-based bidirectional transport beside CDP | Declare commands and events per engine; never silently translate an unsupported operation |
| P0 | [Playwright](https://playwright.dev/docs/browsers) | Chromium, Firefox, and WebKit production fidelity lanes | Cockroach owns session policy, process lifecycle, routing, and receipts |
| P0 | [Puppeteer](https://github.com/puppeteer/puppeteer) | Familiar CDP and BiDi compatibility surface | Expose a versioned subset and report protocol-specific gaps |
| P0 | [Model Context Protocol](https://github.com/modelcontextprotocol/typescript-sdk) | Typed local and remote AI tool access | Pin stable SDK releases; validate schemas; preserve approval and origin boundaries |
| P0 | [axe-core](https://github.com/dequelabs/axe-core) | Native accessibility assertion command | Report rule version, tested URL, engine, scope, and incomplete checks |
| P1 | [Crawlee](https://github.com/apify/crawlee) | Queue, retry, browser-pool, and crawl-state patterns | Reuse scheduling concepts behind Cockroach policy instead of importing a second authority layer |
| P1 | [Stagehand](https://github.com/browserbase/stagehand) | Inspiration and adapter for semantic `observe`, `act`, and `extract` operations | Stagehand can propose an action; Cockroach still preflights and authorizes it |
| P1 | [Browser Use](https://github.com/browser-use/browser-use) | Python agent-framework adapter | Translate into the canonical Cockroach command envelope rather than bypassing it |
| P1 | [OpenTelemetry](https://github.com/open-telemetry/opentelemetry-js) | Portable session, action, network, error, and resource spans | Default to runtime telemetry; do not inject page analytics without explicit policy |
| P1 | [rrweb](https://github.com/rrweb-io/rrweb) | Optional DOM and interaction replay evidence | Opt in per session and redact secrets, form values, tokens, and sensitive DOM content |
| P1 | [Mozilla Readability](https://github.com/mozilla/readability) | Main-content extraction beside DOM, Markdown, and structured output | Retain source URL, engine, timestamp, extractor version, and content identity |
| P2 | [Open Policy Agent](https://www.openpolicyagent.org/docs/latest/) | Optional enterprise policy decision adapter | Native Cockroach checks stay fail-closed when OPA is absent or unavailable |
| P2 | [gVisor](https://gvisor.dev/docs/) | Stronger Linux isolation for hosted browser workers | Server and fleet lane only; measure compatibility and overhead before enabling |
| P2 | [mitmproxy](https://docs.mitmproxy.org/stable/) | Explicit debugging and test traffic inspection | Never install trust roots or intercept TLS silently; keep it disabled by default |

## Engine portfolio

| Engine | Intended lane | Status and rule |
| --- | --- | --- |
| [Obscura](https://github.com/h4ckf0r0day/obscura) | Lightweight compatible tasks | Current pinned upstream lane. Preserve Apache-2.0 attribution and route unsupported fidelity work elsewhere. |
| Chromium | Full browser fidelity | Production lane through Playwright, Puppeteer, CDP, or BiDi as supported. |
| Firefox | Cross-browser fidelity | Production lane through Playwright or BiDi with explicit protocol capability reporting. |
| WebKit | Cross-browser fidelity | Production lane through Playwright for layout and behavior coverage; do not market it as physical Safari-device testing. |
| [Lightpanda](https://github.com/lightpanda-io/browser) | Optional lightweight comparison or fallback | Adapter experiment only until Windows, fidelity, distribution, and AGPL-3.0 obligations are reviewed. |
| [Servo](https://github.com/servo/servo) | Standards and differential-testing lab | Experimental conformance lane, not a production default. |
| [Ladybird](https://github.com/LadybirdBrowser/ladybird) | Independent-engine research lab | Experimental lane until its automation and platform behavior meet permanent gates. |

Bundling every engine into the default installation would increase binary size, update load, attack surface, and support cost. Engines should be independently installed, pinned, checksummed, capability-described plugins.

## Canonical agent surface

Every AI framework should target one small semantic interface:

- `observe`: return bounded accessible or structured page state;
- `act`: propose one bounded interaction;
- `extract`: return schema-validated data with source provenance;
- `assert`: check URL, text, accessibility, layout, network, or application state;
- `record`: capture an approved screenshot, trace, HAR, or replay artifact;
- `handoff`: transfer an authorized session to a person without exposing reusable secrets;
- `batch`: execute a bounded, preflighted sequence with stop conditions.

The deterministic Playwright, Puppeteer, CDP, BiDi, WebDriver, and Appium surfaces remain available for programs and expert operators. The semantic interface is the compact AI layer above them.

```json
{
  "action": "click",
  "target": { "role": "button", "name": "Submit" },
  "expectedOutcome": "Order confirmation appears",
  "risk": "external-write",
  "origin": "https://approved.example",
  "contextRefs": ["qarinah://event-or-pack-identity"],
  "approvalToken": "one-use-bound-token",
  "evidence": ["before-screenshot", "after-screenshot", "dom-diff"]
}
```

## Evidence pipeline

A completed browser action should be reviewable as one receipt containing:

1. Fikeya task, plan, provider, and Qarinah context identities;
2. exact engine, executable identity, version, protocol, capabilities, and launch configuration;
3. requested action, preflight result, policy decision, approval identity, origin, effects, and budgets;
4. before and after URL, bounded DOM or accessibility evidence, screenshots where relevant, console and network summaries, and content hashes;
5. changed path, create/edit/delete/rename operation, inserted and deleted lines, byte delta, and before/after file hashes;
6. exact tests and browser assertions executed, their results, duration, and output identities;
7. resource observations and termination outcome for the complete owned process tree.

HAR, screenshots, traces, replay, extracted content, and logs must be content-addressed, bounded, redacted, and governed by retention policy. A passed action is not proof that every artifact is safe to store.

## Conformance and evaluation

| Suite | Purpose |
| --- | --- |
| [Web Platform Tests](https://github.com/web-platform-tests/wpt) | Web-platform conformance and cross-engine regression coverage |
| [Test262](https://github.com/tc39/test262) | ECMAScript behavior, especially for lightweight and emerging engines |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | Reproducible browser-agent task evaluation across multiple benchmark environments |

Critical workflows should run differentially across the compatible lightweight lane and the required full-browser lanes. Compare final state, DOM or accessibility result, network effects, downloads, artifacts, errors, and receipts, not only exit status.

## Hosted and remote adapters

- [Steel](https://github.com/steel-dev/steel-browser) is useful architecture inspiration for remote sessions, profiles, process management, observability, extraction, and an OpenAPI surface. Treat it as an optional adapter, not the policy authority.
- [Browserless](https://github.com/browserless/browserless) can be supported as an external remote endpoint after product and license review. Its server code uses SSPL or commercial licensing, so it must not be copied or bundled casually.
- Remote adapters must report who operates the browser, where it runs, which profile and proxy are used, what is recorded, and which Cockroach guarantees remain enforceable.

Cockroach Browser should not present a third-party hosted fleet, residential proxy inventory, captcha service, or physical device lab as a Fikeya-operated capability.

## Delivery order

### Gate 1: protocol and authority

- Add first-class BiDi beside CDP.
- Publish an engine adapter contract with version, executable hash, license, capabilities, and unsupported operations.
- Add the canonical semantic command schema and fail-closed preflight.
- Permanently test that adapters cannot self-authorize or silently change engines.

### Gate 2: Fikeya dispatch and proof

- Complete the exact approval-bound Fikeya to Cockroach dispatch path.
- Bind browser action receipts to changed paths, line deltas, hashes, tests, and Qarinah context.
- Display engine selection, fallback reason, network effects, and artifacts in the Fikeya dashboard.

### Gate 3: quality primitives

- Add axe-core assertions, Readability extraction, HAR, trace, screenshot, and redacted rrweb capture.
- Add OpenTelemetry spans and resource measurements.
- Add Crawlee-grade queue, retry, browser-pool, and session scheduling behind Cockroach policy.

### Gate 4: ecosystem adapters

- Publish maintained TypeScript and Python SDKs.
- Add Browser Use and Stagehand adapters.
- Add Steel-compatible or generic OpenAPI remote-session support where the contract can be preserved.

### Gate 5: isolation and labs

- Measure gVisor for hosted Linux workers and offer OPA as an enterprise policy adapter.
- Keep Lightpanda, Servo, and Ladybird behind experimental flags until conformance, security, packaging, and license gates pass.

## Licensing guardrails

- Preserve attribution, license texts, source notices, and modification notices for every distributed dependency.
- Apache-2.0, MIT, BSD, and MPL components still have specific notice and source-file obligations.
- Review AGPL components such as Lightpanda against the intended distribution and hosted-service model before integration.
- Review Browserless SSPL or commercial terms before any embedding, modification, or operated service.
- Prefer protocol adapters when a dependency's license, runtime, or update model should remain isolated.

This document does not replace legal review.

## Definition of done

An integration is shipped only when its pinned source and build identities, license review, capability manifest, negative tests, resource limits, security behavior, documentation, and end-to-end evidence gate are all present. A repository dependency, adapter stub, passing import, or roadmap entry is not a shipped browser capability.
