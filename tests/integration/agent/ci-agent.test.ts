/**
 * CI Agent Integration Tests (Streamlined)
 *
 * Focused test suite for CI pipelines:
 * - Essential permission mode tests
 * - Core file operations
 * - Basic bash commands
 * - Multi-tool workflow
 *
 * Designed to complete in ~3-5 minutes
 */

import path from 'path';
import fs from 'fs';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { ensureCleanDir } from '../../helpers/setup';

const runner = new TestRunner('CI Agent Integration Tests');

const TEST_ROOT = path.join(__dirname, '../../.tmp/ci-agent');

function createWorkDir(name: string): string {
  const dir = path.join(TEST_ROOT, `${name}-${Date.now()}`);
  ensureCleanDir(dir);
  return dir;
}

// =============================================================================
// Permission Mode Tests (3 essential tests)
// =============================================================================

runner.test('Permission: auto mode allows file operations', async () => {
  const workDir = createWorkDir('perm-auto');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-perm-auto',
      systemPrompt: 'You are a test agent. Use fs_write to create files.',
      tools: ['fs_write'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'test.txt');
  await harness.chatStep({
    label: 'Auto',
    prompt: `Create ${testFile} with content "auto works"`,
  });

  expect.toEqual(fs.existsSync(testFile), true);
  await harness.cleanup();
});

runner.test('Permission: approval mode triggers permission_required', async () => {
  const workDir = createWorkDir('perm-approval');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-perm-approval',
      systemPrompt: 'You are a test agent. Use fs_write.',
      tools: ['fs_write'],
      permission: { mode: 'approval' as const },
    },
  });

  const testFile = path.join(workDir, 'test.txt');
  const { events } = await harness.chatStep({
    label: 'Approval',
    prompt: `Create ${testFile} with content "approved"`,
    approval: { mode: 'auto', decision: 'allow' },
  });

  const permEvents = events.filter(e => e.event.type === 'permission_required');
  expect.toBeGreaterThanOrEqual(permEvents.length, 1);
  await harness.cleanup();
});

runner.test('Permission: deny blocks operation', async () => {
  const workDir = createWorkDir('perm-deny');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-perm-deny',
      systemPrompt: 'You are a test agent.',
      tools: ['fs_write'],
      permission: { mode: 'approval' as const },
    },
  });

  const testFile = path.join(workDir, 'blocked.txt');
  await harness.chatStep({
    label: 'Deny',
    prompt: `Create ${testFile}`,
    approval: { mode: 'auto', decision: 'deny' },
  });

  expect.toEqual(fs.existsSync(testFile), false);
  await harness.cleanup();
});

// =============================================================================
// File System Tests (3 essential tests)
// =============================================================================

runner.test('FS: write, read, edit workflow', async () => {
  const workDir = createWorkDir('fs-workflow');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-fs-workflow',
      systemPrompt: 'You are a file agent. Use tools to complete tasks.',
      tools: ['fs_write', 'fs_read', 'fs_edit'],
      permission: { mode: 'auto' as const },
    },
  });

  const testFile = path.join(workDir, 'config.txt');

  // Create file
  await harness.chatStep({
    label: 'FS Write',
    prompt: `Create ${testFile} with content "version=1.0"`,
  });
  expect.toEqual(fs.existsSync(testFile), true);

  // Edit file
  await harness.chatStep({
    label: 'FS Edit',
    prompt: `Edit ${testFile} to change "version=1.0" to "version=2.0"`,
  });

  const content = fs.readFileSync(testFile, 'utf-8');
  expect.toContain(content, 'version=2.0');

  await harness.cleanup();
});

runner.test('FS: glob finds files', async () => {
  const workDir = createWorkDir('fs-glob');
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(workDir, 'b.txt'), 'b');
  fs.writeFileSync(path.join(workDir, 'c.md'), 'c');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-fs-glob',
      systemPrompt: 'You are a file agent.',
      tools: ['fs_glob'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'FS Glob',
    prompt: `Find all .txt files in ${workDir}. How many are there?`,
  });

  expect.toContain(reply.text || '', '2');
  await harness.cleanup();
});

runner.test('FS: grep searches content', async () => {
  const workDir = createWorkDir('fs-grep');
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'hello world');
  fs.writeFileSync(path.join(workDir, 'b.txt'), 'goodbye world');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-fs-grep',
      systemPrompt: 'You are a file agent.',
      tools: ['fs_grep'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'FS Grep',
    prompt: `Search for files containing "hello" in ${workDir}. List the filename that matches.`,
  });

  const text = reply.text || '';
  const hasResult = text.includes('a.txt') || text.includes('hello') || text.includes('found') || text.includes('match');
  expect.toEqual(hasResult, true);
  await harness.cleanup();
});

// =============================================================================
// Bash Tests (2 essential tests)
// =============================================================================

runner.test('Bash: echo command', async () => {
  const workDir = createWorkDir('bash-echo');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-bash-echo',
      systemPrompt: 'You are a command agent.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash',
    prompt: 'Run: echo "CI test passed"',
  });

  expect.toContain(reply.text || '', 'passed');
  await harness.cleanup();
});

runner.test('Bash: pipeline command', async () => {
  const workDir = createWorkDir('bash-pipe');
  const dataFile = path.join(workDir, 'data.txt');
  fs.writeFileSync(dataFile, 'apple\nbanana\napricot\n');

  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-bash-pipe',
      systemPrompt: 'You are a command agent.',
      tools: ['bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Bash Pipe',
    prompt: `Count lines starting with "a" in ${dataFile} using grep and wc`,
  });

  expect.toContain(reply.text || '', '2');
  await harness.cleanup();
});

// =============================================================================
// Multi-tool Workflow Test (1 comprehensive test)
// =============================================================================

runner.test('Workflow: create script and run', async () => {
  const workDir = createWorkDir('workflow');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-workflow',
      systemPrompt: 'You are a coding agent.',
      tools: ['fs_write', 'bash_run'],
      permission: { mode: 'auto' as const },
    },
  });

  const scriptFile = path.join(workDir, 'calc.py');

  const { reply, events } = await harness.chatStep({
    label: 'Workflow',
    prompt: `Create ${scriptFile} that prints 6*7, then run it with python3`,
  });

  expect.toEqual(fs.existsSync(scriptFile), true);
  expect.toContain(reply.text || '', '42');

  const toolEvents = events.filter(e => e.event.type === 'tool:start');
  expect.toBeGreaterThanOrEqual(toolEvents.length, 2);

  await harness.cleanup();
});

// =============================================================================
// Error Handling Test (1 test)
// =============================================================================

runner.test('Error: handles missing file gracefully', async () => {
  const workDir = createWorkDir('error');
  const harness = await IntegrationHarness.create({
    workDir,
    customTemplate: {
      id: 'ci-error',
      systemPrompt: 'You are a file agent.',
      tools: ['fs_read'],
      permission: { mode: 'auto' as const },
    },
  });

  const { reply } = await harness.chatStep({
    label: 'Error',
    prompt: `Read ${path.join(workDir, 'nonexistent.txt')}`,
  });

  const text = (reply.text || '').toLowerCase();
  const hasError = text.includes('not') || text.includes('error') || text.includes('exist');
  expect.toEqual(hasError, true);

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
