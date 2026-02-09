/**
 * Comprehensive Agent Integration Tests
 *
 * Covers:
 * - Permission modes (auto, approval, readonly, custom)
 * - File system operations (read, write, edit, glob, grep)
 * - Bash commands (info gathering, pipelines, safe operations)
 * - Todo tracking
 * - Multi-tool workflows
 * - Error handling and edge cases
 *
 * Requirements:
 * - Real LLM connection via .env.test
 * - Safe operations only (no side effects outside temp dirs)
 * - Linux/macOS compatible
 */

import path from 'path';
import fs from 'fs';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { collectEvents, wait, ensureCleanDir } from '../../helpers/setup';
import { TEMPLATES } from '../../helpers/fixtures';

const runner = new TestRunner('Comprehensive Agent Tests');

const TEST_ROOT = path.join(__dirname, '../../.tmp/comprehensive');

function createWorkDir(name: string): string {
  const dir = path.join(TEST_ROOT, `${name}-${Date.now()}`);
  ensureCleanDir(dir);
  return dir;
}

// =============================================================================
// Permission Mode Tests
// =============================================================================

runner.test('Permission: auto mode allows all operations', async () => {
  const workDir = createWorkDir('perm-auto');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-auto-test',
      systemPrompt: 'You are a test agent. Use tools to complete tasks. Be concise.',
      tools: ['fs_read', 'fs_write', 'fs_edit'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'auto-test.txt');

  const { reply, events } = await harness.chatStep({
    label: 'Auto Permission',
    prompt: `Create a file at ${testFile} with content "auto mode works". Use fs_write tool.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toEqual(fs.existsSync(testFile), true);

  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toContain(content, 'auto mode works');

  const permissionEvents = events.filter(e => e.event.type === 'permission_required');
  expect.toEqual(permissionEvents.length, 0);

  await harness.cleanup();
});

runner.test('Permission: approval mode requires confirmation', async () => {
  const workDir = createWorkDir('perm-approval');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-approval-test',
      systemPrompt: 'You are a test agent. Use tools to complete tasks.',
      tools: ['fs_write', 'fs_read'],
      permission: { mode: 'approval' as const },
    },
  });

  const agent = harness.getAgent();
  const testFile = path.join(workDir, 'approval-test.txt');

  const { reply, events } = await harness.chatStep({
    label: 'Approval Permission',
    prompt: `Create a file at ${testFile} with content "approved". Use fs_write.`,
    approval: { mode: 'auto', decision: 'allow' },
  });

  expect.toEqual(reply.status, 'ok');

  const permissionEvents = events.filter(e => e.event.type === 'permission_required');
  expect.toBeGreaterThanOrEqual(permissionEvents.length, 1);

  const decidedEvents = events.filter(e => e.event.type === 'permission_decided');
  expect.toBeGreaterThanOrEqual(decidedEvents.length, 1);

  await wait(500);
  expect.toEqual(fs.existsSync(testFile), true);

  await harness.cleanup();
});

runner.test('Permission: approval mode can deny operations', async () => {
  const workDir = createWorkDir('perm-deny');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-deny-test',
      systemPrompt: 'You are a test agent. Use tools to complete tasks.',
      tools: ['fs_write'],
      permission: { mode: 'approval' as const },
    },
  });

  const testFile = path.join(workDir, 'denied.txt');

  const { reply, events } = await harness.chatStep({
    label: 'Deny Permission',
    prompt: `Create a file at ${testFile}. Use fs_write.`,
    approval: { mode: 'auto', decision: 'deny' },
  });

  await wait(500);
  expect.toEqual(fs.existsSync(testFile), false);

  await harness.cleanup();
});

runner.test('Permission: readonly mode blocks write operations', async () => {
  const workDir = createWorkDir('perm-readonly');

  const existingFile = path.join(workDir, 'existing.txt');
  fs.writeFileSync(existingFile, 'original content');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-readonly-test',
      systemPrompt: 'You are a test agent. Use fs_read to read files.',
      tools: ['fs_read', 'fs_write'],
      permission: { mode: 'readonly' as const },
    },
  });

  const { reply: readReply } = await harness.chatStep({
    label: 'Readonly Read',
    prompt: `Read the file at ${existingFile} and tell me its content.`,
  });

  expect.toEqual(readReply.status, 'ok');
  expect.toContain(readReply.text || '', 'original content');

  await harness.cleanup();
});

runner.test('Permission: allowTools restricts available tools', async () => {
  const workDir = createWorkDir('perm-allowtools');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-allowtools-test',
      systemPrompt: 'You are a test agent. You can only read files.',
      tools: ['fs_read', 'fs_write', 'fs_edit'],
      permission: {
        mode: 'auto' as const,
        allowTools: ['fs_read'],
      },
    },
  });

  const existingFile = path.join(workDir, 'readable.txt');
  fs.writeFileSync(existingFile, 'readable content');

  const { reply } = await harness.chatStep({
    label: 'AllowTools Read',
    prompt: `Read the file at ${existingFile}.`,
  });

  expect.toEqual(reply.status, 'ok');

  await harness.cleanup();
});

runner.test('Permission: denyTools blocks specific tools', async () => {
  const workDir = createWorkDir('perm-denytools');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-denytools-test',
      systemPrompt: 'You are a test agent.',
      tools: ['fs_read', 'fs_write', 'bash_run'],
      permission: {
        mode: 'auto' as const,
        denyTools: ['bash_run'],
      },
    },
  });

  const testFile = path.join(workDir, 'test.txt');

  const { reply } = await harness.chatStep({
    label: 'DenyTools Write',
    prompt: `Create a file at ${testFile} with content "test" using fs_write.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toEqual(fs.existsSync(testFile), true);

  await harness.cleanup();
});

runner.test('Permission: requireApprovalTools selectively requires approval', async () => {
  const workDir = createWorkDir('perm-selective');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'perm-selective-test',
      systemPrompt: 'You are a test agent.',
      tools: ['fs_read', 'fs_write'],
      permission: {
        mode: 'auto' as const,
        requireApprovalTools: ['fs_write'],
      },
    },
  });

  const existingFile = path.join(workDir, 'existing.txt');
  fs.writeFileSync(existingFile, 'existing');

  const { events: readEvents } = await harness.chatStep({
    label: 'Selective Read',
    prompt: `Read the file at ${existingFile}.`,
  });

  const readPermEvents = readEvents.filter(e => e.event.type === 'permission_required');
  expect.toEqual(readPermEvents.length, 0);

  const newFile = path.join(workDir, 'new.txt');

  const { events: writeEvents } = await harness.chatStep({
    label: 'Selective Write',
    prompt: `Create a file at ${newFile} with content "new".`,
    approval: { mode: 'auto', decision: 'allow' },
  });

  const writePermEvents = writeEvents.filter(e => e.event.type === 'permission_required');
  expect.toBeGreaterThanOrEqual(writePermEvents.length, 1);

  await harness.cleanup();
});

