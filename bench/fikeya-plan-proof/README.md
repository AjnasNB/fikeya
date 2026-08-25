# Fikeya plan-to-proof evaluation

This is a small, reproducible **local integration fixture** for Fikeya. It does not call an AI model, use an API key, contact a benchmark service, or make a comparative leaderboard claim.

The fixture starts with deliberately failing Python and JavaScript implementations of one shared order-line contract. It then exercises the real local product boundaries:

1. Qarinah initializes an opted-in content workspace, records two project-memory events, and retrieves cited context through Fikeya's root-bound stdio sidecar under an exact 8,000-character ceiling.
2. Fikeya creates a durable four-step plan and moves it through draft, review, awaiting approval, execution, verification, and success.
3. Every file write and verifier command receives an exact single-use approval reference.
4. File changes are checked by SHA-256 and both language test suites must pass.
5. The result confirms that context and plan receipts omit the retrieved decision body and source-file bodies.
6. The workspace statistics must report zero provider calls. Token use is therefore reported as **not measured**, never estimated as zero tokens.

## Run

Prerequisites:

- Python 3.10 or newer
- Node.js 22 or newer
- the pinned Qarinah dependency installed in `integrations/qarinah-sidecar`

From the repository root:

```powershell
npm ci --prefix integrations/qarinah-sidecar
python bench/fikeya-plan-proof/run.py --output bench/fikeya-plan-proof/results/latest.json
python -m unittest bench/fikeya-plan-proof/test_run.py
```

The runner uses a temporary workspace unless `--workspace <empty-directory>` is supplied. The JSON report contains baseline and final verifier exit codes, the requested, reported, and used Qarinah character budgets, content-free context provenance, exact plan and verification hashes, the Git revision plus a manifest of the implementation files exercised, and explicit limitations.

## What this maps to

The fixture borrows evaluation **properties**, not scores, from public benchmarks:

| Public benchmark | Official evaluation property | What this fixture covers | What it does not claim |
| --- | --- | --- | --- |
| [SWE-bench Verified](https://www.swebench.com/SWE-bench/reference/harness/) | Apply a repository patch and run tests in a reproducible environment | A real local patch is accepted only when its verifiers pass | This is not one of the 500 SWE-bench Verified instances and produces no SWE-bench score |
| [Terminal-Bench](https://github.com/harbor-framework/terminal-bench) | Give an agent a task in a terminal environment and grade it with a deterministic test | Fikeya runs approval-gated local verifier commands and hashes their outcomes | This is not an official Terminal-Bench task or leaderboard run |
| [Aider polyglot](https://aider.chat/docs/leaderboards/) | Edit code across multiple languages and grade the result with tests | The same contract is changed and tested in Python and JavaScript | This is not the 225-exercise polyglot suite and says nothing about model quality |

The official SWE-bench harness is Docker-based and evaluates model-generated predictions against dataset instances. Terminal-Bench tasks include an instruction, execution environment, and verifier. Aider's current polyglot benchmark evaluates 225 Exercism tasks across six languages. Running those complete suites is a separate, model-dependent exercise.

## Result interpretation

A passing report proves only that this checked-out Fikeya build can, for this fixture:

- retrieve and receipt one real local context pack;
- stop before unapproved work;
- consume exact approvals once;
- change two source files under the workspace boundary;
- execute two allowlisted verifiers without a shell;
- record hash-linked execution and verification proof; and
- finish with zero provider calls.

It does **not** prove that Fikeya is universally more accurate, cheaper, faster, safer, or more token-efficient than another agent. Those claims require preregistered, matched model runs using the existing [`bench/fikeya-efficiency`](../fikeya-efficiency/) receipt comparator.
