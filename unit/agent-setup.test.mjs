import test from 'node:test';
import assert from 'node:assert/strict';
import { codexProjectConfig, mergeMcpConfiguration } from '../lib/agent-setup.mjs';

test('Codex MCP をプロジェクト内で設定し、再初期化でも既存の設定を保持する', () => {
  const previous = 'model = "user-model"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n';
  const first = codexProjectConfig('C:\\repo', previous);
  assert.match(first.text, /model = "user-model"/);
  assert.match(first.text, /\[mcp_servers.other\]/);
  assert.match(first.text, /C:\/repo\/scripts\/playwright-mcp.mjs/);
  const second = codexProjectConfig('C:\\new-repo', first.text);
  assert.equal(second.text.match(/\[mcp_servers.playwright-test\]/g).length, 1);
  assert.ok(second.text.includes('C:/new-repo') && !second.text.includes('C:/repo'));
  assert.ok(!second.text.includes('[agents]') && !second.text.includes('approval_policy'));
});

test('Windows の公式生成設定を OS に依存しない launcher に更新する', () => {
  const previous = {
    mcpServers: {
      'playwright-test': {
        command: 'cmd',
        args: ['/c', 'npx', 'playwright', 'run-test-mcp-server'],
      },
      other: { command: 'custom', args: [] },
    },
  };
  const result = mergeMcpConfiguration(previous, '/repo', 'claude');
  assert.equal(result.preserved, false);
  assert.equal(result.configuration.mcpServers['playwright-test'].command, process.execPath);
  assert.ok(
    result.configuration.mcpServers['playwright-test'].args[0].endsWith('playwright-mcp.mjs'),
  );
  assert.deepEqual(result.configuration.mcpServers.other, previous.mcpServers.other);
  const again = mergeMcpConfiguration(result.configuration, '/new-repo', 'claude');
  assert.equal(again.preserved, false);
});

test('環境変数や独自引数を持つカスタム MCP 設定は保持する', () => {
  const previous = {
    mcpServers: {
      'playwright-test': {
        command: 'node',
        args: ['custom-server.mjs'],
        env: { SETTING: 'value' },
      },
    },
  };
  const result = mergeMcpConfiguration(previous, '/repo', 'claude');
  assert.equal(result.preserved, true);
  assert.deepEqual(result.configuration, previous);
});

test('ユーザーの Playwright MCP 設定を勝手に上書きしない', () => {
  for (const previous of [
    '[mcp_servers.playwright-test]\ncommand = "custom"\n',
    '[mcp_servers."playwright-test".env]\nCUSTOM = "yes"\n',
    'mcp_servers = { "playwright-test" = { command = "custom" } }\n',
  ]) {
    assert.deepEqual(codexProjectConfig('/repo', previous), { text: previous, preserved: true });
  }
});
