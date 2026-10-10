import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { ingest, create, decide, feature, writeLedger } from '../lib/migration.mjs';
import {
  startWorkflow,
  workflowTask,
  acceptWorkflowResult,
  verifyWorkflow,
  orchestrate,
  assertions,
  stopWorkflow,
} from '../lib/agent-workflow.mjs';
import { dispatchCodex, codexArguments } from '../lib/codex-agent-runner.mjs';
import {
  dispatchClaude,
  claudeArguments,
  createClaudeEvents,
} from '../lib/claude-agent-runner.mjs';
import { parseAgentArgs, normalizeTools } from '../lib/agent-providers.mjs';
import { recordNativeConfiguration } from '../lib/native-settings.mjs';

const roles = ['playwright-test-planner', 'playwright-test-generator', 'playwright-test-healer'];
async function workspace(t, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-flow-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  for (const dir of ['requirements', '.github/agents', '.claude/agents', 'tests']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'AGENTS.md'), '業務仕様を推測しない');
  await fs.writeFile(path.join(root, 'playwright.config.ts'), 'export default {};');
  for (const provider of ['codex', 'claude', 'vscode']) {
    await recordNativeConfiguration(root, provider, 'playwright.config.ts', true);
  }
  for (const role of roles) {
    await fs.writeFile(
      path.join(root, `.github/agents/${role}.agent.md`),
      `---\n${YAML.stringify({ name: role, tools: ['playwright-test/browser_snapshot', 'playwright-test/browser_close'] })}---\nOfficial role: ${role}\n`,
    );
  }
  for (const role of roles) {
    await fs.writeFile(
      path.join(root, `.claude/agents/${role}.md`),
      `---\n${YAML.stringify({ name: role, tools: 'Read, mcp__playwright-test__planner_setup_page, mcp__playwright-test__browser_close' })}---\nClaude role: ${role}\n`,
    );
  }
  await fs.writeFile(path.join(root, 'requirements/spec.md'), '結果を表示する\n');
  const source = await ingest(root, 'requirements/spec.md');
  await create(root, 'search', {
    version: 1,
    id: 'F-001',
    title: '検索',
    sources: [
      { id: 'SRC-001', file: source.file, snapshot: source.snapshot, revision: source.revision },
    ],
    criteria: Array.from({ length: count }, (_, i) => ({
      id: `AC-00${i + 1}`,
      original: '結果を表示する',
      source: 'SRC-001',
      location: 'L1',
      specification: 'unresolved',
      automation: 'not_started',
      gaps: [],
      decisions: [],
      tests: [],
      prs: [],
    })),
    gaps: [],
    decisions: [],
    revisions: [],
    runs: [],
  });
  for (let i = 0; i < count; i++) {
    await decide(root, 'F-001', `AC-00${i + 1}`, {
      question: '期待結果は？',
      answer: '保存完了',
      preconditions: ['検索画面'],
      inputs: ['山田'],
      steps: ['検索する'],
      expected: ['保存完了'],
    });
  }
  return root;
}
function result(
  task,
  { status = 'completed', artifacts, questions = [], classifications = [] } = {},
) {
  const output = {
    taskId: task.taskId,
    agent: task.agent,
    status,
    summary: 'worker の結果',
    artifacts: artifacts || [
      { ac: 'AC-001', path: task.agent === roles[0] ? 'specs/search.md' : 'tests/search.spec.ts' },
    ],
    questions,
    classifications,
    reused: [],
  };
  // Simulate the coordinator's receipt, separately from the worker JSON schema.
  Object.defineProperty(output, 'delegation', {
    value: { taskId: task.taskId, agentId: 'unit-agent', tool: 'unit-dispatch' },
  });
  return output;
}
const code = (locator = '保存', expected = '保存完了', count = 1) =>
  Array.from(
    { length: count },
    (_, i) =>
      `test('F-001/AC-00${i + 1}', async ({page}) => { await expect(page.getByRole('button', { name: '${locator}' })).toHaveText('${expected}'); });`,
  ).join('\n');