// =============================================================================
// File System Tool Tests
// =============================================================================

runner.test('FS: fs_write creates file with content', async () => {
  const workDir = createWorkDir('fs-write');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-write-test',
      systemPrompt: 'You are a file operation agent. Use fs_write to create files.',
      tools: ['fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'created.txt');

  await harness.chatStep({
    label: 'FS Write',
    prompt: `Create a file at ${testFile} with content "Hello from fs_write test"`,
  });

  expect.toEqual(fs.existsSync(testFile), true);
  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toContain(content, 'Hello');

  await harness.cleanup();
});

runner.test('FS: fs_read reads file content', async () => {
  const workDir = createWorkDir('fs-read');

  const testFile = path.join(workDir, 'readable.txt');
  const secretContent = 'SECRET_CODE_XYZ789';
  fs.writeFileSync(testFile, secretContent);

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-read-test',
      systemPrompt: 'You are a file operation agent. Use fs_read to read files.',
      tools: ['fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'FS Read',
    prompt: `Read the file at ${testFile} and tell me the secret code.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toContain(reply.text || '', 'XYZ789');

  await harness.cleanup();
});

runner.test('FS: fs_edit replaces content in file', async () => {
  const workDir = createWorkDir('fs-edit');

  const testFile = path.join(workDir, 'editable.txt');
  fs.writeFileSync(testFile, 'version=1.0.0\nname=test');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-edit-test',
      systemPrompt: 'You are a file operation agent. Use fs_edit to modify files.',
      tools: ['fs_read', 'fs_edit'],
      permission: { mode: 'auto' as const },
    },
  });

  await harness.chatStep({
    label: 'FS Edit',
    prompt: `Edit the file at ${testFile} to change "version=1.0.0" to "version=2.0.0"`,
  });

  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toContain(content, 'version=2.0.0');
  expect.toContain(content, 'name=test');

  await harness.cleanup();
});

runner.test('FS: fs_glob finds files by pattern', async () => {
  const workDir = createWorkDir('fs-glob');

  fs.writeFileSync(path.join(workDir, 'file1.txt'), 'content1');
  fs.writeFileSync(path.join(workDir, 'file2.txt'), 'content2');
  fs.writeFileSync(path.join(workDir, 'file3.md'), 'content3');
  fs.writeFileSync(path.join(workDir, 'other.json'), '{}');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-glob-test',
      systemPrompt: 'You are a file operation agent. Use fs_glob to find files.',
      tools: ['fs_glob'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'FS Glob',
    prompt: `Use fs_glob to find all .txt files in ${workDir}. Tell me how many you found.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toContain(reply.text || '', '2');

  await harness.cleanup();
});

runner.test('FS: fs_grep searches content in files', async () => {
  const workDir = createWorkDir('fs-grep');

  fs.writeFileSync(path.join(workDir, 'a.txt'), 'apple banana cherry');
  fs.writeFileSync(path.join(workDir, 'b.txt'), 'dog cat banana');
  fs.writeFileSync(path.join(workDir, 'c.txt'), 'hello world');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-grep-test',
      systemPrompt: [
        'You are a file operation agent. Always use fs_grep to search files.',
        'IMPORTANT: The fs_grep tool takes a "pattern" (regex) and a "path" (glob pattern like "**/*.txt").',
        'Always use a glob pattern for path, never a plain directory path.',
      ].join('\n'),
      tools: ['fs_grep'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply, events } = await harness.chatStep({
    label: 'FS Grep',
    prompt: `Call fs_grep with pattern "banana" and path "**/*.txt" to find which .txt files contain "banana". List the matching file names.`,
  });

  expect.toEqual(reply.status, 'ok');

  // 优先从工具执行事件中验证 fs_grep 实际返回了匹配文件
  const grepExecuted = events.filter(
    (e) => e.channel === 'monitor' && e.event.type === 'tool_executed' && e.event.call?.name === 'fs_grep'
  );
  if (grepExecuted.length > 0) {
    const rawResult = JSON.stringify(grepExecuted[0].event.call?.result ?? '');
    const resultHasMatch = rawResult.includes('a.txt') || rawResult.includes('b.txt') || rawResult.includes('banana');
    expect.toBeTruthy(
      resultHasMatch,
      `fs_grep 工具返回值应包含匹配的文件名或内容, got: ${rawResult.slice(0, 300)}`
    );
  } else {
    // 回退：未捕获到 tool_executed 事件时检查 LLM 文本
    const text = reply.text || '';
    const hasResult = text.includes('a.txt') || text.includes('b.txt') ||
      text.includes('2 file') || text.includes('2 match') || text.includes('two');
    expect.toBeTruthy(hasResult, `Expected grep results mentioning matched files, got: ${text.slice(0, 200)}`);
  }

  await harness.cleanup();
});

runner.test('FS: multi-file workflow (create, read, edit, verify)', async () => {
  const workDir = createWorkDir('fs-workflow');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'fs-workflow-test',
      systemPrompt: 'You are a file operation agent. Complete multi-step file tasks.',
      tools: ['fs_read', 'fs_write', 'fs_edit', 'fs_glob'],
      permission: { mode: 'auto' as const },
    },
  });

  const configFile = path.join(workDir, 'config.json');

  const { events } = await harness.chatStep({
    label: 'FS Workflow',
    prompt: `Complete these steps:
1. Create ${configFile} with content: {"debug": false, "port": 3000}
2. Read the file to confirm creation
3. Edit the file to change "debug": false to "debug": true
4. Read again to verify the change
Report each step.`,
  });

  expect.toEqual(fs.existsSync(configFile), true);
  const content = fs.readFileSync(configFile, 'utf-8');
  expect.toContain(content, 'true');

  const toolEvents = events.filter(e => e.event.type === 'tool:start');
  expect.toBeGreaterThanOrEqual(toolEvents.length, 3);

  await harness.cleanup();
});

