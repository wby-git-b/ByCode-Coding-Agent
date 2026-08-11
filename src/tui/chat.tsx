// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useRef } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { brand, symbols } from "./styles.js";
import { DiffLines, isDiffTool } from "./diff-render.js";

chalk.level = 3;
marked.use(markedTerminal({ showSectionPrefix: false }));

function renderMarkdown(text: string): string {
  try {
    let result = marked.parse(text) as string;
    // marked-terminal 不处理列表项内的 **粗体**，后处理兜底
    result = result.replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t));
    // marked-terminal 用 "    * " 渲染列表项，看起来像没处理。改成 "  - "
    result = result.replace(/^( {4})\* /gm, "  - ");
    return result;
  } catch {
    return text;
  }
}

export interface ToolSummaryItem {
  toolName: string;
  argsSummary: string;
  output: string;
  isError: boolean;
  elapsed: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "thinking" | "tool_use" | "tool_result" | "turn_summary";
  content: string;
  toolName?: string;
  argsSummary?: string;
  isError?: boolean;
  elapsed?: number;
  // turn_summary fields
  thinkingDuration?: number;
  toolSummary?: ToolSummaryItem[];
}

interface Props {
  messages: ChatMessage[];
  streamingText?: string;
  expanded?: boolean;
}

/**
 * 增量流式 Markdown 渲染：只重新解析尾部不完整块，稳定前缀缓存复用。
 * 参照 Claude Code 的 StreamingMarkdown 设计，将 O(n²) 降为 O(n)。
 */
// ANSI 转义序列正则：用于计算可见字符宽度
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g;

/**
 * 计算物理行数（考虑终端宽度换行），防止动态区域超高触发 Ink 的 clearTerminal。
 * 逻辑行中的 ANSI 转义序列不占宽度，超过终端宽度的可见字符自动折行。
 */
function countPhysicalLines(lines: string[], cols: number): number {
  let total = 0;
  for (const line of lines) {
    const visible = line.replace(ANSI_RE, "").length;
    total += Math.max(1, Math.ceil(visible / cols));
  }
  return total;
}

function StreamingText({ text }: { text: string }) {
  const stableRef = useRef({ text: "", rendered: "" });
  const { stdout } = useStdout();
  const cols = stdout.columns || 80;
  // 预留 12 物理行给 Spinner、ToolDisplay、InputBox、用户消息等动态区域组件
  const maxPhysical = Math.max(5, (stdout.rows || 24) - 12);

  const boundary = text.lastIndexOf("\n\n");
  const stableEnd = boundary >= 0 && boundary + 2 > stableRef.current.text.length
    ? boundary + 2
    : stableRef.current.text.length;
  const stableText = text.slice(0, stableEnd);
  const unstableText = text.slice(stableEnd);

  if (stableText.length > stableRef.current.text.length) {
    stableRef.current = { text: stableText, rendered: renderMarkdown(stableText) };
  }

  const unstableRendered = unstableText ? renderMarkdown(unstableText) : "";
  const fullRendered = stableRef.current.rendered + unstableRendered;

  // 按物理行数裁剪：从末尾往前取，直到物理行数用完
  const lines = fullRendered.split("\n");
  let physicalCount = 0;
  let cutIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const visible = lines[i].replace(ANSI_RE, "").length;
    const wrapped = Math.max(1, Math.ceil(visible / cols));
    if (physicalCount + wrapped > maxPhysical) break;
    physicalCount += wrapped;
    cutIndex = i;
  }

  const truncated = cutIndex > 0;
  const visibleText = truncated
    ? "…\n" + lines.slice(cutIndex).join("\n")
    : fullRendered;

  return <Text>{brand.assistant(`${symbols.dot} `)}{visibleText}</Text>;
}

export const ChatView = React.memo(function ChatView({ messages, streamingText, expanded = false }: Props) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {messages.map((msg, i) => (
        <MessageBlock key={i} message={msg} expanded={expanded} />
      ))}
      {streamingText !== undefined && streamingText !== "" && (
        <Box>
          <StreamingText text={streamingText} />
        </Box>
      )}
    </Box>
  );
});

/**
 * CommittedMessage renders a single finalized message for use inside Ink's
 * <Static> component. Once rendered, Static never re-renders it, eliminating
 * flicker from the scrollback history.
 */
export function CommittedMessage({ message, expanded = false }: { message: ChatMessage; expanded?: boolean }) {
  return (
    <Box paddingLeft={1}>
      <MessageBlock message={message} expanded={expanded} />
    </Box>
  );
}

/**
 * Build a compact human-readable summary line for a turn, e.g.:
 *   "Thought for 4s, read 2 files, ran 1 command"
 */