async function execute(root, id, ids, passed) {
  const item = await feature(root, id);
  const record = {
    id: `run-${item.data.runs.length + 1}`,
    at: new Date().toISOString(),
    command: 'mock test runner',
    commit: null,
    dirty: true,
    environment: 'unit',
    exitCode: passed ? 0 : 1,
    results: ids.map((ac, i) => ({
      ac,
      status: passed || i > 0 ? 'passed' : 'failed',
      classification: passed || i > 0 ? null : 'unclassified',
    })),
  };
  item.data.runs.push(record);
  await writeLedger(item.file, item.data, item.body);
  return record;
}

test('公式の名前と定義を渡し、Planner→Generator→実行の順に進み、Healerは呼ばない', async (t) => {
  const root = await workspace(t);
  const calls = [];
  const outcome = await orchestrate(
    root,
    'F-001',
    ['AC-001'],
    async (task) => {
      calls.push(task.agent);
      assert.match(task.prompt, /Official role:/);
      assert.match(task.prompt, /業務仕様を推測しない/);
      if (task.agent === roles[1]) {
        await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code());
      }
      return result(task);
    },
    { execute: (root, id, ids) => execute(root, id, ids, true) },
  );
  assert.deepEqual(calls, roles.slice(0, 2));
  assert.equal(outcome.state, 'complete');
  const { data } = await feature(root, 'F-001');
  assert.equal(data.criteria[0].automation, 'implemented');
  assert.equal(data.runs.length, 1);
  assert.equal(data.agentWorkflows[0].events.length, 3);
});

test('Claudeの公式定義を選択し、共通フローで台帳・実行結果を保存する', async (t) => {
  const root = await workspace(t);
  const outcome = await orchestrate(
    root,
    'F-001',
    ['AC-001'],
    async (task) => {
      assert.equal(task.provider, 'claude');
      assert.ok(task.definitionPath.startsWith('.claude/agents/'));
      assert.ok(task.definitionTools.includes('playwright-test/planner_setup_page'));
      assert.match(task.roleInstructions, /Claude role/);
      if (task.agent === roles[1]) {
        await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code());
      }
      return result(task);
    },
    { provider: 'claude', execute: (root, id, ids) => execute(root, id, ids, true) },
  );
  assert.equal(outcome.state, 'complete');
  const { data } = await feature(root, 'F-001');
  assert.equal(data.agentWorkflows[0].provider, 'claude');
  assert.equal(data.agentWorkflows[0].events[0].provider, 'claude');
});

test('再開時にCLI providerを勝手に切り替えない', async (t) => {
  const root = await workspace(t);
  await startWorkflow(root, 'F-001', ['AC-001'], { provider: 'claude' });
  await assert.rejects(
    orchestrate(
      root,
      'F-001',
      [],
      async () => {
        throw new Error('呼ばれてはいけない');
      },
      { provider: 'codex', resume: true },
    ),
    /provider を変更/,
  );
});

test('Codex native は CLI 起動なしで共通フローを完了し、親の委譲記録を保存する', async (t) => {
  const root = await workspace(t);
  const outcome = await orchestrate(
    root,
    'F-001',
    ['AC-001'],
    async (task) => {
      assert.equal(task.transport, 'native');
      assert.equal(task.provider, 'codex');
      if (task.agent === roles[1]) {
        await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code());
      }
      return result(task);
    },
    { provider: 'codex', execute: (root, id, ids) => execute(root, id, ids, true) },
  );
  assert.equal(outcome.state, 'complete');
  const flow = (await feature(root, 'F-001')).data.agentWorkflows[0];
  assert.equal(flow.transport, 'native');
  assert.equal(flow.events[0].delegation.evidence, 'coordinator_reported');
  assert.equal(flow.events[0].invocation, undefined);
});

