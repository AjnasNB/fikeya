# Fikeya 0.1.0-beta.4

Fikeya 0.1.0-beta.4 is a public-beta source candidate focused on a complete Project-first coding workflow.

## What changed

- Project Chat remains the default surface in the branded Desktop; the full editor is available when the user chooses Editor UI.
- The composer now opens a compact in-app BYOK setup for hosted, cloud, routed, and local model endpoints.
- Named presets cover Azure OpenAI, Azure AI Foundry compatible endpoints, OpenAI, Anthropic, OpenRouter, NVIDIA NIM, Gemini, Hugging Face, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Cerebras, Amazon Bedrock, Ollama, and local or custom OpenAI-compatible servers.
- Multitask runs bounded read-only specialists concurrently, then hands their findings to one selected lead model for a normal approval-gated coding run.
- File and image attachments remain intact while provider, memory, statistics, or progress state refreshes in the background.
- Approved process executions now produce bounded before/after workspace mutation evidence for created, modified, and deleted files.
- Protected metadata and ignored-directory checks are case-insensitive, closing a Windows path-boundary bypass.
- Project UI and Editor UI controls now cross the validated webview command boundary correctly.

## Verification boundary

The beta candidate is not a signed stable release. Stable promotion still requires trusted Windows and macOS signing, Linux packaging, clean-install evidence on all supported platforms, a verified update feed, and closure of the published release gates.
