// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

export interface AgentTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  output: string;
  cancel: () => void;
}

export class TaskManager {
  private tasks = new Map<string, AgentTask>();
  private nextId = 1;

  create(
    name: string,
    runner: () => Promise<string>,
    cancel: () => void
  ): AgentTask {
    const id = String(this.nextId++);
    const task: AgentTask = {
      id,
      name,
      status: "running",
      output: "",
      cancel,
    };
    this.tasks.set(id, task);

    runner()
      .then((output) => {
        task.status = "completed";
        task.output = output;
      })
      .catch((err) => {
        task.status = "failed";
        task.output = `Error: ${(err as Error).message}`;
      });

    return task;
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): AgentTask[] {
    return [...this.tasks.values()];
  }

  stop(id: string): void {
    const task = this.tasks.get(id);
    if (task && task.status === "running") {
      task.cancel();
      task.status = "failed";
      task.output = "Stopped by user";
    }
  }

  drainNotifications(): AgentTask[] {
    const completed: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "running") {
        completed.push(task);
      }
    }
    return completed;
  }
}
