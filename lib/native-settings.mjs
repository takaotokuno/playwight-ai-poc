import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const nativeSettingsFile = 'migration/.agent-config.json';
export const defaultTestConfig = 'playwright.config.ts';

export function resolveTestConfig(root, config = defaultTestConfig) {
  const absoluteRoot = path.resolve(root);
  const absoluteConfig = path.resolve(root, config);
  const relative = path.relative(absoluteRoot, absoluteConfig);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('テスト設定はリポジトリ内のファイルを指定してください');
  }
  return relative.replaceAll('\\', '/');
}

async function configHash(root, config) {
  const content = await fs.readFile(path.resolve(root, config));
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function readNativeSettings(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, nativeSettingsFile), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, providers: {} };
    throw error;
  }
}

export async function recordNativeConfiguration(root, provider, config, managed) {
  const relativeConfig = resolveTestConfig(root, config);
  const settings = await readNativeSettings(root);
  settings.providers[provider] = {
    config: relativeConfig,
    configHash: await configHash(root, relativeConfig),
    managed,
  };
  const file = path.join(root, nativeSettingsFile);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
}

export async function verifyNativeConfiguration(root, provider, config) {
  const requested = resolveTestConfig(root, config);
  const settings = await readNativeSettings(root);
  const initialized = settings.providers[provider];
  if (!initialized) {
    throw new Error(
      `native 設定がありません。npm run agents:init -- --loop=${provider} --config ${requested} を実行し、アプリを再接続してください`,
    );
  }
  if (!initialized.managed) {
    throw new Error(
      'カスタム MCP 設定を保持しましたが、native の設定一致を確認できません。設定をレビューしてプロジェクトの launcher に接続するか、CLI 経路を選択してください',
    );
  }
  if (initialized.config !== requested) {
    throw new Error(
      `native MCP の設定は ${initialized.config}、要求は ${requested} です。agents:init --config で切り替えて再接続してください`,
    );
  }
  if (initialized.configHash !== (await configHash(root, requested))) {
    throw new Error(
      'テスト設定が初期化後に変更されています。agents:init を再実行し、アプリを再接続してください',
    );
  }
  return initialized;
}
