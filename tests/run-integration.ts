/**
 * 集成测试运行器
 */

import './helpers/env-setup';
import path from 'path';
import fg from 'fast-glob';
import { ensureCleanDir } from './helpers/setup';
import { TEST_ROOT } from './helpers/fixtures';
import { TestResult, runWithConcurrency } from './helpers/utils';

const CONCURRENCY = parseInt(process.env.TEST_CONCURRENCY || '4', 10);

async function runAll() {
  ensureCleanDir(TEST_ROOT);

  console.log('\n' + '='.repeat(80));
  console.log('KODE SDK - 集成测试套件 (使用真实API)');
  console.log('='.repeat(80));

  const cwd = path.resolve(__dirname);

  const entries = await fg('integration/**/*.test.ts', {
    cwd,
    absolute: false,
    dot: false,
  });

  if (entries.length === 0) {
    console.log('\n⚠️  未发现集成测试文件\n');
    return;
  }

  entries.sort();

  // 串行 import 所有模块（避免 ts-node 并发编译竞态）
  const modules: Array<{ moduleName: string; testModule: any }> = [];
  for (const relativePath of entries) {
    const moduleName = relativePath.replace(/\.test\.ts$/, '').replace(/\//g, ' › ');
    const importPath = './' + relativePath.replace(/\\/g, '/');
    try {
      const testModule = await import(importPath);
      modules.push({ moduleName, testModule });
    } catch (error: any) {
      console.error(`\n✗ 加载测试模块失败: ${moduleName}`);
      console.error(`  ${error.message}\n`);
    }
  }

  let totalPassed = 0;
  let totalFailed = 0;
  const allFailures: Array<{ suite: string; test: string; error: Error }> = [];

  // 用 runWithConcurrency 并行执行，每个完成后原子输出
  const tasks = modules.map(({ moduleName, testModule }) => async () => {
    try {
      const result: TestResult = await testModule.run();
      // 原子输出：单次 write 避免交叉
      process.stdout.write(result.output + '\n');
      return { moduleName, result };
    } catch (error: any) {
      const output = `\n✗ 运行测试模块失败: ${moduleName}\n  ${error.message}\n`;
      process.stdout.write(output);
      return {
        moduleName,
        result: {
          passed: 0,
          failed: 1,
          failures: [{ name: '运行失败', error: error instanceof Error ? error : new Error(String(error)) }],
          output,
        } as TestResult,
      };
    }
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);

  for (const { moduleName, result } of results) {
    totalPassed += result.passed;
    totalFailed += result.failed;
    for (const failure of result.failures) {
      allFailures.push({
        suite: moduleName,
        test: failure.name,
        error: failure.error,
      });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`总结: ${totalPassed} 通过, ${totalFailed} 失败`);
  console.log('='.repeat(80) + '\n');

  if (allFailures.length > 0) {
    console.log('失败详情:');
    for (const { suite, test, error } of allFailures) {
      console.log(`  [${suite}] ${test}`);
      console.log(`    ${error.message}`);
    }
    console.log('');
  }

  if (totalFailed > 0) {
    process.exitCode = 1;
  } else {
    console.log('✓ 所有集成测试通过\n');
  }

}

runAll()
  .catch(err => {
    console.error('测试运行器错误:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 并行测试中 Agent 的 file watcher 等异步资源可能未完全释放，强制退出
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
