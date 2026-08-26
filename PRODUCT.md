# Fikeya product design context

## Register

Product

## Users

Software developers and maintainers who want a complete AI coding editor and agent while choosing their own model provider, retaining control over tool execution, and spending fewer tokens on repeated project discovery.

## Product purpose

Fikeya is a provider-neutral AI code editor, desktop workbench, VS Code extension, and CLI. It combines a normal code editor with a conversation-first coding agent, Qarinah project intelligence, reviewed tool execution, plans, verification receipts, and local usage measurement.

## Brand personality

Technical, clean, direct, capable, calm, and trustworthy. Fikeya should feel like a mature developer tool rather than an administration dashboard or a marketing mock-up.

## Anti-references

- Dense control panels inside the primary conversation.
- Repeated navigation for actions already available through the host editor.
- Disabled primary actions without an inline explanation and recovery path.
- Decorative cards, oversized labels, or modal-heavy setup flows.
- Provider and permission complexity exposed before the developer needs it.

## Design principles

1. Conversation first. The chat transcript and composer are the primary surface; secondary controls use compact menus and progressive disclosure.
2. Recovery in place. Missing provider, workspace initialization, consent, or credentials must be fixable from the exact point where the user encounters the issue.
3. Familiar developer-tool behavior. Enter sends, Shift+Enter inserts a line, attachments use a paperclip, settings use a gear, and active work reports visible progress.
4. Real workspace evidence. Files, context, graph nodes, tool outcomes, and usage must come from the opened workspace and link back to their sources.
5. Safe without friction. Network consent and tool approval remain explicit, but the interface asks at the moment of use instead of disabling the conversation in advance.
6. One visual language. Fikeya green marks selection, focus, and primary action; neutral surfaces carry everything else.

## Accessibility and inclusion

- Target WCAG 2.2 AA contrast and keyboard operability.
- Preserve visible focus, screen-reader labels, semantic status announcements, and reduced-motion preferences.
- Never rely on color alone for provider, permission, progress, error, or success state.
- Keep controls usable at narrow editor widths without horizontal scrolling.
