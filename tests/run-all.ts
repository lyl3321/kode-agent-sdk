/**
 * 所有测试运行器
 */

import './helpers/env-setup';
import path from 'path';
import fg from 'fast-glob';
import { ensureCleanDir } from './helpers/setup';
import { TEST_ROOT } from './helpers/fixtures';
import { TestResult, runWithConcurrency } from './helpers/utils';

interface SuiteResult {
  suite: string;
  passed: number;
  failed: number;
  failures: Array<{ suite: string; test: string; error: Error }>;
}

async function runSuite(globPattern: string, label: string, concurrency: number = 1): Promise<SuiteResult> {
  const cwd = path.resolve(__dirname);
  const entries = await fg(globPattern, { cwd, absolute: false, dot: false });
  entries.sort();

  let passed = 0;
  let failed = 0;
  const failures: SuiteResult['failures'] = [];

  console.log(`\n▶ 运行${label}...\n`);

  // 串行 import 所有模块（避免 ts-node 并发编译竞态）
  const modules: Array<{ moduleName: string; testModule: any }> = [];
  for (const relativePath of entries) {
    const moduleName = relativePath.replace(/\.test\.ts$/, '').replace(/\//g, ' › ');
    const importPath = './' + relativePath.replace(/\\/g, '/');
    try {
      const testModule = await import(importPath);
      modules.push({ moduleName, testModule });
    } catch (error: any) {
      failed++;
      failures.push({
        suite: moduleName,
        test: '加载失败',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      console.error(`✗ ${moduleName} 加载失败: ${error.message}`);
    }
  }

  const executeModule = async (mod: { moduleName: string; testModule: any }) => {
    try {
      const result: TestResult = await mod.testModule.run();
      if (result.output) {
        process.stdout.write(result.output + '\n');
      }
      return { moduleName: mod.moduleName, result };
    } catch (error: any) {
      const errObj = error instanceof Error ? error : new Error(String(error));
      console.error(`✗ ${mod.moduleName} 运行失败: ${errObj.message}`);
      return {
        moduleName: mod.moduleName,
        result: {
          passed: 0,
          failed: 1,
          failures: [{ name: '运行失败', error: errObj }],
          output: '',
        } as TestResult,
      };
    }
  };

  let results: Array<{ moduleName: string; result: TestResult }>;

  if (concurrency > 1) {
    const tasks = modules.map((mod) => () => executeModule(mod));
    results = await runWithConcurrency(tasks, concurrency);
  } else {
    results = [];
    for (const mod of modules) {
      results.push(await executeModule(mod));
    }
  }

  for (const { moduleName, result } of results) {
    passed += result.passed;
    failed += result.failed;
    for (const failure of result.failures) {
      failures.push({ suite: moduleName, test: failure.name, error: failure.error });
    }
  }

  return { suite: label, passed, failed, failures };
}

async function runAll() {
  ensureCleanDir(TEST_ROOT);

  console.log('\n' + '='.repeat(80));
  console.log('KODE SDK - 完整测试套件');
  console.log('='.repeat(80) + '\n');

  const results: SuiteResult[] = [];

  results.push(await runSuite('unit/**/*.test.ts', '单元测试'));
  results.push(await runSuite('integration/**/*.test.ts', '集成测试', 4));
  results.push(await runSuite('e2e/**/*.test.ts', '端到端测试'));

  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const failures = results.flatMap(r => r.failures);

  console.log('\n' + '='.repeat(80));
  console.log(`总结: ${totalPassed} 通过, ${totalFailed} 失败`);
  console.log('='.repeat(80) + '\n');

  if (failures.length > 0) {
    console.log('失败详情:');
    for (const failure of failures) {
      console.log(`  [${failure.suite}] ${failure.test}`);
      console.log(`    ${failure.error.message}`);
    }
    console.log('');
  }

  if (totalFailed > 0) {
    process.exitCode = 1;
  } else {
    console.log('✓ 所有测试通过\n');
  }
}

runAll()
  .catch(err => {
    console.error('测试运行器错误:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
