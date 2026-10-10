import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { generateRoleDefinitions } from '../lib/agent-definitions.mjs';

test('公式の役割だけを生成し、親の MCP と台帳操作を worker に再設定しない', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-definitions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await generateRoleDefinitions(root, 'codex');
  await generateRoleDefinitions(root, 'claude');
  await assert.rejects(fs.access(path.join(root, '.vscode')), /ENOENT/);
  await assert.rejects(fs.access(path.join(root, '.github/workflows')), /ENOENT/);
  const file = path.join(root, '.claude/agents/playwright-test-planner.md');
  const content = await fs.readFile(file, 'utf8');
  const metadata = YAML.parse(content.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.ok(metadata.tools.includes('mcp__playwright-test__planner_setup_page'));
  assert.ok(metadata.tools.includes('Edit'));
  assert.ok(!('model' in metadata));
  assert.match(content, /The parent owns user dialogue/);
  assert.ok(!content.includes('Record questions and user answers in the ledger.'));
});
