import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { collectEvents, wait } from '../../helpers/setup';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import { AgentTemplate, createTaskRunTool } from '../../../src/tools/task_run';
import { ContentBlock, ToolOutcome } from '../../../src/core/types';
import { ModelResponse } from '../../../src/infra/provider';

const runner = new TestRunner('集成测试 - 复合能力流程');

runner.test('Hook + Todo + 审批 + 子代理 + 文件操作', async () => {
  const templateCounters = {
    pre: 0,
    post: 0,
    messagesChanged: 0,
  };

  const toolCounters = {
    pre: 0,
    post: 0,
  };

  const notedStages: string[] = [];
  let currentStage = '阶段1';

  const hookProbe = tool({
    name: 'hook_probe',
    description: 'Emit detailed monitor events for hook lifecycle validation.',
    parameters: z.object({
      note: z.string(),
    }),
    async execute(args: { note: string }, ctx: EnhancedToolContext) {
      const note = args.note || currentStage;
      notedStages.push(note);
      ctx.emit('hook_probe', { stage: currentStage, note });
      return { ok: true, note };
    },
    hooks: {
      preToolUse: async () => {
        toolCounters.pre += 1;
      },
      postToolUse: async (outcome: ToolOutcome) => {
        toolCounters.post += 1;
        return { replace: outcome };
      },
    },
  });

  const subAgentSystemPrompt = 'You are a concise reviewer. Summarise the latest progress in two short bullet points.';

  const subAgentTemplate: AgentTemplate = {
    id: 'composite-subagent',
    system: subAgentSystemPrompt,
    tools: ['todo_read'],
    whenToUse: 'Summarise todo status for verification.',
  };

  const taskRunTool = createTaskRunTool([subAgentTemplate]);

  const template = {
    id: 'integration-composite-flow',
    systemPrompt: [
      'You are a test assistant that follows instructions precisely.',
      'Before responding to any instruction you MUST call hook_probe with a stage-aware note.',
      'When the user asks to manage todos, always use todo tools. For file edits use fs_write/fs_read only.',
      'Always call tools when asked. Do not ask for confirmation, just execute.',
    ].join('\n'),
    tools: ['hook_probe', 'todo_write', 'todo_read', 'fs_write', 'fs_read', 'task_run'],
    permission: { mode: 'auto' as const, requireApprovalTools: ['fs_write'] as const },
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
    },
    hooks: {
      preModel: async () => {
        templateCounters.pre += 1;
      },
      postModel: async (response: ModelResponse) => {
        templateCounters.post += 1;
        const block = (response.content as ContentBlock[] | undefined)?.find(
          (entry): entry is Extract<ContentBlock, { type: 'text' }> => entry.type === 'text'
        );
        if (block) {
          block.text = `${block.text}\n【阶段: ${currentStage}】`;
        }
      },
      messagesChanged: async (snapshot: { messages?: Array<{ role: string }> }) => {
        templateCounters.messagesChanged += 1;
      },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate: template,
    registerTools: (registry) => {
      registry.register(hookProbe.name, () => hookProbe);
      registry.register(taskRunTool.name, () => taskRunTool);
    },
    registerTemplates: (registry) => {
      registry.register({
        id: subAgentTemplate.id,
        systemPrompt: subAgentSystemPrompt,
        tools: subAgentTemplate.tools,
      });
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir, '工作目录未初始化');
  const approvalFile = path.join(workDir!, 'approval-target.txt');
  fs.writeFileSync(approvalFile, '初始内容 - 待覆盖');

  // 阶段 1：创建 Todo 并触发 Hook
  currentStage = '阶段1-初始化';
  const stage1 = await harness.chatStep({
    label: '阶段1',
    prompt:
      '请调用 hook_probe 工具记录“阶段1初始化”，然后创建一个标题为《复合测试任务》的 todo 并告诉我当前 todo 状态。',
    expectation: {
      includes: ['复合测试任务'],
    },
  });

  const todosAfterStage1 = agent.getTodos();
  expect.toEqual(todosAfterStage1.length, 1);
  expect.toEqual(todosAfterStage1[0].title.includes('复合测试任务'), true);

  // 验证 postModel hook 的文本修改副作用：至少在阶段1的响应中包含 hook 注入的标记
  expect.toBeTruthy(
    stage1.reply?.text?.includes('【阶段:'),
    `postModel hook 应在文本响应中注入阶段标记, got: ${(stage1.reply?.text || '').slice(-80)}`
  );

  const monitorEventsStage1 = stage1.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEventsStage1.length, 1);

  // 阶段 2：触发审批并修改文件
  currentStage = '阶段2-审批';
  const permissionRequired = collectEvents(agent, ['control'], (event) => event.type === 'permission_required');

  const stage2 = await harness.chatStep({
    label: '阶段2',
    prompt:
      `调用 fs_write 工具写入文件，path 为 "approval-target.txt"，content 为 "审批完成，文件已更新"。然后用 todo_write 把 todo 状态改为 completed。`,
  });

  const permissionEvents = await permissionRequired;
  expect.toBeGreaterThanOrEqual(permissionEvents.length, 1);
  expect.toBeGreaterThanOrEqual(
    stage2.events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_decided').length,
    1
  );
  expect.toBeGreaterThanOrEqual(
    stage2.events.filter((evt) => evt.channel === 'progress' && evt.event.type === 'tool:start').length,
    1
  );

  const contentAfterApproval = fs.readFileSync(approvalFile, 'utf-8');
  // 验证文件被修改（接受精确匹配或任何变化）
  const fileWasModified = contentAfterApproval.includes('审批完成') ||
    contentAfterApproval !== '初始内容 - 待覆盖';
  expect.toBeTruthy(fileWasModified, `Expected file to be modified, got: ${contentAfterApproval.slice(0, 100)}`);

  // 阶段 3：调用子代理汇总
  const stage3TodoSnapshot = JSON.stringify(harness.getAgent().getTodos(), null, 2);
  const subAgentResult = await harness.delegateTask({
    label: '阶段3-子代理',
    templateId: subAgentTemplate.id,
    prompt: [
      '请汇总当前复合测试的todo状态，输出两条要点。保留todo的表述，不要转换含义或表达方式。',
      '以下是主代理的 todo 列表（JSON），仅基于该列表总结，不要调用任何工具：',
      stage3TodoSnapshot,
    ].join('\n'),
    tools: subAgentTemplate.tools,
  });
  expect.toEqual(subAgentResult.status, 'ok');
  expect.toBeTruthy(subAgentResult.text && subAgentResult.text.includes('todo'));

  // 阶段 4：Resume 后继续对话
  const agentBeforeStage4 = harness.getAgent() as any;
  await harness.resume('阶段4');
  await agentBeforeStage4.sandbox?.dispose?.();
  currentStage = '阶段4-Resume';

  const stage4 = await harness.chatStep({
    label: '阶段4',
    prompt:
      '请再次调用 hook_probe 工具记录“阶段4Resume确认”，然后报告 todo 是否仍为完成状态，并确认文件更新已生效。',
    expectation: {
      includes: ['完成'],
    },
  });

  const todosAfterResume = harness.getAgent().getTodos();
  expect.toEqual(todosAfterResume.length, 1);
  expect.toEqual(todosAfterResume[0].status, 'completed');

  const resumeMonitorEvents = stage4.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(resumeMonitorEvents.length, 1);

  // 阶段 5：再次 Resume，验证事件回放与自定义工具/子代理协作
  const statusBeforeSecondResume = await harness.getAgent().status();
  expect.toBeTruthy(statusBeforeSecondResume.lastBookmark);

  const agentBeforeStage5 = harness.getAgent() as any;
  await harness.resume('阶段5');
  await agentBeforeStage5.sandbox?.dispose?.();
  currentStage = '阶段5-再Resume';

  const replayOptions = statusBeforeSecondResume.lastBookmark
    ? { since: statusBeforeSecondResume.lastBookmark }
    : undefined;

  const replayPromise = collectEvents(
    harness.getAgent(),
    ['monitor'],
    (event) => event.type === 'tool_custom_event',
    replayOptions
  );

  const stage5 = await harness.chatStep({
    label: '阶段5',
    prompt:
      '请调用 hook_probe 工具记录"阶段5连续验证"，重新打开 todo 并标记为进行中，然后再完成它，最后用文字总结进度。',
  });

  const replayedMonitorEvents = await replayPromise;
  expect.toBeGreaterThanOrEqual(replayedMonitorEvents.length, 1);
  expect.toEqual(
    replayedMonitorEvents.some((event: any) => event.type === 'tool_custom_event'),
    true
  );

  const subAgentAfterSecondResume = await harness.delegateTask({
    label: '阶段5-子代理',
    templateId: subAgentTemplate.id,
    prompt: [
      '请再次总结当前 todo 的最新状态，并说明已经经历过多次 Resume 验证。',
      '以下是主代理的 todo 列表（JSON），仅基于该列表总结，不要调用任何工具：',
      JSON.stringify(harness.getAgent().getTodos(), null, 2),
    ].join('\n'),
    tools: subAgentTemplate.tools,
  });
  expect.toEqual(subAgentAfterSecondResume.status, 'ok');
  expect.toBeTruthy(subAgentAfterSecondResume.text && subAgentAfterSecondResume.text.includes('Resume'));

  const todosAfterSecondResume = harness.getAgent().getTodos();
  expect.toEqual(todosAfterSecondResume.length, 1);
  expect.toEqual(todosAfterSecondResume[0].status, 'completed');

  const todoEventsStage5 = stage5.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'todo_changed'
  );
  expect.toBeGreaterThanOrEqual(todoEventsStage5.length, 1);

  // 断言 Hook 统计数据
  expect.toBeGreaterThanOrEqual(templateCounters.pre, 5);
  expect.toBeGreaterThanOrEqual(templateCounters.post, 5);
  expect.toBeGreaterThanOrEqual(templateCounters.messagesChanged, 5);
  expect.toBeGreaterThanOrEqual(toolCounters.pre, 5);
  expect.toBeGreaterThanOrEqual(toolCounters.post, 5);

  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段1')));
  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段4')));
  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段5')));

  const monitorEvents = [...stage1.events, ...stage2.events, ...stage4.events, ...stage5.events].filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEvents.length, 4);

  await wait(200);
  const agentForDispose = harness.getAgent() as any;
  await agentForDispose.sandbox?.dispose?.();
  await harness.cleanup();
});

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