test('native の receipt 未取得・別タスク・CLIへの再開切替を拒否する', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001'], { provider: 'codex' });
  const workerJSON = JSON.parse(JSON.stringify(result(task)));
  await assert.rejects(acceptWorkflowResult(root, 'F-001', workerJSON), /receipt/);
  await assert.rejects(
    acceptWorkflowResult(root, 'F-001', workerJSON, {
      taskId: 'stale',
      agentId: 'a',
      tool: 'spawn_agent',
    }),
    /receipt/,
  );
  await assert.rejects(
    orchestrate(root, 'F-001', [], () => assert.fail('dispatch'), {
      resume: true,
      provider: 'codex',
      transport: 'cli',
    }),
    /transport を変更/,
  );
  await acceptWorkflowResult(root, 'F-001', workerJSON, {
    taskId: task.taskId,
    agentId: 'a',
    tool: 'spawn_agent',
  });
  assert.equal((await workflowTask(root, 'F-001')).state, 'awaiting_generator');
});

test('native と CLI の引数境界、VS Code の native 指定を検証する', () => {
  assert.equal(
    parseAgentArgs(['F-001', '--provider', 'vscode'], { cli: false }).provider,
    'vscode',
  );
  assert.throws(() => parseAgentArgs(['F-001', '--provider', 'vscode']), /provider/);
  assert.throws(() => parseAgentArgs(['F-001', '--transport', 'native']), /対話環境/);
  assert.throws(
    () => parseAgentArgs(['F-001', '--transport', 'unknown'], { cli: false }),
    /transport/,
  );
});

test('native の別 config と初期化後の変更を計画生成前に拒否する', async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'other.config.ts'), 'export default {};');
  await assert.rejects(
    startWorkflow(root, 'F-001', ['AC-001'], {
      provider: 'codex',
      config: 'other.config.ts',
    }),
    /native MCP の設定/,
  );
  assert.equal((await feature(root, 'F-001')).data.agentWorkflows, undefined);
  await fs.appendFile(path.join(root, 'playwright.config.ts'), '// changed');
  await assert.rejects(startWorkflow(root, 'F-001', ['AC-001'], { provider: 'codex' }), /初期化後/);
});

test('Planner が条件を残していても既存メモを削除したら受け入れない', async (t) => {
  const root = await workspace(t);
  await startWorkflow(root, 'F-001', ['AC-001']);
  await stopWorkflow(root, 'F-001', 'Add planning notes before starting');
  const file = path.join(root, 'specs/search.md');
  await fs.appendFile(file, '\n### 観測メモ\n\n既存 fixture を再利用する。\n');
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, before.replace('既存 fixture を再利用する。', ''));
  await assert.rejects(acceptWorkflowResult(root, 'F-001', result(task)), /既存計画・メモ/);
});

test('CLI providerは引数位置によらず選択でき、toolsを共通表現に正規化する', () => {
  const first = parseAgentArgs(['--provider', 'claude', 'F-001', 'AC-001']);
  const last = parseAgentArgs(['F-001', 'AC-001', '--provider', 'claude']);
  assert.deepEqual(first, last);
  assert.equal(first.provider, 'claude');
  assert.throws(() => parseAgentArgs(['F-001', '--provider', 'unknown']), /provider/);
  assert.deepEqual(normalizeTools('Read, mcp__playwright-test__test_debug'), [
    'Read',
    'playwright-test/test_debug',
  ]);
});

test('Claudeのtool_useとtool_resultを対応づけ、失敗は成功記録にしない', () => {
  const events = createClaudeEvents();
  events.consume({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'a', name: 'mcp__playwright-test__planner_setup_page' }],
    },
  });
  assert.equal(events.invocation.calls.length, 0);
  events.consume({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'denied' }],
    },
  });
  assert.equal(events.invocation.calls[0].status, 'failed');
  events.consume({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'b', name: 'mcp__playwright-test__browser_close' }],
    },
  });
  events.consume({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ text: '{"isError":true}' }] }],
    },
  });
  assert.equal(events.invocation.calls[1].status, 'failed');
});

