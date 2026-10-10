import fs from 'node:fs/promises';
import path from 'node:path';
import { recordNativeConfiguration } from './native-settings.mjs';

const managedBlockStart = '# BEGIN playwright-ai-migration MCP';
const managedBlockEnd = '# END playwright-ai-migration MCP';
const managedBlockPattern = new RegExp(
  `${managedBlockStart}[\\s\\S]*?${managedBlockEnd}\\r?\\n?`,
  'g',
);
const playwrightTablePattern =
  /^\s*\[\s*mcp_servers\s*\.\s*["']?playwright-test["']?(?:\s*\.|\s*\])/m;
const inlineServersPattern = /^\s*mcp_servers\s*=\s*\{/m;
const portablePath = (value) => value.replaceAll('\\', '/');

export function nativeMcpServer(root, provider) {
  return {
    command: process.execPath,
    args: [path.resolve(root, 'scripts/playwright-mcp.mjs'), '--provider', provider],
  };
}

function isGeneratedServer(server, provider) {
  if (!server || !Object.keys(server).every((key) => ['type', 'command', 'args'].includes(key)))
    return false;
  const args = server.args || [];
  const officialArgs = ['playwright', 'run-test-mcp-server'];
  const isNpx = server.command === 'npx' && JSON.stringify(args) === JSON.stringify(officialArgs);
  const isWindowsNpx =
    ['cmd', 'cmd.exe'].includes(server.command) &&
    JSON.stringify(args) === JSON.stringify(['/c', 'npx', ...officialArgs]);
  const isLauncher =
    args.length === 3 &&
    typeof args[0] === 'string' &&
    args[0].replaceAll('\\', '/').endsWith('/scripts/playwright-mcp.mjs') &&
    args[1] === '--provider' &&
    args[2] === provider;
  return isNpx || isWindowsNpx || isLauncher;
}

export function mergeMcpConfiguration(previous, root, provider) {
  const serverKey = provider === 'vscode' ? 'servers' : 'mcpServers';
  const existing = previous?.[serverKey]?.['playwright-test'];
  if (existing && !isGeneratedServer(existing, provider)) {
    return { configuration: previous, preserved: true };
  }
  const server = nativeMcpServer(root, provider);
  if (provider === 'vscode') server.type = 'stdio';
  return {
    configuration: {
      ...previous,
      [serverKey]: { ...previous?.[serverKey], 'playwright-test': server },
    },
    preserved: false,
  };
}

export function codexProjectConfig(root, previous = '') {
  const userConfiguration = previous.replace(managedBlockPattern, '');
  if (
    playwrightTablePattern.test(userConfiguration) ||
    inlineServersPattern.test(userConfiguration)
  ) {
    return { text: previous, preserved: true };
  }
  const server = nativeMcpServer(root, 'codex');
  const block = [
    managedBlockStart,
    '[mcp_servers.playwright-test]',
    `command = ${JSON.stringify(portablePath(server.command))}`,
    `args = ${JSON.stringify(server.args.map(portablePath))}`,
    `cwd = ${JSON.stringify(portablePath(path.resolve(root)))}`,
    managedBlockEnd,
    '',
  ].join('\n');
  const separator = userConfiguration.trim() ? '\n\n' : '';
  return { text: userConfiguration.trimEnd() + separator + block, preserved: false };
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function setupCodex(root, config = 'playwright.config.ts') {
  const file = path.join(root, '.codex/config.toml');
  const result = codexProjectConfig(root, (await readOptional(file)) || '');
  if (!result.preserved) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, result.text);
  }
  await recordNativeConfiguration(root, 'codex', config, !result.preserved);
  return result;
}

export async function setupJsonMcp(root, provider, config = 'playwright.config.ts') {
  const file = path.join(root, provider === 'claude' ? '.mcp.json' : '.vscode/mcp.json');
  const text = await readOptional(file);
  const previous = text ? JSON.parse(text) : {};
  const result = mergeMcpConfiguration(previous, root, provider);
  if (!result.preserved) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(result.configuration, null, 2) + '\n');
  }
  await recordNativeConfiguration(root, provider, config, !result.preserved);
  return result;
}