function buildTurnSummaryText(thinkingDuration: number | undefined, tools: ToolSummaryItem[]): string {
  const parts: string[] = [];

  if (thinkingDuration !== undefined && thinkingDuration >= 1) {
    parts.push(`Thought for ${Math.round(thinkingDuration)}s`);
  }

  if (tools.length > 0) {
    // Categorize tools by type for a natural summary.
    const counts: Record<string, number> = {};
    for (const t of tools) {
      const name = t.toolName;
      if (name === "ReadFile") {
        counts["read"] = (counts["read"] ?? 0) + 1;
      } else if (name === "WriteFile") {
        counts["wrote"] = (counts["wrote"] ?? 0) + 1;
      } else if (name === "EditFile") {
        counts["edited"] = (counts["edited"] ?? 0) + 1;
      } else if (name === "Bash") {
        counts["ran"] = (counts["ran"] ?? 0) + 1;
      } else if (name === "Glob") {
        counts["globbed"] = (counts["globbed"] ?? 0) + 1;
      } else if (name === "Grep") {
        counts["searched"] = (counts["searched"] ?? 0) + 1;
      } else {
        counts["used"] = (counts["used"] ?? 0) + 1;
      }
    }

    const labels: Record<string, (n: number) => string> = {
      read: (n) => `read ${n} file${n > 1 ? "s" : ""}`,
      wrote: (n) => `wrote ${n} file${n > 1 ? "s" : ""}`,
      edited: (n) => `edited ${n} file${n > 1 ? "s" : ""}`,
      ran: (n) => `ran ${n} command${n > 1 ? "s" : ""}`,
      globbed: (n) => `globbed ${n} pattern${n > 1 ? "s" : ""}`,
      searched: (n) => `searched ${n} pattern${n > 1 ? "s" : ""}`,
      used: (n) => `used ${n} tool${n > 1 ? "s" : ""}`,
    };

    for (const [key, count] of Object.entries(counts)) {
      parts.push(labels[key](count));
    }
  }

  if (parts.length === 0) return "";
  return parts.join(", ");
}

function TurnSummaryBlock({ message, expanded }: { message: ChatMessage; expanded: boolean }) {
  const { content: thinkingText, thinkingDuration, toolSummary = [] } = message;

  if (!thinkingDuration && toolSummary.length === 0) return null;

  // 默认显示每个工具调用的详情（参照 Claude Code），不再是统计摘要
  return (
    <Box flexDirection="column" marginBottom={0}>
      {thinkingDuration !== undefined && thinkingDuration >= 1 && (
        <Text dimColor>
          {"  "}{brand.thinking(`${symbols.thinking} `)}Thought for {Math.round(thinkingDuration)}s
        </Text>
      )}
      {toolSummary.map((t, i) => {
        const icon = t.isError ? brand.error(symbols.error) : brand.success(symbols.success);
        const timeStr = t.elapsed !== undefined ? ` (${t.elapsed.toFixed(1)}s)` : "";
        // 改动了什么代码是最高频需要的信息，EditFile 的 diff 默认展开，
        // 不用记 ctrl+o；其余工具的原始输出仍按需展开，避免刷屏。
        const isDiff = isDiffTool(t.toolName);
        const showOutput = isDiff || expanded;
        return (
          <Box key={i} flexDirection="column" marginBottom={0}>
            <Text>
              {"  "}{icon} {brand.tool(t.toolName)}
              {t.argsSummary ? <Text dimColor> {t.argsSummary}</Text> : null}
              <Text dimColor>{timeStr}</Text>
            </Text>
            {showOutput && t.output ? (
              <Box paddingLeft={4}>
                {isDiff ? (
                  <DiffLines text={t.output} />
                ) : (
                  <Text dimColor>
                    {t.output.length > 500
                      ? t.output.slice(0, 500) + "..."
                      : t.output}
                  </Text>
                )}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function MessageBlock({ message, expanded }: { message: ChatMessage; expanded: boolean }) {
  switch (message.role) {
    case "user":
      return (
        <Box marginBottom={0}>
          <Text>
            {brand.primary(`${symbols.prompt} `)}
            {message.content}
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginBottom={0}>
          <Text>{renderMarkdown(message.content)}</Text>
        </Box>
      );

    case "thinking":
      return (
        <Box marginBottom={0}>
          <Text dimColor>
            {brand.thinking(`${symbols.thinking} `)}
            {message.content.length > 200
              ? message.content.slice(0, 200) + "..."
              : message.content}
          </Text>
        </Box>
      );

    case "tool_use":
      return (
        <Box marginBottom={0}>
          <Text>
            <Text color="magenta">●</Text>
            {" "}{brand.tool(message.toolName ?? "tool")}
            {message.argsSummary ? <Text dimColor> {message.argsSummary}</Text> : null}
          </Text>
        </Box>
      );

    case "tool_result": {
      const icon = message.isError ? brand.error(symbols.error) : brand.success(symbols.success);
      const timeStr = message.elapsed !== undefined ? ` (${message.elapsed.toFixed(1)}s)` : "";
      const isDiff = isDiffTool(message.toolName ?? "");
      return (
        <Box flexDirection="column" marginBottom={0}>
          <Text>
            {icon} {brand.tool(message.toolName ?? "tool")}
            {message.argsSummary ? <Text dimColor> {message.argsSummary}</Text> : null}
            <Text dimColor>{timeStr}</Text>
          </Text>
          {message.content && (
            <Box paddingLeft={2}>
              {isDiff ? (
                <DiffLines text={message.content} />
              ) : (
                <Text dimColor>
                  {!expanded && message.content.length > 500
                    ? message.content.slice(0, 500) + "…  (ctrl+o to expand)"
                    : message.content}
                </Text>
              )}
            </Box>
          )}
        </Box>
      );
    }

    case "turn_summary":
      return <TurnSummaryBlock message={message} expanded={expanded} />;

    case "system":
      return (
        <Box marginBottom={0}>
          <Text dimColor>{message.content}</Text>
        </Box>
      );

    default:
      return null;
  }
}