test('Claudeをspawnし、構造化結果とMCP成功記録を取得する。未取得・拒否・未認証は成功にしない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001'], {
    provider: 'claude',
    transport: 'cli',
  });
  const args = claudeArguments(task, 'agents.json', 'mcp.json');
  assert.ok(args.includes('--agent') && args.includes(task.agent));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--dangerously-skip-permissions') && !args.includes('--model'));
  const worker = path.join(root, 'fake-claude.mjs');
  const receipt = result(task);
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'test-session' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'setup', name: 'mcp__playwright-test__planner_setup_page' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'setup', content: 'page ready', is_error: false },
        ],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, structured_output: receipt },
  ];
  const script = (events) => `
    import fs from 'node:fs/promises';
    let prompt = '';
    for await (const chunk of process.stdin) {
      prompt += chunk;
    }
    if (!prompt.includes('Claude role:')) {
      process.exit(2);
    }
    const args = process.argv.slice(2);
    const agentsFile = args[args.indexOf('--agents') + 1];
    const agents = JSON.parse(await fs.readFile(agentsFile, 'utf8'));
    const tools = agents[${JSON.stringify(task.agent)}].tools;
    if (!tools.includes('mcp__playwright-test__planner_setup_page')) {
      process.exit(4);
    }
    console.log(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n'))});
  `;
  await fs.writeFile(worker, script(stream));
  const response = await dispatchClaude(root, task, {
    executable: process.execPath,
    prefixArgs: [worker],
    progress: () => {},
  });
  assert.deepEqual(response, receipt);
  assert.equal(response.invocation.harness, 'claude-code');
  assert.equal(response.invocation.calls[0].status, 'completed');
  await fs.writeFile(worker, script([stream.at(-1)]));
  await assert.rejects(
    dispatchClaude(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    /成功記録/,
  );
  await fs.writeFile(
    worker,
    script([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'not authenticated',
      },
    ]),
  );
  await assert.rejects(
    dispatchClaude(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    /構造化結果/,
  );
  await fs.writeFile(worker, 'process.exit(3)');
  await assert.rejects(
    dispatchClaude(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    /終了コード 3/,
  );
  assert.equal((await workflowTask(root, 'F-001')).taskId, task.taskId);
});

test('失敗したACだけをHealerに渡し、locator修復後は全対象を再実行する', async (t) => {
  const root = await workspace(t, 2);
  const calls = [],
    runs = [];
  const outcome = await orchestrate(
    root,
    'F-001',
    ['AC-001', 'AC-002'],
    async (task) => {
      calls.push(task.agent);
      if (task.agent === roles[1]) {
        await fs.writeFile(
          path.join(root, 'tests/search.spec.ts'),
          code('古い名前', '保存完了', 2),
        );
      }
      if (task.agent === roles[2]) {
        assert.match(task.prompt, /Work only on F-001\/AC-001\./);
        await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code('保存', '保存完了', 2));
        return result(task, {
          classifications: [{ ac: 'AC-001', category: 'test', reason: 'locator が旧名だった' }],
        });
      }
      return result(task, {
        artifacts: ['AC-001', 'AC-002'].map((ac) => ({
          ac,
          path: task.agent === roles[0] ? 'specs/search.md' : 'tests/search.spec.ts',
        })),
      });
    },
    {
      execute: async (root, id, ids) => {
        runs.push(ids);
        return execute(root, id, ids, runs.length > 1);
      },
    },
  );
  assert.deepEqual(calls, roles);
  assert.equal(outcome.state, 'complete');
  assert.deepEqual(runs, [
    ['AC-001', 'AC-002'],
    ['AC-001', 'AC-002'],
  ]);
  assert.equal((await feature(root, 'F-001')).data.runs[0].results[0].classification, 'test');
});

test('workerの業務質問をギャップとして保存し、親に返して生成を止める', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  const receipt = await acceptWorkflowResult(
    root,
    'F-001',
    result(task, {
      status: 'blocked',
      artifacts: [],
      questions: [
        {
          ac: 'AC-001',
          kind: 'specification',
          question: '仕様と画面が異なります。どちらを採用しますか？',
        },
      ],
    }),
  );
  assert.equal(receipt.state, 'blocked');
  const item = await feature(root, 'F-001');
  assert.equal(item.data.criteria[0].specification, 'unresolved');
  assert.equal(item.data.gaps.at(-1).status, 'open');
  assert.equal((await workflowTask(root, 'F-001')).questions.length, 1);
  assert.equal(item.data.runs.length, 0);
});

