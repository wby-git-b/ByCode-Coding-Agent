// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React from "react";
import { Box, Text } from "ink";

interface Props {
  from: string;
  content: string;
  type?: "idle" | "completed" | "text" | "shutdown";
}

/**
 * Renders a teammate message in the chat view.
 *
 * - idle / shutdown: silent (return null)
 * - completed: green checkmark + content
 * - text (default): cyan @name with content summary
 */
export function TeammateMessage({ from, content, type = "text" }: Props) {
  if (type === "idle" || type === "shutdown") {
    return null;
  }

  if (type === "completed") {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">@{from}</Text>
          <Text>❯ </Text>
          <Text color="green">✓</Text>
          <Text> Task completed</Text>
        </Text>
        {content ? (
          <Text>{"  "}{content}</Text>
        ) : null}
      </Box>
    );
  }

  // type === "text" (default)
  const lines = content.split("\n");
  const summary = lines[0] ?? "";
  const rest = lines.slice(1).join("\n").trimStart();

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">@{from}</Text>
        <Text>❯ </Text>
        <Text>{summary}</Text>
      </Text>
      {rest ? (
        <Text>{"  "}{rest}</Text>
      ) : null}
    </Box>
  );
}

// Regex for "[team xxx] sender: message" format produced by drainLeads.
const teamMsgRe = /^\[team\s+\S+\]\s+(\S+):\s+(.*)$/s;

// Prefixes that indicate special message types.
const idleRe = /^\[idle\]\s*/;
const shutdownRe = /^\[shutdown\]\s*/;

/**
 * Parses a raw drainLeads string into structured teammate message fields.
 *
 * Recognised formats:
 *   "[team alpha] alice: [idle] alice has completed..."  -> { from: "alice", type: "idle", ... }
 *   "[team alpha] bob: [shutdown] ..."                   -> { from: "bob",   type: "shutdown", ... }
 *   "[team alpha] carol: here is my update"              -> { from: "carol", type: "text", ... }
 *
 * Returns null when the string is not a teammate message.
 */
export function parseTeammateMessage(
  raw: string,
): { from: string; content: string; type: string } | null {
  const m = teamMsgRe.exec(raw);
  if (!m) return null;

  const from = m[1];
  let body = m[2];

  if (idleRe.test(body)) {
    return { from, content: body.replace(idleRe, ""), type: "idle" };
  }
  if (shutdownRe.test(body)) {
    return { from, content: body.replace(shutdownRe, ""), type: "shutdown" };
  }

  return { from, content: body, type: "text" };
}
