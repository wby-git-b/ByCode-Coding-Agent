#!/usr/bin/env bun

// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/config.js";
import { App } from "./tui/app.js";
import { parseTeammateFlags, runTeammate } from "./teammate.js";
import { parsePrintFlags, runPrintMode } from "./print-mode.js";
import { installSyncOutput } from "./tui/sync-output.js";

async function main() {
  const args = process.argv.slice(2);

  const teammateArgs = parseTeammateFlags(args);
  if (teammateArgs) {
    try {
      await runTeammate(teammateArgs);
    } catch (err) {
      console.error(`teammate: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // -p 模式：非交互式执行，输出结果到 stdout 后退出
  const printArgs = parsePrintFlags(args);
  if (printArgs) {
    try {
      await runPrintMode(printArgs);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // --remote 模式：启动 WebSocket 远程控制服务器，替代 TUI
  if (args.includes("--remote")) {
    const { RemoteServer } = await import("./remote/server.js");
    const server = new RemoteServer(
      cfg.providers,
      cfg.mcp_servers,
      cfg.hooks,
      ":18888"
    );
    try {
      await server.run();
      // run() 中 server.listen 回调已 resolve，但 HTTP server 持续运行。
      // 用一个永不 resolve 的 Promise 保持进程存活。
      await new Promise(() => {});
    } catch (err) {
      console.error(`Remote server error: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // DEC 2026 同步输出：将每帧 stdout 写入包裹在 BSU/ESU 中，消除闪屏
  installSyncOutput();

  const instance = render(
    <App
      providers={cfg.providers}
      mcpServers={cfg.mcp_servers}
      hooks={cfg.hooks}
      sandboxConfig={cfg.sandbox}
      enableCoordinatorMode={cfg.enable_coordinator_mode}
    />,
    { exitOnCtrlC: false }
  );
  await instance.waitUntilExit();
}

main();
