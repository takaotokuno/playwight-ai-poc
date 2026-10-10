import fs from 'node:fs/promises';
import path from 'node:path';
import { generateRoleDefinitions } from '../lib/agent-definitions.mjs';
import { setupCodex, setupJsonMcp } from '../lib/agent-setup.mjs';
import { resolveTestConfig } from '../lib/native-settings.mjs';

const usage = 'Usage: npm run agents:init -- [--loop all|codex|claude|vscode] [--config file]';
function parseOptions(args) {
  const options = { loop: 'all', config: 'playwright.config.ts' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith('--loop=')) options.loop = argument.slice(7);
    else if (argument === '--loop' || argument === '--config') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} の値が必要です`);
      options[argument.slice(2)] = value;
    } else throw new Error(usage);
  }
  if (!['all', 'codex', 'claude', 'vscode'].includes(options.loop)) throw new Error(usage);
  return options;
}

try {
  const root = process.cwd();
  const options = parseOptions(process.argv.slice(2));
  const config = resolveTestConfig(root, options.config);
  await fs.access(path.join(root, config));
  const providers = options.loop === 'all' ? ['codex', 'claude'] : [options.loop];
  for (const provider of providers) {
    await generateRoleDefinitions(root, provider);
    const result =
      provider === 'codex'
        ? await setupCodex(root, config)
        : await setupJsonMcp(root, provider, config);
    console.log(
      result.preserved
        ? `${provider}: カスタム MCP 設定を保持しました。native の設定一致は未確認です。`
        : `${provider}: ${config} に接続する MCP と役割定義を準備しました。`,
    );
  }
  console.log(
    '設定を反映するため、アプリの MCP を再接続し、新しいローカルセッションで開始チェックを行ってください。',
  );
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
