// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import type { TeamManager, RunAgent } from "./team.js";

function obj(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties: props, required };
}

export class TeamCreateTool implements Tool {
  name = "TeamCreate";
  description = "Create a team for coordinating multiple agents.";
  category = "read" as const;
  system = true;
  constructor(private mgr: TeamManager) {}
  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj({ name: { type: "string", description: "Team name" } }, ["name"]),
    };
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = strArg(args, "name");
    if (!name) return { output: "Error: name is required", isError: true };
    if (this.mgr.get(name)) return { output: `Team '${name}' already exists.`, isError: false };
    this.mgr.create(name);
    return { output: `Team '${name}' created.`, isError: false };
  }
}

export class SpawnTeammateTool implements Tool {
  name = "SpawnTeammate";
  description =
    "Spawn a teammate in a team to work on a task in the background. Its result is delivered back to you on the team channel when it finishes.";
  category = "read" as const;
  system = true;
  constructor(
    private mgr: TeamManager,
    private runAgent: RunAgent
  ) {}
  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj(
        {
          team: { type: "string", description: "Team name (created if missing)" },
          name: { type: "string", description: "Teammate name" },
          task: { type: "string", description: "The task for the teammate" },
        },
        ["team", "name", "task"]
      ),
    };
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const team = strArg(args, "team");
    const name = strArg(args, "name");
    const task = strArg(args, "task");
    if (!team || !name || !task) {
      return { output: "Error: team, name and task are required", isError: true };
    }
    const t = this.mgr.get(team) ?? this.mgr.create(team);
    t.spawnTeammate(name, task, this.runAgent);
    return {
      output: `Teammate '${name}' spawned in team '${team}'. Its result will arrive on the team channel; keep working and watch for it.`,
      isError: false,
    };
  }
}

export class SendMessageTool implements Tool {
  name = "SendMessage";
  description = "Send a message to a teammate's mailbox.";
  category = "read" as const;
  system = true;
  constructor(private mgr: TeamManager) {}
  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj(
        {
          team: { type: "string" },
          to: { type: "string", description: "Teammate name" },
          message: { type: "string" },
        },
        ["team", "to", "message"]
      ),
    };
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const team = strArg(args, "team");
    const to = strArg(args, "to");
    const message = strArg(args, "message");
    const t = this.mgr.get(team);
    if (!t) return { output: `Team '${team}' not found.`, isError: true };
    try {
      await t.sendMessage("lead", to, message);
    } catch (e) {
      return { output: `Error: ${(e as Error).message}`, isError: true };
    }
    return { output: `Message sent to '${to}'.`, isError: false };
  }
}

export class ListTeamsTool implements Tool {
  name = "ListTeams";
  description = "List teams and their members.";
  category = "read" as const;
  system = true;
  constructor(private mgr: TeamManager) {}
  schema(): Record<string, unknown> {
    return { name: this.name, description: this.description, input_schema: obj({}, []) };
  }
  async execute(): Promise<ToolResult> {
    const teams = this.mgr.list();
    if (teams.length === 0) return { output: "No teams.", isError: false };
    const lines = teams.map((t) => {
      const members =
        t.listMembers().map((m) => `${m.name}${m.active ? " (active)" : ""}`).join(", ") || "(no members)";
      return `${t.name} [${t.mode}]: ${members}`;
    });
    return { output: lines.join("\n"), isError: false };
  }
}

export class TeamDeleteTool implements Tool {
  name = "TeamDelete";
  description = "Delete a team and stop its members.";
  category = "read" as const;
  system = true;
  constructor(private mgr: TeamManager) {}
  schema(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: obj({ name: { type: "string" } }, ["name"]),
    };
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = strArg(args, "name");
    await this.mgr.delete(name);
    return { output: `Team '${name}' deleted.`, isError: false };
  }
}
