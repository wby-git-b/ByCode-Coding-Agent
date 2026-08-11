// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

// Tool activity description
export interface ToolActivity {
  toolName: string;
  input: Record<string, unknown>;
  activityDescription: string; // e.g. "Reading src/foo.ts"
}

// Aggregate progress for one teammate
export interface AgentProgress {
  toolUseCount: number;
  tokenCount: number;
  lastActivity?: ToolActivity;
  recentActivities: ToolActivity[]; // circular buffer, max 5
}

// Full teammate UI state
export interface TeammateUIState {
  name: string;
  teamName: string;
  status: "running" | "idle" | "completed" | "failed" | "stopped";
  progress: AgentProgress;
  startTime: number;
  spinnerVerb: string;
  lastMessage?: string; // last text sent to lead
}

export function createProgress(): AgentProgress {
  return {
    toolUseCount: 0,
    tokenCount: 0,
    lastActivity: undefined,
    recentActivities: [],
  };
}

// Call this on each tool_use event from the teammate's agent
export function recordToolUse(
  p: AgentProgress,
  toolName: string,
  input: Record<string, unknown>,
): void {
  p.toolUseCount++;
  const desc = describeToolActivity(toolName, input);
  const activity: ToolActivity = {
    toolName,
    input,
    activityDescription: desc,
  };
  p.lastActivity = activity;
  p.recentActivities.push(activity);
  if (p.recentActivities.length > 5) p.recentActivities.shift();
}

// Call this on each usage event
export function recordTokens(
  p: AgentProgress,
  inputTokens: number,
  outputTokens: number,
): void {
  p.tokenCount = inputTokens + outputTokens;
}

// Generate human-readable description for a tool use
function describeToolActivity(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "ReadFile":
      return `Reading ${input.file_path ?? "file"}`;
    case "EditFile":
      return `Editing ${input.file_path ?? "file"}`;
    case "WriteFile":
      return `Writing ${input.file_path ?? "file"}`;
    case "Bash": {
      const cmd = String(input.command ?? "");
      return `Running ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
    }
    case "Glob":
      return `Searching ${input.pattern ?? "files"}`;
    case "Grep":
      return `Grepping ${input.pattern ?? "pattern"}`;
    default:
      return toolName;
  }
}

// Summarize recent activities for display
export function summarizeActivities(activities: ToolActivity[]): string {
  if (!activities.length) return "";
  // If last activity has a description, use it
  return activities[activities.length - 1]!.activityDescription;
}

export function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
