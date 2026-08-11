// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import { loadConfig } from "./config/config.js";
import { createClient } from "./llm/client.js";
import { ConversationManager } from "./conversation/conversation.js";
import { buildSystemPrompt, detectEnvironment } from "./prompt/builder.js";
import { ToolRegistry } from "./tools/registry.js";
import { ReadFileTool } from "./tools/read-file.js";
import { BashTool } from "./tools/bash.js";
import { GlobTool } from "./tools/glob.js";
import { GrepTool } from "./tools/grep.js";
import { WriteFileTool } from "./tools/write-file.js";
import { EditFileTool } from "./tools/edit-file.js";
import { PermissionChecker } from "./permissions/checker.js";
import { Agent } from "./agent/agent.js";
import { FileStateCache } from "./tools/file-state-cache.js";
import { FileMailbox, FileMailMessage } from "./teams/file-mailbox.js";

interface TeammateArgs {
  teamDir: string;
  memberName: string;
  initialTask: string;
  providerName?: string;
}

export function parseTeammateFlags(args: string[]): TeammateArgs | null {
  if (!args.includes("--teammate")) return null;

  let teamDir = "";
  let memberName = "";
  let initialTask = "";
  let providerName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--team-dir" && args[i + 1]) teamDir = args[++i];
    if (args[i] === "--member-name" && args[i + 1]) memberName = args[++i];
    if (args[i] === "--task" && args[i + 1]) initialTask = args[++i];
    if (args[i] === "--provider" && args[i + 1]) providerName = args[++i];
  }

  if (!teamDir || !memberName || !initialTask) return null;
  return { teamDir, memberName, initialTask, providerName };
}

// ShutdownPrefix marks a mailbox message as a request to terminate the teammate.
const ShutdownPrefix = "[shutdown]";

// LeadName is the conventional mailbox recipient for the coordinator.
const LeadName = "lead";

function isShutdownRequest(msg: FileMailMessage): boolean {
  return msg.text.trimStart().startsWith(ShutdownPrefix);
}

function createIdleNotification(memberName: string): FileMailMessage {
  return {
    from: memberName,
    text: `[idle] ${memberName} has completed their task and is waiting for new instructions.`,
    timestamp: new Date().toISOString(),
  };
}

export async function runTeammate(args: TeammateArgs): Promise<void> {
  const cfg = loadConfig();
  const provider = args.providerName
    ? cfg.providers.find((p) => p.name === args.providerName) ?? cfg.providers[0]
    : cfg.providers[0];

  const env = detectEnvironment(process.cwd());
  env.model = provider.model;
  const systemPrompt = buildSystemPrompt(env);
  const client = await createClient(provider, systemPrompt);

  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  registry.register(new BashTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WriteFileTool());
  registry.register(new EditFileTool());

  const conv = new ConversationManager();
  const checker = new PermissionChecker(process.cwd(), "acceptEdits");

  const agent = new Agent({
    client,
    registry,
    checker,
    conversation: conv,
    workDir: process.cwd(),
    fileStateCache: new FileStateCache(),
  });

  // Start with initial task
  conv.addUserMessage(args.initialTask);

  let output = "";
  for await (const event of agent.run()) {
    switch (event.type) {
      case "stream_text":
        output += event.text;
        process.stdout.write(event.text);
        break;
      case "tool_result":
        console.log(`[${event.toolName}] ${event.isError ? "ERROR" : "OK"} (${event.elapsed.toFixed(1)}s)`);
        break;
      case "loop_complete":
        console.log("\n--- Task complete ---");
        break;
      case "error":
        console.error(`Error: ${event.error.message}`);
        break;
    }
  }

  // Notify the lead that this teammate finished its initial task.
  const mailbox = new FileMailbox(args.teamDir, args.memberName);
  const leadMailbox = new FileMailbox(args.teamDir, LeadName);
  await leadMailbox.send(args.memberName, createIdleNotification(args.memberName).text);

  // Poll mailbox for follow-up messages
  for await (const msg of mailbox.poll(2000)) {
    // Graceful shutdown: stop polling and exit when the lead requests it.
    if (isShutdownRequest(msg)) {
      console.log(`\n[Shutdown requested] ${args.memberName} exiting.`);
      break;
    }

    console.log(`\n[Message from ${msg.from}]: ${msg.text}`);
    conv.addUserMessage(msg.text);
    for await (const event of agent.run()) {
      if (event.type === "stream_text") {
        process.stdout.write(event.text);
      }
    }

    // Notify the lead after completing each follow-up task.
    await leadMailbox.send(args.memberName, createIdleNotification(args.memberName).text);
  }
}