test('環境に関する質問では確定済みの業務仕様を変更しない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  await acceptWorkflowResult(
    root,
    'F-001',
    result(task, {
      status: 'blocked',
      artifacts: [],
      questions: [{ ac: 'AC-001', kind: 'environment', question: '認証状態を設定してください' }],
    }),
  );
  const { data } = await feature(root, 'F-001');
  assert.equal(data.criteria[0].specification, 'confirmed');
  assert.equal(data.criteria[0].automation, 'blocked');
  assert.equal(data.gaps.length, 0);
});

test('古い結果・対象外・実在しない成果物を拒否し、自己申告で進めない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  await assert.rejects(
    acceptWorkflowResult(
      root,
      'F-001',
      result(task, { artifacts: [{ ac: 'AC-002', path: 'specs/search.md' }] }),
    ),
    /対象外/,
  );
  await assert.rejects(
    acceptWorkflowResult(
      root,
      'F-001',
      result(task, { artifacts: [{ ac: 'AC-001', path: 'specs/missing.md' }] }),
    ),
    /ENOENT/,
  );
  await acceptWorkflowResult(root, 'F-001', result(task));
  await assert.rejects(acceptWorkflowResult(root, 'F-001', result(task)), /古い結果/);
  const next = await workflowTask(root, 'F-001');
  await assert.rejects(acceptWorkflowResult(root, 'F-001', result(next)), /ENOENT/);
  assert.equal((await workflowTask(root, 'F-001')).agent, roles[1]);
});

test('Healerによる期待値変更を受け入れない', async (t) => {
  const root = await workspace(t);
  let task = await startWorkflow(root, 'F-001', ['AC-001']);
  await acceptWorkflowResult(root, 'F-001', result(task));
  task = await workflowTask(root, 'F-001');
  await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code('古い名前'));
  await acceptWorkflowResult(root, 'F-001', result(task));
  await verifyWorkflow(root, 'F-001', (root, id, ids) => execute(root, id, ids, false));
  task = await workflowTask(root, 'F-001');
  await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code('保存', 'エラー'));
  await assert.rejects(
    acceptWorkflowResult(
      root,
      'F-001',
      result(task, { classifications: [{ ac: 'AC-001', category: 'test', reason: '直した' }] }),
    ),
    /期待値変更/,
  );
  assert.equal((await feature(root, 'F-001')).data.runs.length, 1);
});

test('修復が成功しない場合、上限で停止し、再委譲しない', async (t) => {
  const root = await workspace(t);
  const calls = [];
  const outcome = await orchestrate(
    root,
    'F-001',
    [],
    async (task) => {
      calls.push(task.agent);
      if (task.agent !== roles[0]) {
        await fs.writeFile(path.join(root, 'tests/search.spec.ts'), code());
      }
      return result(task, {
        classifications:
          task.agent === roles[2]
            ? [{ ac: 'AC-001', category: 'test', reason: '調査したが失敗が継続' }]
            : [],
      });
    },
    { execute: (root, id, ids) => execute(root, id, ids, false) },
  );
  assert.deepEqual(calls, roles);
  assert.equal(outcome.state, 'blocked');
  assert.match(outcome.reason, /上限/);
});

test('委譲中に業務仕様が変わった場合は結果を受け入れない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  const item = await feature(root, 'F-001');
  item.data.criteria[0].expected = ['別の期待値'];
  await writeLedger(item.file, item.data, item.body);
  await assert.rejects(acceptWorkflowResult(root, 'F-001', result(task)), /仕様が/);
  await stopWorkflow(root, 'F-001', '新しい判断で再開する');
  assert.equal((await feature(root, 'F-001')).data.agentWorkflows[0].state, 'stopped');
});

