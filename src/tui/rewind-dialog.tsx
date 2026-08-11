// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Snapshot } from "../filehistory/filehistory.js";
import { brand, symbols } from "./styles.js";

export type RewindAction =
  | { type: "code_and_conversation"; snapshotIndex: number }
  | { type: "conversation_only"; snapshotIndex: number }
  | { type: "code_only"; snapshotIndex: number }
  | { type: "cancel" };

interface Props {
  snapshots: Snapshot[];
  onComplete: (action: RewindAction) => void;
  onCancel: () => void;
}

const RESTORE_OPTIONS = [
  "Restore code and conversation",
  "Restore conversation only",
  "Restore code only",
  "Never mind",
];

export function RewindDialog({ snapshots, onComplete, onCancel }: Props) {
  const [phase, setPhase] = useState<0 | 1>(0);
  const [cursor, setCursor] = useState(snapshots.length - 1);
  const [optionCursor, setOptionCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (phase === 0) {
      if (key.upArrow) {
        setCursor((c) => (c > 0 ? c - 1 : snapshots.length - 1));
      } else if (key.downArrow) {
        setCursor((c) => (c < snapshots.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        setSelectedIndex(cursor);
        setPhase(1);
        setOptionCursor(0);
      } else if (key.escape) {
        onCancel();
      }
    } else {
      if (key.upArrow) {
        setOptionCursor((c) => (c > 0 ? c - 1 : RESTORE_OPTIONS.length - 1));
      } else if (key.downArrow) {
        setOptionCursor((c) => (c < RESTORE_OPTIONS.length - 1 ? c + 1 : 0));
      } else if (key.return) {
        switch (optionCursor) {
          case 0:
            onComplete({ type: "code_and_conversation", snapshotIndex: selectedIndex });
            break;
          case 1:
            onComplete({ type: "conversation_only", snapshotIndex: selectedIndex });
            break;
          case 2:
            onComplete({ type: "code_only", snapshotIndex: selectedIndex });
            break;
          case 3:
            onComplete({ type: "cancel" });
            break;
        }
      } else if (key.escape) {
        setPhase(0);
      }
    }
  });

  if (phase === 0) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text bold>{brand.primary("⟲ Rewind to checkpoint")}</Text>
        <Text> </Text>
        {snapshots.map((snap, i) => {
          const fileCount = Object.keys(snap.backups).length;
          const ago = formatAgo(snap.timestamp);
          const isSelected = i === cursor;
          return (
            <Box key={i}>
              <Text>
                {isSelected ? brand.primary(`${symbols.prompt} `) : "  "}
                {isSelected ? brand.bright(`[${i + 1}]`) : `[${i + 1}]`}
                {" "}
                {snap.userText || "(empty)"}
                <Text dimColor> ({ago}, {fileCount} file(s))</Text>
              </Text>
            </Box>
          );
        })}
        <Text dimColor>{"\n↑/↓ navigate · enter select · esc cancel"}</Text>
      </Box>
    );
  }

  const snap = snapshots[selectedIndex];
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold>{brand.primary("⟲ Rewind to checkpoint")}</Text>
      <Text> </Text>
      <Text dimColor>
        Selected: [{selectedIndex + 1}] {snap.userText}
      </Text>
      <Text> </Text>
      {RESTORE_OPTIONS.map((opt, i) => (
        <Box key={i}>
          <Text>
            {i === optionCursor ? brand.primary(`${symbols.prompt} `) : "  "}
            {i === optionCursor ? brand.bright(opt) : opt}
          </Text>
        </Box>
      ))}
      <Text dimColor>{"\n↑/↓ navigate · enter select · esc back"}</Text>
    </Box>
  );
}

function formatAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
