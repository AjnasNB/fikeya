# Provider Contract

The public-alpha provider adapter contract covers profile discovery, bounded text responses, cancellation, token usage, and error classification. Streaming and tool-call normalization remain target adapter capabilities and are not represented as shipped runtime behavior.

## Profile

```json
{
  "id": "work-azure",
  "provider": "azure-openai",
  "baseUrl": "https://example.openai.azure.com/openai/v1/",
  "model": "deployment-name",
  "authentication": "entra-id",
  "secretRef": null,
  "limits": {
    "maxInputTokens": 0,
    "maxOutputTokens": 4096,
    "maxCostUsd": null
  }
}
```

`secretRef` is an opaque keychain identifier. Plaintext credentials are invalid configuration.

## Required Capabilities

- Text input and bounded completed text output
- Cancellation
- Usage extraction
- Stable provider and model identifiers
- Retryable versus terminal error classification

## Optional Capabilities

- Tool calling
- Parallel tool calls
- Structured output
- Images
- Prompt caching details
- Reasoning token details
- Provider-side response continuation
- Streamed text and event output

## Receipt

```json
{
  "usageMeasurement": "provider-reported",
  "provider": "azure-openai",
  "model": "deployment-name",
  "apiMode": "responses",
  "callId": "call-id",
  "requestId": "provider-request-id",
  "inputTokens": 1200,
  "cachedInputTokens": 800,
  "outputTokens": 220,
  "requestBytes": 1820,
  "responseBytes": 760,
  "requestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "responseSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "statusCode": 200,
  "durationMs": 480,
  "createdAt": "2026-08-24T00:00:00.000Z"
}
```

`usageMeasurement` is `provider-reported` only when the provider response contains all three token fields. Otherwise it is `unavailable` and all three token fields are `null`. Local tokenizer and character estimates are kept outside this receipt so the UI cannot confuse them with provider billing. The public alpha does not calculate currency cost inside provider receipts.

## Default Endpoints

- OpenRouter: `https://openrouter.ai/api/v1`
- NVIDIA hosted NIM: user-configured OpenAI-compatible endpoint
- Ollama: `http://127.0.0.1:11434/v1`

Azure and generic endpoints have no hard-coded resource name. The setup flow validates HTTPS for remote endpoints and allows HTTP only for loopback local providers.
