# ByCode Coding Agent

A terminal AI coding agent built with **Bun + TypeScript + Ink**. It runs a
collaborative agent loop right in your terminal, with multi-agent teams, MCP
(Model Context Protocol) support, persistent memory, plan mode, code review,
and a permission-aware tool sandbox.

## Features

- **Multi-agent collaboration** — spawn teammates with dedicated mailboxes,
  transcript logging, and live progress tracking in the TUI
- **MCP support** — connect external MCP servers and expose their tools to the agent
- **Persistent memory** — automatic memory extraction after sessions, project- and
  user-scoped storage, relevance-based recall, and an auto-generated `MEMORY.md` index
- **Plan mode** — draft and refine plans, then get explicit approval before executing
- **Tool safety** — permission rules, read-before-write enforcement, file history,
  and sandboxed execution (`bwrap` / `seatbelt`)
- **Multiple LLM providers** — Anthropic, OpenAI, and OpenAI-compatible endpoints,
  with model and context-window auto resolution
- **Terminal UI** — Ink-based TUI with provider selection, permission dialogs,
  tool-call display, diff rendering, and team status
- **Slash commands & skills** — user-extensible slash commands, a skills catalog,
  and a skill installer
- **Code review & history** — review sessions, file history snapshots, and
  session/transcript persistence
- **Remote mode** — a WebSocket server so the agent can be driven from a web UI

## Requirements

- [Bun](https://bun.sh) 1.x or newer

## Getting started

```bash
bun install
bun start
```

Non-interactive (print) mode:

```bash
bun run src/main.tsx -p "explain this codebase"
bun run src/main.tsx -p "fix the failing test" --output-format stream-json
```

Start a remote WebSocket server (default port `18888`):

```bash
bun run src/main.tsx --remote
```

Run a teammate inside a multi-agent team:

```bash
bun run src/main.tsx --teammate \
  --team-dir .mewcode/teams/team-1 \
  --member-name worker \
  --task "implement the feature"
```

## Configuration

Configuration is read from `.mewcode/config.yaml` (not tracked by git). API keys
can also be provided with the `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
environment variables.

## Project structure

```
src/
├── agent/        # Agent loop, streaming executor, events
├── agents/       # Agent definitions, spawning, task manager
├── llm/          # Anthropic / OpenAI clients, model resolver
├── tools/        # Tool registry and built-in tools
├── skills/       # Skills catalog, loader, installer
├── teams/        # Multi-agent orchestration and mailboxes
├── memory/       # Memory extraction, manager, recall
├── prompt/       # System prompt and plan-mode prompt building
├── tui/          # Ink terminal UI
├── sandbox/      # bwrap / seatbelt sandbox execution
├── mcp/          # MCP client and tool wrapping
├── remote/       # WebSocket remote server + web UI
├── worktree/     # Git worktree management
└── ...           # config, conversation, compact, history, todo, etc.
```

## Development

```bash
bun test          # run the test suite
bun run typecheck # TypeScript type checking
```
