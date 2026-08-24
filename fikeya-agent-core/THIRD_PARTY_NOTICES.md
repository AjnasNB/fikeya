# Third-party notices

`fikeya-agent-core` has no third-party runtime dependencies in version `0.1.0a1`.

Development and verification use:

- pytest - MIT License - <https://github.com/pytest-dev/pytest>
- pytest-asyncio - Apache License 2.0 - <https://github.com/pytest-dev/pytest-asyncio>
- Ruff - MIT License - <https://github.com/astral-sh/ruff>

The optional `RuntimeProviderAdapter` interoperates structurally with the separately installed AGPL-3.0-or-later
`fikeya-runtime`; it does not bundle that package.

LangGraph and Deep Agents are discussed as potential future official integrations. Neither project is a dependency or bundled
work in this release. Both upstream projects are MIT licensed:

- LangGraph - <https://github.com/langchain-ai/langgraph>
- Deep Agents - <https://github.com/langchain-ai/deepagents>
