# Provider Contract

A provider adapter exposes model discovery, capability negotiation, streaming responses, cancellation, tool-call normalization, token usage, and error classification.

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

- Text input and streamed text output
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

## Receipt

```json
{
  "measurement": "provider",
  "provider": "azure-openai",
  "model": "deployment-name",
  "requestId": "provider-request-id",
  "inputTokens": 1200,
  "cachedInputTokens": 800,
  "outputTokens": 220,
  "reasoningTokens": 90,
  "cost": null,
  "pricingRevision": null
}
```

`measurement` is `provider`, `tokenizer`, or `estimate`. The UI never labels a tokenizer or character estimate as provider billing.

## Default Endpoints

- OpenRouter: `https://openrouter.ai/api/v1`
- NVIDIA hosted NIM: user-configured OpenAI-compatible endpoint
- Ollama: `http://127.0.0.1:11434/v1`

Azure and generic endpoints have no hard-coded resource name. The setup flow validates HTTPS for remote endpoints and allows HTTP only for loopback local providers.
