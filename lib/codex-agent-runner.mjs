import fs from 'node:fs/promises';
import path from 'node:path';
import { local } from './migration.mjs';
import { hasSuccessfulSetup } from './agent-contract.mjs';
import { runAgentProcess } from './agent-process.mjs';

export function codexArguments(root, task, schemaFile, resultFile) {
  const mcpArgs = [
    local(root, 'node_modules/@playwright/test/cli.js'),
    'run-test-mcp-server',
    '--headless',
  ];
  if (task.config) {
    mcpArgs.push('--config', task.config);
  }
  const allowedTools = task.definitionTools
    .filter((tool) => tool.startsWith('playwright-test/'))
    .map((tool) => tool.slice('playwright-test/'.length));
  if (!allowedTools.length) {
    throw new Error('公式定義に Playwright Test MCP ツールがありません');
  }

  const configOverrides = [
    'features.apps=false',
    `mcp_servers.playwright-test.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.playwright-test.args=${JSON.stringify(mcpArgs)}`,
    `mcp_servers.playwright-test.cwd=${JSON.stringify(root)}`,
    'mcp_servers.playwright-test.required=true',
    `mcp_servers.playwright-test.enabled_tools=${JSON.stringify(allowedTools)}`,
  ];

  // --approve-for-me selects workspace-write; --sandbox is mutually exclusive.
  return [
    'exec',
    '--ephemeral',
    '--approve-for-me',
    '--json',
    '--cd',
    root,
    '--color',
    'never',
    '--output-schema',
    schemaFile,
    '--output-last-message',
    resultFile,
    ...configOverrides.flatMap((config) => ['-c', config]),
    '-',
  ];
}

function createCodexEvents(progress) {
  const invocation = { harness: 'codex-exec', sessionId: null, calls: [] };
  return {
    invocation,
    consume(event) {
      if (event.type === 'thread.started') {
        invocation.sessionId = event.thread_id;
      }
      if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
        const { server, tool, status } = event.item;
        invocation.calls.push({ server, tool, status });
        progress(`  MCP ${server}/${tool}: ${status}\n`);
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        progress('  Codex reported a runtime error.\n');
      }
    },
  };
}

async function readCodexResult(resultFile) {
  try {
    return JSON.parse(await fs.readFile(resultFile, 'utf8'));
  } catch {
    throw new Error('Codex worker の JSON 結果を取得できません。成功扱いにはしません。');
  }
}

export async function dispatchCodex(
  root,
  task,
  {
    executable = process.env.CODEX_EXECUTABLE || 'codex',
    prefixArgs = [],
    timeoutMs = 15 * 60 * 1000,
    progress = (message) => process.stderr.write(message),
  } = {},
) {
  const temporaryDirectory = local(root, `migration/.agent-tmp/${task.taskId}`);
  const schemaFile = path.join(temporaryDirectory, 'schema.json');
  const resultFile = path.join(temporaryDirectory, 'result.json');
  await fs.mkdir(temporaryDirectory, { recursive: true });
  await fs.writeFile(schemaFile, JSON.stringify(task.resultSchema));
  // A failed invocation must never reuse an earlier result.
  await fs.rm(resultFile, { force: true });

  try {
    const events = createCodexEvents(progress);
    const exitCode = await runAgentProcess({
      root,
      executable,
      args: [...prefixArgs, ...codexArguments(root, task, schemaFile, resultFile)],
      prompt: task.prompt,
      timeoutMs,
      label: 'Codex',
      consumeEvent: (event) => events.consume(event),
    });
    if (exitCode !== 0) {
      throw new Error(
        `Codex worker が終了コード ${exitCode} で失敗しました。委譲タスクは未完了のまま保持します。`,
      );
    }

    const result = await readCodexResult(resultFile);
    if (result.status === 'completed' && !hasSuccessfulSetup(events.invocation, task.agent)) {
      throw new Error('必要な Playwright MCP 呼び出しの成功記録がありません');
    }
    Object.defineProperty(result, 'invocation', { value: events.invocation, enumerable: false });
    return result;
  } finally {
    // Keep no raw model response or trace in the repository.
    await fs.rm(schemaFile, { force: true });
    await fs.rm(resultFile, { force: true });
    await fs.rmdir(temporaryDirectory).catch(() => {});
  }
}