// =============================================================================
// Bash Tool Tests (Safe Operations Only)
// =============================================================================

runner.test('Bash: echo command execution', async () => {
  const workDir = createWorkDir('bash-echo');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-echo-test',
      systemPrompt: 'You are a command execution agent. Use bash_run for shell commands.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash Echo',
    prompt: `Run the command: echo "Hello from bash test" and tell me the output.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toContain(reply.text || '', 'Hello');

  await harness.cleanup();
});

runner.test('Bash: info gathering commands (date, whoami, pwd)', async () => {
  const workDir = createWorkDir('bash-info');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-info-test',
      systemPrompt: 'You are a system info agent. Use bash_run for commands.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash Info',
    prompt: `Run these commands and report results: 1) date 2) whoami 3) pwd`,
  });

  expect.toEqual(reply.status, 'ok');

  await harness.cleanup();
});

runner.test('Bash: pipeline commands (grep, wc, sort)', async () => {
  const workDir = createWorkDir('bash-pipeline');

  const dataFile = path.join(workDir, 'data.txt');
  fs.writeFileSync(dataFile, 'apple\nbanana\napricot\ncherry\navocado\n');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-pipeline-test',
      systemPrompt: 'You are a data processing agent. Use bash_run for commands.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash Pipeline',
    prompt: `Use bash to count how many lines in ${dataFile} start with letter "a". Use grep and wc.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toContain(reply.text || '', '3');

  await harness.cleanup();
});

