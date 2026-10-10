import path from 'node:path';
import { createRequire } from 'node:module';
import { nativeMcpServer } from '../lib/agent-setup.mjs';
import { readNativeSettings, verifyNativeConfiguration } from '../lib/native-settings.mjs';

const require = createRequire(import.meta.url);
const { Client, StdioClientTransport } = require('playwright-core/lib/utilsBundle');
const requiredTools = [
  'planner_setup_page',
  'planner_save_plan',
  'generator_setup_page',
  'generator_write_test',
  'test_debug',
  'browser_close',
];

function optionsFrom(args) {
  const options = { seed: 'tests/seed.spec.ts' };
  for (let index = 0; index < args.length; index++) {
    if (!['--loop', '--seed'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Usage: npm run setup:check -- --loop codex|claude|vscode [--seed file]');
    }
    options[args[index].slice(2)] = args[++index];
  }
  if (!['codex', 'claude', 'vscode'].includes(options.loop))
    throw new Error('--loop を指定してください');
  return options;
}

let client;
try {
  const root = process.cwd();
  const options = optionsFrom(process.argv.slice(2));
  const settings = await readNativeSettings(root);
  const config = settings.providers[options.loop]?.config;
  await verifyNativeConfiguration(root, options.loop, config);
  console.log(`Node ${process.versions.node}; provider=${options.loop}; config=${config}`);
  const transport = new StdioClientTransport({
    ...nativeMcpServer(root, options.loop),
    cwd: root,
    env: process.env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'migration-setup-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const available = (await client.listTools()).tools.map((tool) => tool.name);
  const missing = requiredTools.filter((tool) => !available.includes(tool));
  if (missing.length) throw new Error(`必要な MCP ツールがありません: ${missing.join(', ')}`);
  console.log('MCP 接続と必要なツールを確認しました。');
  const result = await client.callTool(
    { name: 'planner_setup_page', arguments: { seedFile: options.seed } },
    undefined,
    { timeout: 30000 },
  );
  if (result.isError)
    throw new Error(
      'seed の実行に失敗しました。BASE_URL・認証状態・ブラウザー・seed の設定を確認してください。',
    );
  console.log(`seed 接続確認が成功しました: ${path.normalize(options.seed)}`);
  console.log(
    'この確認は別 MCP プロセスです。アプリ内の MCP 再接続と子からのツール利用は、docs/agent-workflow.md の開始チェックで確認してください。',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.callTool({ name: 'browser_close', arguments: {} }, undefined, {
        timeout: 10000,
      });
    } catch {}
    await client.close();
  }
}
