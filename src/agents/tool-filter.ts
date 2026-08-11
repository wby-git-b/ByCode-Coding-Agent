// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { ToolRegistry } from "../tools/registry.js";

// 全局禁止子 Agent 使用的工具列表——防止递归调用 Agent 或使用仅限主线程的工具
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "TaskOutput",
  "ExitPlanMode",
  "EnterPlanMode",
  "Agent",       // 防止子 Agent 递归派生
  "AskUserQuestion",
  "TaskStop",
  "Workflow",
]);

// 自定义 Agent（从 .mewcode/agents/ 加载）额外禁用的工具；
// 目前与全局列表相同，独立维护以便未来扩展
export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  "TaskOutput",
  "ExitPlanMode",
  "EnterPlanMode",
  "Agent",
  "AskUserQuestion",
  "TaskStop",
  "Workflow",
]);

// 异步（后台）Agent 只允许使用这些工具
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  "ReadFile",
  "WebSearch",
  "TodoWrite",
  "Grep",
  "WebFetch",
  "Glob",
  "Bash",
  "EditFile",
  "WriteFile",
  "NotebookEdit",
  "Skill",
  "LoadSkill",
  "SyntheticOutput",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
]);

function isMCPTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * 多层工具过滤，按顺序应用：
 * 1. MCP 工具 (mcp__*) — 始终放行
 * 2. ALL_AGENT_DISALLOWED_TOOLS — 全局禁用（防止递归）
 * 3. CUSTOM_AGENT_DISALLOWED_TOOLS — 自定义 Agent 额外限制
 * 4. ASYNC_AGENT_ALLOWED_TOOLS — 后台 Agent 白名单
 * 5. 定义级 disallowedTools — 黑名单
 * 6. 定义级 tools — 白名单交集（"*" 禁用此层）
 */
export function filterToolsForAgent(
  registry: ToolRegistry,
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  isAsync: boolean,
  isCustom = false,
): ToolRegistry {
  const disallowed = new Set(disallowedTools ?? []);
  const allowed = new Set(allowedTools ?? []);
  // 定义了 tools 列表且不是通配 "*" 时启用白名单交集
  const hasWhitelist =
    allowed.size > 0 && !(allowed.size === 1 && allowed.has("*"));

  const filtered = new ToolRegistry();

  for (const tool of registry.listTools()) {
    const name = tool.name;

    // Layer 1: MCP 工具始终放行
    if (isMCPTool(name)) {
      filtered.register(tool);
      continue;
    }

    // Layer 2: 全局禁止——所有子 Agent 都不能用
    if (ALL_AGENT_DISALLOWED_TOOLS.has(name)) {
      continue;
    }

    // Layer 3: 自定义 Agent 额外限制
    if (isCustom && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) {
      continue;
    }

    // Layer 4: 异步 Agent 白名单过滤
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) {
      continue;
    }

    // Layer 5: 定义级黑名单
    if (disallowed.has(name)) {
      continue;
    }

    // Layer 6: 定义级白名单交集
    if (hasWhitelist && !allowed.has(name)) {
      continue;
    }

    filtered.register(tool);
  }

  return filtered;
}

export const FORK_QUERY_SOURCE = "agent:builtin:fork";

/**
 * Fork 专用：复制父注册表的全部工具，不做任何过滤。
 * 遇到 AgentTool 时浅复制并标记 querySource，
 * 确保 fork 子 Agent 不能再次 fork（运行时拦截），
 * 同时保持工具定义与父 Agent 字节一致以命中 prompt cache。
 */
export function cloneRegistryForFork(registry: ToolRegistry): ToolRegistry {
  const forked = new ToolRegistry();
  for (const tool of registry.listTools()) {
    if (tool.name === "Agent" && "querySource" in tool) {
      const clone = Object.create(
        Object.getPrototypeOf(tool),
        Object.getOwnPropertyDescriptors(tool),
      );
      clone.querySource = FORK_QUERY_SOURCE;
      forked.register(clone);
    } else {
      forked.register(tool);
    }
  }
  return forked;
}
