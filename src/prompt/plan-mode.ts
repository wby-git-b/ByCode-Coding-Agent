// 来源：公众号@小林coding
// 后端八股网站：xiaolincoding.com
// Agent网站：xiaolinnote.com
// 简历模版：jianli.xiaolinnote.com

// Plan Mode 完整提示：首次迭代和每 reminderInterval 次迭代时展示
const planModeFullReminder = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
%PLAN_FILE_INFO%
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should use the Agent tool with subagent_type="explore".

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. **Call the Agent tool with subagent_type="explore" to explore the codebase.** You can launch up to 3 explore agents IN PARALLEL by making multiple Agent tool calls in a single response.

### Phase 2: Design
Goal: Design an implementation approach.

Call the Agent tool with subagent_type="plan" to design the implementation based on the user's intent and your exploration results from Phase 1.

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use AskUserQuestion to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section
- Include only your recommended approach
- Include the paths of critical files to be modified
- Include a verification section

### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode.`;

// Plan Mode 精简提示：中间迭代时只展示关键规则
const planModeSparseReminder =
  "Plan mode still active (see full instructions earlier in conversation). " +
  "Read-only except plan file (%PLAN_PATH%). Follow 5-phase workflow. " +
  "End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). " +
  "Never ask about plan approval via text or AskUserQuestion.";

// 退出 Plan Mode 的提示
const planModeExitTemplate =
  "## Exited Plan Mode\n\n" +
  "You have exited plan mode. You can now make edits, run tools, and take actions.%EXTRA%";

// 重新进入 Plan Mode 的提示：提醒模型此前已有 plan 文件，可以继续编辑
const planModeReentryTemplate =
  "You have re-entered plan mode. Your previous plan file is at %PLAN_PATH%. " +
  "Review it and continue from where you left off. You can update, refine, or " +
  "restart the plan as needed. Follow the same 5-phase workflow as before.";

// 每隔多少次迭代重复一次完整提示
const reminderInterval = 5;

/**
 * 构建 Plan Mode 提示，根据迭代次数在完整/精简提示之间切换。
 * iteration=1 时始终展示完整提示；之后每 reminderInterval 次重复完整提示，
 * 其余迭代返回精简提示以节省 token。
 */
export function buildPlanModeReminder(
  planPath: string,
  planExist: boolean,
  iteration: number
): string {
  // 构造 plan 文件信息段
  let planFileInfo = `Plan file: ${planPath}`;
  if (planExist) {
    planFileInfo += `\nA plan file already exists at ${planPath}. You can read it and make incremental edits using the EditFile tool.`;
  } else {
    planFileInfo += `\nNo plan file exists yet. You should create your plan at ${planPath} using the WriteFile tool.`;
  }

  // 首次迭代始终展示完整提示
  if (iteration === 1) {
    return planModeFullReminder.replace("%PLAN_FILE_INFO%", planFileInfo);
  }

  // 每 reminderInterval 次重复完整提示
  const attachmentIndex = Math.floor((iteration - 1) / reminderInterval);
  if (attachmentIndex % reminderInterval === 0) {
    return planModeFullReminder.replace("%PLAN_FILE_INFO%", planFileInfo);
  }

  // 中间迭代使用精简提示
  return planModeSparseReminder.replace("%PLAN_PATH%", planPath);
}

/**
 * 构建退出 Plan Mode 后的提示。
 * 如果 plan 文件存在，提示模型引用该文件路径。
 */
export function buildPlanModeExitReminder(
  planPath: string,
  planExists: boolean
): string {
  let extra = "";
  if (planExists) {
    extra = ` The plan file is located at ${planPath} if you need to reference it.`;
  }
  return planModeExitTemplate.replace("%EXTRA%", extra);
}

/**
 * 构建重新进入 Plan Mode 时的提示。
 * 仅在已有 plan 文件时返回非空内容，提醒模型继续编辑现有计划。
 */
export function buildPlanModeReentryReminder(
  planPath: string,
  planFileExists: boolean
): string {
  if (!planFileExists) {
    return "";
  }
  return planModeReentryTemplate.replace("%PLAN_PATH%", planPath);
}
