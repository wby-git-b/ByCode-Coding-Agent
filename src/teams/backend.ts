// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { execSync, spawn } from "node:child_process";
import type { TeamMode } from "./team.js";

/**
 * Auto-detect the best backend for running teammates.
 *
 * Claude Code's 'auto' logic (which we mirror):
 *   - Default to **in-process** so progress tracking works (agent events
 *     flow in the same process and can update the Spinner Tree in real time).
 *   - Only use tmux/iTerm panes when the user explicitly requests it via
 *     config `teammateMode: "tmux"`.
 *
 * In-process teammates share the Node.js event loop but are context-isolated.
 * They communicate via the same file-based mailbox as external teammates.
 */
export function detectBackend(): TeamMode {
  return "in-process";
}

/**
 * Detect available pane backend (for explicit tmux mode).
 * Used when the user overrides teammateMode to "tmux".
 */
export function detectPaneBackend(): TeamMode {
  if (process.env.TMUX) return "tmux";
  try {
    execSync("which tmux", { stdio: ["pipe", "pipe", "pipe"] });
    return "tmux";
  } catch {
    // tmux not found
  }
  return "in-process";
}

export interface SpawnConfig {
  mode: TeamMode;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export function spawnTeammate(config: SpawnConfig): {
  cancel: () => void;
  paneId?: string;
} {
  switch (config.mode) {
    case "in-process": {
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...config.env },
      });
      return {
        cancel: () => child.kill("SIGTERM"),
      };
    }

    case "tmux": {
      const sessionName = `mewcode-${Date.now().toString(36)}`;
      const cmd = [config.command, ...config.args].join(" ");
      try {
        execSync(
          `tmux new-window -t "${sessionName}" -n teammate "${cmd}"`,
          {
            cwd: config.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      } catch {
        // Create new session if window fails
        execSync(
          `tmux new-session -d -s "${sessionName}" -n teammate "${cmd}"`,
          {
            cwd: config.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      }
      return {
        cancel: () => {
          try {
            execSync(`tmux kill-session -t "${sessionName}"`, {
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch {
            // session may already be dead
          }
        },
        paneId: sessionName,
      };
    }

    case "iterm":
      throw new Error("iTerm backend not supported on this platform");

    default:
      throw new Error(`Unknown team mode: ${config.mode}`);
  }
}
