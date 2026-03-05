# YourBot / your-ai

## Purpose
AI assistant platform (YourBot) with multi-channel access (Feishu, Telegram, Web), agent runtime, memory system, and evolution/learning capabilities.

## Tech Stack
- **Runtime**: Bun (TypeScript)
- **Framework**: Hono (HTTP), native Bun WebSocket
- **LLM**: Claude Code Bridge + LightLLM (OpenAI-compatible)
- **Memory**: OpenViking (custom vector/graph storage)
- **Channels**: Feishu (Lark SDK), Telegram, Web (WebSocket)
- **Config**: AIEOS protocol files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md)

## Key Architecture
- `src/gateway/` — HTTP server, channel management, message routing
- `src/kernel/` — Central controller, agents, memory, evolution, scheduling, workspace
- `src/shared/` — Types, logging, utilities
- `src/lessons/` — Error detection, lesson extraction
- Singleton pattern: `CentralController.getInstance(deps)`
- Per-user config: `UserConfigLoader` (3-level fallback: local → VikingFS → global)
- Onboarding: `OnboardingManager` (multi-step dialog state machine)

## Code Style
- TypeScript strict mode
- Chinese log messages, English code/comments
- Logger class per module: `new Logger('ModuleName')`
- Error handling: `YourBotError` with `ERROR_CODES`
- Imports: relative paths, type imports with `type` keyword

## Commands
- No tsc installed locally; use IDE diagnostics for type checking
- Package manager: Bun (but bun not in PATH on this system)
- Entry: `src/gateway/index.ts`
