import fs from 'node:fs/promises';
import path from 'node:path';
import { local } from './migration.mjs';
import { hasSuccessfulSetup } from './agent-contract.mjs';
import { runAgentProcess } from './agent-process.mjs';

const mcpToolPrefix = 'mcp__playwright-test__';
const claudeToolNames = {
  read: 'Read',
  search: 'Grep',
  edit: 'Edit',
  LS: 'Read',
  MultiEdit: 'Edit',
};

export function claudeTools(task) {
  const tools = task.definitionTools.map((tool) => {
    if (tool.startsWith('playwright-test/')) {
      return tool.replace('playwright-test/', mcpToolPrefix);
    }
    return claudeToolNames[tool] || tool;
  });
  return [...new Set(tools)];
}

export function claudeArguments(task, agentsFile, mcpFile) {
  const tools = claudeTools(task);
  if (!tools.some((tool) => tool.startsWith(mcpToolPrefix))) {
    throw new Error('公式定義に Playwright Test MCP ツールがありません');
  }
  const builtinTools = tools.filter((tool) => !tool.startsWith('mcp__'));
  return [
    '-p',
    '--agent',
    task.agent,
    '--agents',
    agentsFile,
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(task.resultSchema),
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--permission-mode',
    'default',
    '--tools',
    builtinTools.join(','),
    '--allowedTools',
    tools.join(','),
  ];
}

function isToolError(block) {
  let failed = block.is_error === true;
  const contents = Array.isArray(block.content) ? block.content : [{ text: block.content }];
  for (const content of contents) {
    try {
      // Some MCP clients encode isError as JSON inside a text result.
      if (JSON.parse(content.text)?.isError === true) {
        failed = true;
      }
    } catch {
      // Plain text is a normal tool result.
    }
  }
  return failed;
}

export function createClaudeEvents() {
  const invocation = { harness: 'claude-code', sessionId: null, calls: [] };
  const pendingCalls = new Map();
  let finalResult;

  return {
    invocation,
    get final() {
      return finalResult;
    },
    consume(event) {
      if (event.session_id) {
        invocation.sessionId = event.session_id;
      }
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use' && block.name?.startsWith(mcpToolPrefix)) {
          pendingCalls.set(block.id, block.name.slice(mcpToolPrefix.length));
        }
        if (block.type === 'tool_result' && pendingCalls.has(block.tool_use_id)) {
          invocation.calls.push({
            server: 'playwright-test',
            tool: pendingCalls.get(block.tool_use_id),
            status: isToolError(block) ? 'failed' : 'completed',
          });
          pendingCalls.delete(block.tool_use_id);
        }
      }
      if (event.type === 'result') {
        finalResult = event;
      }
    },
  };
}

async function writeClaudeConfiguration(root, task, agentsFile, mcpFile) {
  const agentDefinitions = {
    [task.agent]: {
      description: task.roleDescription,
      prompt: task.roleInstructions,
      tools: claudeTools(task),
    },
  };
  const mcpArgs = [
    local(root, 'node_modules/@playwright/test/cli.js'),
    'run-test-mcp-server',
    '--headless',
  ];
  if (task.config) {
    mcpArgs.push('--config', task.config);
  }
  const mcpConfiguration = {
    mcpServers: {
      'playwright-test': { command: process.execPath, args: mcpArgs },
    },
  };
  await fs.writeFile(agentsFile, JSON.stringify(agentDefinitions));
  await fs.writeFile(mcpFile, JSON.stringify(mcpConfiguration));
}

function readClaudeResult(events) {
  const result = events.final;
  if (!result || result.is_error || result.subtype !== 'success' || !result.structured_output) {
    throw new Error('Claude Code の正常な構造化結果を取得できません。成功扱いにはしません。');
  }
  return result.structured_output;
}

export async function dispatchClaude(
  root,
  task,
  {
    executable = process.env.CLAUDE_EXECUTABLE || 'claude',
    prefixArgs = [],
    timeoutMs = 15 * 60 * 1000,
    progress = (message) => process.stderr.write(message),
  } = {},
) {
  const temporaryDirectory = local(root, `migration/.agent-tmp/${task.taskId}`);
  const agentsFile = path.join(temporaryDirectory, 'agents.json');
  const mcpFile = path.join(temporaryDirectory, 'mcp.json');
  await fs.mkdir(temporaryDirectory, { recursive: true });
  await writeClaudeConfiguration(root, task, agentsFile, mcpFile);
  const events = createClaudeEvents();

  try {
    const exitCode = await runAgentProcess({
      root,
      executable,
      args: [...prefixArgs, ...claudeArguments(task, agentsFile, mcpFile)],
      prompt: task.prompt,
      timeoutMs,
      label: 'Claude Code',
      flushFinalLine: true,
      consumeEvent(event) {
        const previousCallCount = events.invocation.calls.length;
        events.consume(event);
        for (const call of events.invocation.calls.slice(previousCallCount)) {
          progress(`  MCP ${call.server}/${call.tool}: ${call.status}\n`);
        }
      },
    });
    if (exitCode !== 0) {
      throw new Error(
        `Claude Code worker が終了コード ${exitCode} で失敗しました。タスクは未完了のまま保持します。`,
      );
    }

    const result = readClaudeResult(events);
    if (result.status === 'completed' && !hasSuccessfulSetup(events.invocation, task.agent)) {
      throw new Error('必要な Playwright MCP 呼び出しの成功記録がありません');
    }
    Object.defineProperty(result, 'invocation', { value: events.invocation, enumerable: false });
    return result;
  } finally {
    await fs.rm(agentsFile, { force: true });
    await fs.rm(mcpFile, { force: true });
    await fs.rmdir(temporaryDirectory).catch(() => {});
  }
}
