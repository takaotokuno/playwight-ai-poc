import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readNativeSettings, verifyNativeConfiguration } from '../lib/native-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = process.argv[process.argv.indexOf('--provider') + 1];
try {
  const settings = await readNativeSettings(root);
  const initialized = settings.providers[provider];
  if (!initialized) throw new Error('MCP 接続先が未初期化です。agents:init を実行してください');
  await verifyNativeConfiguration(root, provider, initialized.config);
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/@playwright/test/cli.js'),
      'run-test-mcp-server',
      '--headless',
      '--config',
      path.join(root, initialized.config),
    ],
    { cwd: root, env: process.env, stdio: 'inherit', shell: false, windowsHide: true },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