test('assertion guardはlocator変更を許し、否定・期待値変更を検出する', () => {
  assert.deepEqual(assertions(code('旧名')), assertions(code('新名')));
  assert.notDeepEqual(
    assertions(code()),
    assertions(code().replace('.toHaveText', '.not.toHaveText')),
  );
  assert.notDeepEqual(assertions(code()), assertions(code('保存', '別の期待値')));
});

test('Codexを実プロセスとしてspawnし、stdinで定義を渡し、JSONファイルから戻り値を読む', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001'], {
    provider: 'codex',
    transport: 'cli',
  });
  const args = codexArguments(root, task, 'schema.json', 'result.json');
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('mcp_servers.playwright-test.required=true'));
  assert.ok(args.some((arg) => arg.includes('enabled_tools')));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--model'));
  assert.ok(args.includes('--approve-for-me'));
  assert.ok(!args.includes('--sandbox'));
  const worker = path.join(root, 'fake-worker.mjs');
  const receipt = result(task);
  await fs.writeFile(
    worker,
    `
      import fs from 'node:fs/promises';
      let prompt = '';
      for await (const chunk of process.stdin) {
        prompt += chunk;
      }
      if (!prompt.includes('Official role:')) {
        process.exit(2);
      }
      const args = process.argv.slice(2);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'playwright-test',
          tool: 'planner_setup_page',
          status: 'completed',
        },
      }));
      const resultFile = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(resultFile, ${JSON.stringify(JSON.stringify(receipt))});
    `,
  );
  assert.deepEqual(
    await dispatchCodex(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    receipt,
  );
  await fs.writeFile(
    worker,
    `
      import fs from 'node:fs/promises';
      const args = process.argv.slice(2);
      const resultFile = args[args.indexOf('--output-last-message') + 1];
      await fs.writeFile(resultFile, ${JSON.stringify(JSON.stringify(receipt))});
    `,
  );
  await assert.rejects(
    dispatchCodex(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    /成功記録がありません/,
  );
  await fs.writeFile(worker, 'process.exit(3)');
  await assert.rejects(
    dispatchCodex(root, task, {
      executable: process.execPath,
      prefixArgs: [worker],
      progress: () => {},
    }),
    /終了コード 3/,
  );
  assert.equal((await workflowTask(root, 'F-001')).taskId, task.taskId);
});

test('CLI は adapter の実行・MCP成功の記録を必須とし native receipt で代用しない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001'], {
    provider: 'codex',
    transport: 'cli',
  });
  const output = result(task);
  await assert.rejects(acceptWorkflowResult(root, 'F-001', output), /adapter の実行記録/);
  const invocation = { harness: 'codex-exec', calls: [] };
  Object.defineProperty(output, 'invocation', { value: invocation });
  await assert.rejects(acceptWorkflowResult(root, 'F-001', output), /成功記録/);
  invocation.calls.push({
    server: 'playwright-test',
    tool: 'planner_setup_page',
    status: 'completed',
  });
  await acceptWorkflowResult(root, 'F-001', output);
  const event = (await feature(root, 'F-001')).data.agentWorkflows[0].events[0];
  assert.equal(event.transport, 'cli');
  assert.equal(event.delegation, undefined);
});

test('transport のない旧台帳は維持し、native/CLI の証拠を後付けしない', async (t) => {
  const root = await workspace(t);
  const task = await startWorkflow(root, 'F-001', ['AC-001']);
  const item = await feature(root, 'F-001');
  delete item.data.agentWorkflows[0].transport;
  await writeLedger(item.file, item.data, item.body);
  assert.equal((await workflowTask(root, 'F-001')).transport, 'legacy');
  await acceptWorkflowResult(root, 'F-001', JSON.parse(JSON.stringify(result(task))));
  const flow = (await feature(root, 'F-001')).data.agentWorkflows[0];
  assert.equal(flow.transport, undefined);
  assert.equal(flow.events[0].transport, 'legacy');
  assert.equal(flow.events[0].delegation, undefined);
});
