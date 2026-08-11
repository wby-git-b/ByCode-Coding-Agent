# ByCode Coding Agent

一款基于 **Bun + TypeScript + Ink** 构建的终端 AI 编程代理（Coding Agent）。它在终端中运行协作式 Agent 循环，支持多 Agent 协作、MCP（Model Context Protocol）、持久记忆、Plan 模式、代码审查和权限感知的工具沙箱。

## 功能特性

- **多 Agent 协作** —— 可派生子 Agent（teammate），拥有独立的邮箱、会话转录记录，并在 TUI 中实时查看进度
- **MCP 支持** —— 连接外部 MCP 服务器，把它们的工具暴露给 Agent
- **持久记忆** —— 会话结束后自动提取记忆，支持项目级/用户级存储、相关性召回，并自动生成 `MEMORY.md` 索引
- **Plan 模式** —— 先起草并迭代方案，获得明确批准后再执行
- **工具安全** —— 权限规则、写前必读（read-before-write）校验、文件历史，以及沙箱执行（`bwrap` / `seatbelt`）
- **多 LLM 提供商** —— 支持 Anthropic、OpenAI 及 OpenAI 兼容接口，自动解析模型与上下文窗口
- **终端 UI** —— 基于 Ink 的 TUI，支持提供商选择、权限弹窗、工具调用展示、Diff 渲染和团队状态
- **斜杠命令与技能（Skills）** —— 可扩展的斜杠命令、技能目录和技能安装器
- **代码审查与历史** —— 审查会话、文件历史快照、会话/转录持久化
- **远程模式** —— 内置 WebSocket 服务器，可通过 Web UI 远程驱动 Agent

## 环境要求

- [Bun](https://bun.sh) 1.x 或更高版本

## 快速开始

```bash
bun install
bun start
```

非交互（打印）模式：

```bash
bun run src/main.tsx -p "解释一下这个代码库"
bun run src/main.tsx -p "修复失败的测试" --output-format stream-json
```

启动远程 WebSocket 服务器（默认端口 `18888`）：

```bash
bun run src/main.tsx --remote
```

在多 Agent 团队中运行一个子 Agent：

```bash
bun run src/main.tsx --teammate \
  --team-dir .mewcode/teams/team-1 \
  --member-name worker \
  --task "实现这个功能"
```

## 配置

配置从 `.mewcode/config.yaml` 读取（该文件不会提交到 git）。API Key 也可以通过 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 环境变量提供。

## 项目结构

```
src/
├── agent/        # Agent 主循环、流式执行器、事件
├── agents/       # Agent 定义、派生、任务管理
├── llm/          # Anthropic / OpenAI 客户端、模型解析
├── tools/        # 工具注册表与内置工具
├── skills/       # 技能目录、加载器、安装器
├── teams/        # 多 Agent 编排与邮箱
├── memory/       # 记忆提取、管理、召回
├── prompt/       # 系统提示词与 Plan 模式提示词构建
├── tui/          # Ink 终端 UI
├── sandbox/      # bwrap / seatbelt 沙箱执行
├── mcp/          # MCP 客户端与工具包装
├── remote/       # WebSocket 远程服务器 + Web UI
├── worktree/     # Git worktree 管理
└── ...           # config、conversation、compact、history、todo 等
```

## 开发

```bash
bun test          # 运行测试
bun run typecheck # TypeScript 类型检查
```