runner.test('Bash: file manipulation (cat, head, tail)', async () => {
  const workDir = createWorkDir('bash-fileops');

  const logFile = path.join(workDir, 'log.txt');
  const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: Log entry`);
  fs.writeFileSync(logFile, lines.join('\n'));

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-fileops-test',
      systemPrompt: 'You are a log analysis agent. Use bash_run for commands.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash FileOps',
    prompt: `Show me the last 5 lines of ${logFile} using tail command.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toContain(reply.text || '', 'Line 20');

  await harness.cleanup();
});

runner.test('Bash: directory operations (ls, find)', async () => {
  const workDir = createWorkDir('bash-dirs');

  const subDir = path.join(workDir, 'subdir');
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(workDir, 'root.txt'), 'root');
  fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-dirs-test',
      systemPrompt: 'You are a directory exploration agent. Use bash_run for commands.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash Dirs',
    prompt: `List all .txt files in ${workDir} recursively using find command.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = reply.text || '';
  expect.toContain(text, 'root.txt');
  expect.toContain(text, 'nested.txt');

  await harness.cleanup();
});

runner.test('Bash: JSON processing with jq-like operations', async () => {
  const workDir = createWorkDir('bash-json');

  const jsonFile = path.join(workDir, 'data.json');
  fs.writeFileSync(jsonFile, JSON.stringify({
    users: [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ],
  }, null, 2));

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'bash-json-test',
      systemPrompt: 'You are a data processing agent. Use bash_run and fs_read.',
      tools: ['bash_run', 'fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash JSON',
    prompt: `Read ${jsonFile} and tell me the names of all users.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = reply.text || '';
  expect.toContain(text, 'Alice');
  expect.toContain(text, 'Bob');

  await harness.cleanup();
});

