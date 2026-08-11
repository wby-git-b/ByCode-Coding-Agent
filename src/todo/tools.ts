// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

import type { Tool, ToolResult, ToolContext } from "../tools/types.js";
import { strArg } from "../tools/types.js";
import type { TaskList } from "./todo.js";

export class TaskCreateTool implements Tool {
  name = "TaskCreate";
  description = "Create a new task to track work.";
  category = "read" as const;
  system = true;
  deferred = true;
  private list: TaskList;

  constructor(list: TaskList) { this.list = list; }

  schema(): Record<string, unknown> {
    return {
      name: this.name, description: this.description,
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Brief task title" },
          description: { type: "string", description: "What needs to be done" },
          activeForm: { type: "string", description: "Present continuous form for spinner" },
        },
        required: ["subject", "description"],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const subject = strArg(args, "subject");
    const description = strArg(args, "description");
    const activeForm = strArg(args, "activeForm") || undefined;
    if (!subject) return { output: "Error: subject is required", isError: true };
    const task = this.list.create(subject, description, activeForm);
    return { output: `Task #${task.id} created successfully: ${task.subject}`, isError: false };
  }
}

export class TaskGetTool implements Tool {
  name = "TaskGet";
  description = "Get a task by its ID.";
  category = "read" as const;
  system = true;
  deferred = true;
  private list: TaskList;

  constructor(list: TaskList) { this.list = list; }

  schema(): Record<string, unknown> {
    return {
      name: this.name, description: this.description,
      input_schema: {
        type: "object",
        properties: { taskId: { type: "string", description: "Task ID" } },
        required: ["taskId"],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = strArg(args, "taskId");
    const task = this.list.get(id);
    if (!task) return { output: "Task not found", isError: true };
    return { output: JSON.stringify(task, null, 2), isError: false };
  }
}

export class TaskListTool implements Tool {
  name = "TaskList";
  description = "List all tasks.";
  category = "read" as const;
  system = true;
  deferred = true;
  private list: TaskList;

  constructor(list: TaskList) { this.list = list; }

  schema(): Record<string, unknown> {
    return {
      name: this.name, description: this.description,
      input_schema: { type: "object", properties: {} },
    };
  }

  async execute(): Promise<ToolResult> {
    const tasks = this.list.list();
    if (tasks.length === 0) return { output: "No tasks found", isError: false };
    const lines = tasks.map((t) =>
      `#${t.id}. [${t.status}] ${t.subject}${t.owner ? ` (${t.owner})` : ""}`
    );
    return { output: lines.join("\n"), isError: false };
  }
}

export class TaskUpdateTool implements Tool {
  name = "TaskUpdate";
  description = "Update a task's status, subject, or other fields.";
  category = "read" as const;
  system = true;
  deferred = true;
  private list: TaskList;

  constructor(list: TaskList) { this.list = list; }

  schema(): Record<string, unknown> {
    return {
      name: this.name, description: this.description,
      input_schema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task ID" },
          status: { type: "string", description: "New status: pending, in_progress, completed, deleted" },
          subject: { type: "string", description: "New subject" },
          description: { type: "string", description: "New description" },
          owner: { type: "string", description: "New owner" },
          addBlocks: { type: "array", items: { type: "string" }, description: "Tasks this one blocks" },
          addBlockedBy: { type: "array", items: { type: "string" }, description: "Tasks blocking this one" },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = strArg(args, "taskId");
    if (!id) return { output: "Error: taskId is required", isError: true };

    if (args.status === "deleted") {
      this.list.delete(id);
      return { output: `Task #${id} deleted`, isError: false };
    }

    const updates: Record<string, unknown> = {};
    if (args.status) updates.status = args.status;
    if (args.subject) updates.subject = args.subject;
    if (args.description) updates.description = args.description;
    if (args.owner) updates.owner = args.owner;

    const task = this.list.update(id, updates);
    if (!task) return { output: "Task not found", isError: true };

    if (Array.isArray(args.addBlocks)) {
      this.list.addBlocks(id, args.addBlocks as string[]);
    }
    if (Array.isArray(args.addBlockedBy)) {
      this.list.addBlockedBy(id, args.addBlockedBy as string[]);
    }

    return { output: `Updated task #${id} status`, isError: false };
  }
}
