# Azure Entra smoke receipt

Date: 2026-08-24

Fikeya Runtime completed one deliberately small Azure OpenAI Responses API call using Azure Entra ID. No API key was created, printed, committed, or deployed.

## Request boundary

- Provider profile: Azure OpenAI with `entra-id`
- Network access: explicitly enabled for this run
- Memory: off, so this isolates provider execution rather than memory quality
- Prompt: a fixed request to return the word `OK`
- Maximum output: 16 tokens
- Timeout: 60 seconds

## Verified result

- HTTP result: successful
- Output matched the requested word: yes
- Provider-reported input tokens: 12
- Provider-reported output tokens: 5
- Cached input tokens: 0
- Fikeya call receipt: created

This is a connectivity and receipt smoke test, not a latency, quality, cost, or cross-provider benchmark. Provider names, resource identifiers, access tokens, response bodies beyond the expected fixed word, and local credential state are intentionally absent.
