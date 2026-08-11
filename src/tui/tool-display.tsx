// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React from "react";
import { Box, Text } from "ink";
import { brand, symbols } from "./styles.js";
import { DiffLines, isDiffTool } from "./diff-render.js";

export interface ToolBlockInfo {
  toolName: string;
  args: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  elapsed?: number;
  loading?: boolean;
}

interface Props {
  tools: ToolBlockInfo[];
}

export function ToolDisplay({ tools }: Props) {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {tools.map((t, i) => (
        <ToolBlock key={i} tool={t} />
      ))}
    </Box>
  );
}

function ToolBlock({ tool }: { tool: ToolBlockInfo }) {
  const argSummary = formatArgs(tool.args);

  if (tool.loading) {
    return (
      <Box>
        <Text>
          <Text color="magenta">●</Text>
          {" "}
          {brand.tool(tool.toolName)}
          {argSummary ? <Text dimColor> {argSummary}</Text> : null}
        </Text>
      </Box>
    );
  }

  const icon = tool.isError ? brand.error(symbols.error) : brand.success(symbols.success);
  const timeStr = tool.elapsed !== undefined ? ` (${tool.elapsed.toFixed(1)}s)` : "";

  return (
    <Box flexDirection="column">
      <Text>
        {icon} {brand.tool(tool.toolName)}
        {argSummary ? <Text dimColor> {argSummary}</Text> : null}
        <Text dimColor>{timeStr}</Text>
      </Text>
      {tool.output && (
        <Box paddingLeft={2} marginBottom={0}>
          {isDiffTool(tool.toolName) ? (
            <DiffLines text={tool.output} />
          ) : (
            <Text dimColor>
              {tool.output.length > 500
                ? tool.output.slice(0, 500) + "…"
                : tool.output}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  if (args.command) return truncate(String(args.command), 80);
  if (args.file_path) return truncate(String(args.file_path), 80);
  if (args.pattern) return truncate(String(args.pattern), 80);
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