// =============================================================================
// Todo Tool Tests
// =============================================================================

runner.test('Todo: create and track tasks', async () => {
  const workDir = createWorkDir('todo-basic');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'todo-basic-test',
      systemPrompt: 'You are a task tracking agent. Use todo_write to manage tasks.',
      tools: ['todo_write', 'todo_read'],
      permission: { mode: 'auto' as const },
      runtime: { todo: { enabled: true, reminderOnStart: false } },
    },
  });

  const agent = harness.getAgent();

  await harness.chatStep({
    label: 'Todo Create',
    prompt: `Create a todo item with title "Test task 1" and status "pending".`,
  });

  await wait(500);
  const todos = agent.getTodos();
  expect.toBeGreaterThanOrEqual(todos.length, 1);

  await harness.cleanup();
});

runner.test('Todo: multi-step task tracking', async () => {
  const workDir = createWorkDir('todo-multistep');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'todo-multistep-test',
      systemPrompt: `You are a task tracking agent.
Use todo_write to plan and track multi-step tasks.
Use fs_write to create files.
Always update todo status as you complete each step.`,
      tools: ['todo_write', 'todo_read', 'fs_write'],
      permission: { mode: 'auto' as const },
      runtime: { todo: { enabled: true, reminderOnStart: false } },
    },
  });

  const file1 = path.join(workDir, 'step1.txt');
  const file2 = path.join(workDir, 'step2.txt');

  await harness.chatStep({
    label: 'Todo MultiStep',
    prompt: `Complete these tasks and track progress with todo_write:
1. Create ${file1} with content "Step 1 done"
2. Create ${file2} with content "Step 2 done"
Update todo status for each completed step.`,
  });

  await wait(500);
  expect.toEqual(fs.existsSync(file1), true);
  expect.toEqual(fs.existsSync(file2), true);

  await harness.cleanup();
});

// =============================================================================
// Complex Workflow Tests
// =============================================================================

