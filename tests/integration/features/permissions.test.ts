import fs from 'fs';
import path from 'path';
import { collectEvents, wait } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - 权限审批');

runner.test('审批后工具继续执行', async () => {
  const workDir = path.join(__dirname, '../../tmp/integration-permissions');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const customTemplate = {
    id: 'integration-permission',
    systemPrompt: `You are a precise assistant. When the user asks to create a todo, always call the todo_write tool with the provided title and mark it pending. Do not respond with natural language until the todo is created.`,
    tools: ['todo_write', 'todo_read'],
    permission: { mode: 'approval', requireApprovalTools: ['todo_write'] as const },
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 2, reminderOnStart: false },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate,
    workDir,
  });

  const agent = harness.getAgent();

  const controlEventsPromise = collectEvents(agent, ['control'], (event) => event.type === 'permission_decided');

  const { reply, events } = await harness.chatStep({
    label: '权限阶段',
    prompt: '请建立一个标题为「审批集成测试」的待办，并等待批准。',
  });
  expect.toEqual(reply.status, 'ok');

  const controlEvents = (await controlEventsPromise) as any[];
  expect.toBeGreaterThanOrEqual(controlEvents.length, 1);
  expect.toBeGreaterThanOrEqual(
    events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_required').length,
    1
  );
  expect.toBeGreaterThanOrEqual(
    events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_decided').length,
    1
  );

  await wait(1500);

  const todos = agent.getTodos();
  expect.toEqual(todos.length, 1);
  expect.toEqual(todos[0].title.includes('审批集成测试'), true);

  await harness.cleanup();
});

runner.test('全量审批模式：多工具均需审批', async () => {
  const workDir = path.join(__dirname, '../../tmp/integration-permissions-full-approval');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const targetFile = path.join(workDir, 'full-approval.txt');
  fs.writeFileSync(targetFile, '初始');

  const customTemplate = {
    id: 'integration-full-approval',
    systemPrompt: 'You are a test assistant. Execute tool calls immediately when asked. Do not ask for confirmation.',
    tools: ['fs_write', 'fs_read', 'todo_write'],
    permission: { mode: 'approval' as const },
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 99, reminderOnStart: false },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate,
    workDir,
  });

  const agent = harness.getAgent();

  // 第一步：调用 fs_read（只读工具也需审批）
  const { events: readEvents } = await harness.chatStep({
    label: '全量审批-读',
    prompt: `Read the file at ${targetFile} using fs_read.`,
  });

  const readPermissions = readEvents.filter(
    (evt) => evt.channel === 'control' && evt.event.type === 'permission_required'
  );
  expect.toBeGreaterThanOrEqual(readPermissions.length, 1, 'fs_read 在 mode:approval 下也应触发审批');

  const readDecisions = readEvents.filter(
    (evt) => evt.channel === 'control' && evt.event.type === 'permission_decided'
  );
  expect.toBeGreaterThanOrEqual(readDecisions.length, 1, 'fs_read 审批应被决策');

  // 第二步：调用 todo_write（非文件工具也需审批）
  const { events: todoEvents } = await harness.chatStep({
    label: '全量审批-todo',
    prompt: '使用 todo_write 创建一个标题为「全量审批验证」的 todo。',
  });

  const todoPermissions = todoEvents.filter(
    (evt) => evt.channel === 'control' && evt.event.type === 'permission_required'
  );
  expect.toBeGreaterThanOrEqual(todoPermissions.length, 1, 'todo_write 在 mode:approval 下也应触发审批');

  const todos = agent.getTodos();
  expect.toBeGreaterThanOrEqual(todos.length, 1, '审批通过后 todo 应被创建');

  // 第三步：调用 fs_write（写工具也需审批）
  const { events: writeEvents } = await harness.chatStep({
    label: '全量审批-写',
    prompt: `Use fs_write to write "全量审批写入成功" to ${targetFile}.`,
  });

  const writePermissions = writeEvents.filter(
    (evt) => evt.channel === 'control' && evt.event.type === 'permission_required'
  );
  expect.toBeGreaterThanOrEqual(writePermissions.length, 1, 'fs_write 在 mode:approval 下也应触发审批');

  await wait(500);
  const content = fs.readFileSync(targetFile, 'utf-8');
  const fileModified = content !== '初始';
  expect.toBeTruthy(fileModified, `fs_write 审批通过后文件应被修改, got: ${content.slice(0, 100)}`);

  // 汇总：三种工具各自触发审批，验证 mode:'approval' 覆盖所有工具
  const allEvents = [...readEvents, ...todoEvents, ...writeEvents];
  const allPermissionRequired = allEvents.filter(
    (evt) => evt.channel === 'control' && evt.event.type === 'permission_required'
  );
  expect.toBeGreaterThanOrEqual(allPermissionRequired.length, 3, '三种工具均应触发审批（共 ≥3 次）');

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