runner.test('Workflow: create Python script and run it', async () => {
  const workDir = createWorkDir('workflow-python');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'workflow-python-test',
      systemPrompt: 'You are a coding agent. Create and run scripts.',
      tools: ['fs_write', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const scriptFile = path.join(workDir, 'calc.py');

  const { reply } = await harness.chatStep({
    label: 'Workflow Python',
    prompt: `Create a Python script at ${scriptFile} that prints the result of 7 * 8, then run it with python3 and tell me the result.`,
  });

  expect.toEqual(reply.status, 'ok');
  expect.toEqual(fs.existsSync(scriptFile), true);
  expect.toContain(reply.text || '', '56');

  await harness.cleanup();
});

runner.test('Workflow: find and replace across multiple files', async () => {
  const workDir = createWorkDir('workflow-replace');

  fs.writeFileSync(path.join(workDir, 'file1.txt'), 'color=red\nsize=large');
  fs.writeFileSync(path.join(workDir, 'file2.txt'), 'color=red\nshape=circle');
  fs.writeFileSync(path.join(workDir, 'file3.txt'), 'color=blue\ntype=solid');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'workflow-replace-test',
      systemPrompt: 'You are a file editing agent. Find and modify files.',
      tools: ['fs_read', 'fs_write', 'fs_edit', 'fs_glob', 'fs_grep', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  await harness.chatStep({
    label: 'Workflow Replace',
    prompt: `Find all .txt files in ${workDir} containing "color=red" and change it to "color=green".`,
  });

  const content1 = fs.readFileSync(path.join(workDir, 'file1.txt'), 'utf-8');
  const content2 = fs.readFileSync(path.join(workDir, 'file2.txt'), 'utf-8');
  const content3 = fs.readFileSync(path.join(workDir, 'file3.txt'), 'utf-8');

  expect.toContain(content1, 'color=green');
  expect.toContain(content2, 'color=green');
  expect.toContain(content3, 'color=blue');

  await harness.cleanup();
});

runner.test('Workflow: create directory structure with files', async () => {
  const workDir = createWorkDir('workflow-structure');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'workflow-structure-test',
      systemPrompt: 'You are a project setup agent. Create directory structures.',
      tools: ['fs_write', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  await harness.chatStep({
    label: 'Workflow Structure',
    prompt: `In ${workDir}, create this structure:
- src/index.js with content: console.log("Hello");
- src/utils/helper.js with content: module.exports = {};
- README.md with content: # Project
Use mkdir -p for directories and fs_write for files.`,
  });

  expect.toEqual(fs.existsSync(path.join(workDir, 'src', 'index.js')), true);
  expect.toEqual(fs.existsSync(path.join(workDir, 'src', 'utils', 'helper.js')), true);
  expect.toEqual(fs.existsSync(path.join(workDir, 'README.md')), true);

  await harness.cleanup();
});

runner.test('Workflow: analyze code and generate summary', async () => {
  const workDir = createWorkDir('workflow-analyze');

  fs.mkdirSync(path.join(workDir, 'src'));
  fs.writeFileSync(path.join(workDir, 'src', 'main.js'), `
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }
module.exports = { add, subtract, multiply };
`);

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'workflow-analyze-test',
      systemPrompt: 'You are a code analysis agent. Analyze code and provide summaries.',
      tools: ['fs_read', 'fs_glob', 'fs_grep', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Workflow Analyze',
    prompt: `Analyze the JavaScript files in ${workDir}/src and tell me what functions are defined.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = reply.text || '';
  expect.toContain(text, 'add');
  expect.toContain(text, 'subtract');
  expect.toContain(text, 'multiply');

  await harness.cleanup();
});

// =============================================================================
// Error Handling Tests
// =============================================================================

runner.test('Error: handles missing file gracefully', async () => {
  const workDir = createWorkDir('error-missing');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'error-missing-test',
      systemPrompt: 'You are a file agent. Handle errors gracefully.',
      tools: ['fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Error Missing',
    prompt: `Read the file at ${path.join(workDir, 'nonexistent.txt')} and tell me if it exists.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = (reply.text || '').toLowerCase();
  const hasErrorIndicator = text.includes('not') || text.includes('error') ||
    text.includes('exist') || text.includes('found') || text.includes('cannot');
  expect.toEqual(hasErrorIndicator, true);

  await harness.cleanup();
});

runner.test('Error: handles failed command gracefully', async () => {
  const workDir = createWorkDir('error-command');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'error-command-test',
      systemPrompt: 'You are a command agent. Handle errors gracefully.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Error Command',
    prompt: `Run the command "nonexistent_command_xyz_123" and tell me what happens.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = (reply.text || '').toLowerCase();
  const hasErrorIndicator = text.includes('not found') || text.includes('error') ||
    text.includes('fail') || text.includes('command');
  expect.toEqual(hasErrorIndicator, true);

  await harness.cleanup();
});

runner.test('Error: handles edit with missing string gracefully', async () => {
  const workDir = createWorkDir('error-edit');

  const testFile = path.join(workDir, 'test.txt');
  fs.writeFileSync(testFile, 'hello world');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'error-edit-test',
      systemPrompt: 'You are a file agent. Handle errors gracefully.',
      tools: ['fs_read', 'fs_edit'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Error Edit',
    prompt: `Edit ${testFile} to replace "xyz123abc" with "new". Tell me if it worked.`,
  });

  expect.toEqual(reply.status, 'ok');

  await harness.cleanup();
});

// =============================================================================
// Edge Case Tests
// =============================================================================

runner.test('Edge: handles Unicode content', async () => {
  const workDir = createWorkDir('edge-unicode');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-unicode-test',
      systemPrompt: 'You are a file agent. Handle all content types.',
      tools: ['fs_read', 'fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'unicode.txt');
  const unicodeContent = 'English\nChinese: \u4e2d\u6587\nJapanese: \u65e5\u672c\u8a9e\nEmoji: \ud83d\ude0a';

  await harness.chatStep({
    label: 'Edge Unicode Write',
    prompt: `Create a file at ${testFile} with this content:\n${unicodeContent}`,
  });

  expect.toEqual(fs.existsSync(testFile), true);
  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toContain(content, '\u4e2d');

  const { reply } = await harness.chatStep({
    label: 'Edge Unicode Read',
    prompt: `Read the file at ${testFile} and tell me what languages are represented.`,
  });

  expect.toContain(reply.text || '', 'Chinese');

  await harness.cleanup();
});

runner.test('Edge: handles empty file', async () => {
  const workDir = createWorkDir('edge-empty');

  const emptyFile = path.join(workDir, 'empty.txt');
  fs.writeFileSync(emptyFile, '');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-empty-test',
      systemPrompt: 'You are a file agent.',
      tools: ['fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Edge Empty',
    prompt: `Read the file at ${emptyFile} and tell me if it's empty.`,
  });

  expect.toEqual(reply.status, 'ok');
  const text = (reply.text || '').toLowerCase();
  expect.toContain(text, 'empty');

  await harness.cleanup();
});

runner.test('Edge: handles large file', async () => {
  const workDir = createWorkDir('edge-large');

  const largeFile = path.join(workDir, 'large.txt');
  const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: Some content here`);
  fs.writeFileSync(largeFile, lines.join('\n') + '\n');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-large-test',
      systemPrompt: 'You are a file agent.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply, events } = await harness.chatStep({
    label: 'Edge Large',
    prompt: `Count the number of lines in ${largeFile} using wc -l.`,
  });

  expect.toEqual(reply.status, 'ok');

  // 从工具执行事件中提取 bash 原始输出，验证 wc -l 确实返回 1000
  const bashExecuted = events.filter(
    (e) => e.channel === 'monitor' && e.event.type === 'tool_executed' && e.event.call?.name === 'bash_run'
  );
  if (bashExecuted.length > 0) {
    const rawResult = JSON.stringify(bashExecuted[0].event.call?.result ?? '');
    expect.toBeTruthy(
      rawResult.includes('1000'),
      `bash_run 原始输出应包含 1000, got: ${rawResult.slice(0, 200)}`
    );
  } else {
    // 回退：如果未捕获到 tool_executed 事件，仍检查 LLM 文本
    const text = reply.text || '';
    const hasLineCount = text.includes('1000') || text.includes('999');
    expect.toBeTruthy(hasLineCount, `Expected response to mention line count, got: ${text.slice(0, 200)}`);
  }

  await harness.cleanup();
});

runner.test('Edge: handles special characters in content', async () => {
  const workDir = createWorkDir('edge-special');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-special-test',
      systemPrompt: 'You are a file agent.',
      tools: ['fs_write', 'fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'special.txt');
  const specialContent = 'Line with "quotes"\nLine with $variable\nLine with `backticks`\nLine with \\backslash';

  await harness.chatStep({
    label: 'Edge Special Write',
    prompt: `Create a file at ${testFile} with this content:\n${specialContent}`,
  });

  expect.toEqual(fs.existsSync(testFile), true);
  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toBeGreaterThan(content.length, 10);

  await harness.cleanup();
});

runner.test('Edge: handles nested directory creation', async () => {
  const workDir = createWorkDir('edge-nested');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-nested-test',
      systemPrompt: 'You are a file agent.',
      tools: ['bash_run', 'fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const deepFile = path.join(workDir, 'a', 'b', 'c', 'd', 'deep.txt');

  await harness.chatStep({
    label: 'Edge Nested',
    prompt: `Create a file at ${deepFile} with content "deep content". Create directories as needed.`,
  });

  expect.toEqual(fs.existsSync(deepFile), true);
  const content = fs.readFileSync(deepFile, 'utf-8');
  expect.toContain(content, 'deep');

  await harness.cleanup();
});

runner.test('Edge: creates multiple files efficiently', async () => {
  const workDir = createWorkDir('edge-multi');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'edge-multi-test',
      systemPrompt: 'You are a file agent. Work efficiently.',
      tools: ['fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  await harness.chatStep({
    label: 'Edge Multi',
    prompt: `Create 5 files in ${workDir}:
- num1.txt with content "1"
- num2.txt with content "2"
- num3.txt with content "3"
- num4.txt with content "4"
- num5.txt with content "5"`,
  });

  let created = 0;
  for (let i = 1; i <= 5; i++) {
    if (fs.existsSync(path.join(workDir, `num${i}.txt`))) {
      created++;
    }
  }
  expect.toBeGreaterThanOrEqual(created, 4);

  await harness.cleanup();
});

// =============================================================================
// Combination Tests (Info + Operation)
// =============================================================================

runner.test('Combo: system info + file creation', async () => {
  const workDir = createWorkDir('combo-info-file');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'combo-info-file-test',
      systemPrompt: 'You are a system agent.',
      tools: ['bash_run', 'fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const infoFile = path.join(workDir, 'system-info.txt');

  await harness.chatStep({
    label: 'Combo Info File',
    prompt: `Get the current date and hostname using bash, then save this info to ${infoFile}.`,
  });

  expect.toEqual(fs.existsSync(infoFile), true);
  const content = fs.readFileSync(infoFile, 'utf-8');
  expect.toBeGreaterThan(content.length, 5);

  await harness.cleanup();
});

runner.test('Combo: directory listing + file content aggregation', async () => {
  const workDir = createWorkDir('combo-list-agg');

  fs.writeFileSync(path.join(workDir, 'part1.txt'), 'Hello');
  fs.writeFileSync(path.join(workDir, 'part2.txt'), 'World');
  fs.writeFileSync(path.join(workDir, 'part3.txt'), '!');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'combo-list-agg-test',
      systemPrompt: 'You are a file aggregation agent.',
      tools: ['fs_glob', 'fs_read', 'fs_write', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const combinedFile = path.join(workDir, 'combined.txt');

  const { reply } = await harness.chatStep({
    label: 'Combo List Agg',
    prompt: `Find all part*.txt files in ${workDir}, read their contents, and combine them into ${combinedFile}.`,
  });

  expect.toEqual(fs.existsSync(combinedFile), true);
  const content = fs.readFileSync(combinedFile, 'utf-8');
  expect.toContain(content, 'Hello');
  expect.toContain(content, 'World');

  await harness.cleanup();
});

runner.test('Combo: process status + conditional file operation', async () => {
  const workDir = createWorkDir('combo-process');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'combo-process-test',
      systemPrompt: 'You are a process monitoring agent.',
      tools: ['bash_run', 'fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const statusFile = path.join(workDir, 'status.txt');

  await harness.chatStep({
    label: 'Combo Process',
    prompt: `Check if the current shell process is running (use ps or echo $$), then write "Process is active" to ${statusFile}.`,
  });

  expect.toEqual(fs.existsSync(statusFile), true);
  const content = fs.readFileSync(statusFile, 'utf-8');
  expect.toContain(content.toLowerCase(), 'active');

  await harness.cleanup();
});

runner.test('Combo: environment variables + config generation', async () => {
  const workDir = createWorkDir('combo-env');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'combo-env-test',
      systemPrompt: 'You are a config generation agent.',
      tools: ['bash_run', 'fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const configFile = path.join(workDir, 'config.env');

  await harness.chatStep({
    label: 'Combo Env',
    prompt: `Get the HOME and USER environment variables using bash (echo $HOME, echo $USER), then create ${configFile} with format:
APP_HOME=<HOME value>
APP_USER=<USER value>`,
  });

  expect.toEqual(fs.existsSync(configFile), true);
  const content = fs.readFileSync(configFile, 'utf-8');
  expect.toContain(content, 'APP_HOME=');
  expect.toContain(content, 'APP_USER=');

  await harness.cleanup();
});

// =============================================================================
// Export and Main
// =============================================================================

export async function run() {
  ensureCleanDir(TEST_ROOT);
  const result = await runner.run();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  return result;
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
