import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { definitionPath, normalizeTools, providers, transports } from './agent-providers.mjs';
import {
  agentRoles,
  agentResultSchema,
  requireCondition,
  isNonemptyText,
  isBlockedResult,
  validateAgentResult,
  validateDelegationEvidence,
} from './agent-contract.mjs';
import { buildWorkerPrompt } from './agent-prompt.mjs';
import { verifyNativeConfiguration } from './native-settings.mjs';
import { assertions, captureTestGuards, verifyTestGuards } from './test-guards.mjs';
import {
  feature,
  validate,
  plan,
  run,
  context,
  local,
  hash,
  hasTestTitle,
  writeLedger,
} from './migration.mjs';

// Preserve the public API used by the CLI and existing tests.
export { agentResultSchema, validateAgentResult, assertions };

const terminalStates = ['complete', 'blocked', 'stopped'];
const resumableStates = [
  'awaiting_planner',
  'awaiting_generator',
  'awaiting_healer',
  'awaiting_run',
];
const agentForState = {
  awaiting_planner: agentRoles.planner,
  awaiting_generator: agentRoles.generator,
  awaiting_healer: agentRoles.healer,
};
const specificationFields = ['preconditions', 'inputs', 'steps', 'expected'];
const maxWorkflowSteps = 12;
const now = () => new Date().toISOString();

function ledgerFingerprint(ledger) {
  const { agentWorkflows, ...data } = ledger.data;
  return hash(JSON.stringify({ data, body: ledger.body }));
}

function specificationFingerprint(data, acceptanceIds) {
  const criteria = data.criteria
    .filter((criterion) => acceptanceIds.includes(criterion.id))
    .map(({ automation, blockedReason, plan, tests, prs, ...specification }) => specification);

  return hash(JSON.stringify({ sources: data.sources, criteria, decisions: data.decisions }));
}

async function saveLedger(ledger) {
  await writeLedger(ledger.file, ledger.data, ledger.body);
}

function currentWorkflow(ledger) {
  const workflow = ledger.data.agentWorkflows?.at(-1);
  requireCondition(workflow, '委譲フローがありません。workflow-start を実行してください');
  return workflow;
}

async function loadWorkflow(root, featureId) {
  const ledger = await feature(root, featureId);
  const workflow = currentWorkflow(ledger);
  await validate(root, ledger.data);

  if (!terminalStates.includes(workflow.state)) {
    if (workflow.transport === 'native') {
      await verifyNativeConfiguration(
        root,
        workflow.provider,
        workflow.config || 'playwright.config.ts',
      );
    }
    requireCondition(
      specificationFingerprint(ledger.data, workflow.acs) === workflow.basis,
      '仕様が委譲開始後に変更されています。workflow-stop 後に新しいフローを開始してください',
    );
  }
  return { ledger, workflow };
}

function requestedAcceptanceIds(workflow) {
  return workflow.state === 'awaiting_healer' ? workflow.failed : workflow.acs;
}

async function issueNextTask(root, ledger, workflow) {
  const agent = agentForState[workflow.state];
  if (!agent) {
    delete workflow.pending;
    return;
  }

  const file = definitionPath(agent, workflow.provider || 'codex');
  const definition = await fs.readFile(local(root, file), 'utf8');
  workflow.pending = {
    taskId: crypto.randomUUID(),
    agent,
    definitionPath: file,
    definitionHash: hash(definition),
    ledgerHash: ledgerFingerprint(ledger),
    tests: await captureTestGuards(root),
    at: now(),
  };
  const planContent = await fs.readFile(local(root, workflow.plan), 'utf8');
  workflow.pending.planHash = hash(planContent);
  workflow.pending.planLines = planContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(hash);
}

function selectConfirmedCriteria(ledger, acceptanceIds) {
  const selected = acceptanceIds?.length
    ? ledger.data.criteria.filter((criterion) => acceptanceIds.includes(criterion.id))
    : ledger.data.criteria.filter((criterion) => criterion.specification === 'confirmed');

  const containsAllRequested = !acceptanceIds?.length || selected.length === acceptanceIds.length;
  const hasUniqueIds = new Set(selected.map((criterion) => criterion.id)).size === selected.length;
  requireCondition(
    selected.length && containsAllRequested && hasUniqueIds,
    '対象 AC がありません、または重複しています',
  );
  requireCondition(
    selected.every((criterion) => criterion.specification === 'confirmed'),
    '未確定 AC は委譲できません',
  );
  return selected;
}

async function validateWorkflowOptions(root, provider, transport, options) {
  requireCondition(
    providers.includes(provider),
    'provider は codex / claude / vscode を指定してください',
  );
  requireCondition(transports.includes(transport), 'transport は native / cli を指定してください');
  requireCondition(
    transport !== 'cli' || provider !== 'vscode',
    'VS Code は native 委譲を使用してください',
  );

  const validHealLimit =
    options.maxHealAttempts === undefined ||
    (Number.isInteger(options.maxHealAttempts) &&
      options.maxHealAttempts >= 1 &&
      options.maxHealAttempts <= 3);
  requireCondition(validHealLimit, 'Healer の上限は1〜3回です');

  if (options.config) {
    await fs.access(local(root, options.config));
  }
  if (options.seed) {
    await fs.access(local(root, options.seed));
  }
  if (transport === 'native') {
    await verifyNativeConfiguration(root, provider, options.config || 'playwright.config.ts');
  }
  for (const agent of Object.values(agentRoles)) {
    await fs.access(local(root, definitionPath(agent, provider)));
  }
}

export async function startWorkflow(root, featureId, acceptanceIds, options = {}) {
  let ledger = await feature(root, featureId);
  await validate(root, ledger.data);
  const hasActiveWorkflow = ledger.data.agentWorkflows?.some(
    (workflow) => !terminalStates.includes(workflow.state),
  );
  requireCondition(!hasActiveWorkflow, 'この機能には実行中の委譲フローがあります');

  const selected = selectConfirmedCriteria(ledger, acceptanceIds);
  const provider = options.provider || 'vscode';
  const transport = options.transport || 'native';
  await validateWorkflowOptions(root, provider, transport, options);

  const selectedIds = selected.map((criterion) => criterion.id);
  const planPath = await plan(root, featureId, selectedIds, options);
  ledger = await feature(root, featureId);
  const workflow = {
    id: crypto.randomUUID(),
    provider,
    transport,
    acs: selectedIds,
    state: 'awaiting_planner',
    basis: specificationFingerprint(ledger.data, selectedIds),
    plan: planPath,
    config: options.config || null,
    seed: options.seed || 'tests/seed.spec.ts',
    maxHealAttempts: options.maxHealAttempts || 1,
    healAttempts: 0,
    events: [],
    startedAt: now(),
  };

  ledger.data.agentWorkflows ||= [];
  ledger.data.agentWorkflows.push(workflow);
  await issueNextTask(root, ledger, workflow);
  await saveLedger(ledger);
  return workflowTask(root, featureId);
}

async function readTaskAssets(root, workflow, information) {
  const assetPaths = [
    ...new Set([
      workflow.plan,
      workflow.seed,
      workflow.config || 'playwright.config.ts',
      ...information.inventory.filter((file) => file.startsWith('tests/')),
    ]),
  ];
  const assets = [];

  for (const assetPath of assetPaths) {
    try {
      const content = await fs.readFile(local(root, assetPath), 'utf8');
      assets.push({ path: assetPath, content });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return assets;
}

export async function workflowTask(root, featureId) {
  const { ledger, workflow } = await loadWorkflow(root, featureId);
  const identity = {
    workflowId: workflow.id,
    transport: workflow.transport || 'legacy',
    provider: workflow.provider || 'codex',
    state: workflow.state,
  };

  if (!workflow.pending) {
    return {
      ...identity,
      questions: workflow.events.at(-1)?.questions || [],
      next:
        workflow.state === 'awaiting_run'
          ? `npm run migration -- workflow-verify ${featureId}`
          : null,
    };
  }

  const definition = await fs.readFile(local(root, workflow.pending.definitionPath), 'utf8');
  requireCondition(
    hash(definition) === workflow.pending.definitionHash,
    '委譲中にエージェント定義が変更されています',
  );
  const header = definition.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = header ? YAML.parse(header[1]) : null;
  requireCondition(metadata?.name === workflow.pending.agent, 'エージェント定義の名前が不正です');
  const tools = normalizeTools(metadata.tools);
  requireCondition(
    ledgerFingerprint(ledger) === workflow.pending.ledgerHash,
    '委譲中に台帳が変更されています',
  );

  const acceptanceIds = requestedAcceptanceIds(workflow);
  const information = await context(root, featureId);
  const selected = information.criteria.filter((criterion) => acceptanceIds.includes(criterion.id));
  const assets = await readTaskAssets(root, workflow, information);
  const projectRules = await fs.readFile(local(root, 'AGENTS.md'), 'utf8');
  const prompt = buildWorkerPrompt({
    featureId,
    acceptanceIds,
    workflow,
    projectRules,
    definition,
    context: {
      title: information.title,
      ledger: information.ledger,
      sources: information.sources,
      criteria: selected,
      decisions: information.decisions.filter((decision) => acceptanceIds.includes(decision.ac)),
      inventory: information.inventory,
      assets,
      failingRun: workflow.lastRun || null,
    },
  });

  return {
    ...identity,
    taskId: workflow.pending.taskId,
    agent: workflow.pending.agent,
    definitionPath: workflow.pending.definitionPath,
    definitionHash: workflow.pending.definitionHash,
    definitionTools: tools,
    roleDescription: metadata.description || metadata.name,
    roleInstructions: definition.slice(header[0].length).trim(),
    config: workflow.config,
    prompt,
    resultSchema: agentResultSchema,
  };
}

async function verifyResultContext(root, ledger, workflow) {
  requireCondition(
    ledgerFingerprint(ledger) === workflow.pending.ledgerHash,
    'worker による台帳変更、または同時編集を検出しました',
  );

  const definition = await fs.readFile(local(root, workflow.pending.definitionPath), 'utf8');
  requireCondition(
    hash(definition) === workflow.pending.definitionHash,
    'エージェント定義が変更されています',
  );
}

function createResultEvent(workflow, result, receipt) {
  const event = {
    stage: workflow.state,
    taskId: result.taskId,
    agent: result.agent,
    definitionHash: workflow.pending.definitionHash,
    requestedAt: workflow.pending.at,
    at: now(),
    status: result.status,
    summary: result.summary,
    questions: result.questions,
    classifications: result.classifications,
    reused: result.reused,
    artifacts: [],
    provider: workflow.provider || 'codex',
    transport: workflow.transport || 'legacy',
  };

  if (workflow.transport === 'native') {
    event.delegation = {
      taskId: receipt.taskId,
      agentId: receipt.agentId,
      tool: receipt.tool,
      evidence: 'coordinator_reported',
    };
  }
  if (result.invocation) {
    event.invocation = result.invocation;
  }
  return event;
}

function verifyPlanArtifact(featureId, criterion, artifact, code, workflow) {
  requireCondition(artifact.path === workflow.plan, 'Planner の保存先が対象計画と一致しません');
  const containsId = code.includes(`${featureId}/${criterion.id}`);
  const preservesSpecification = specificationFields.every((field) =>
    criterion[field].every((value) => code.includes(value)),
  );
  requireCondition(
    containsId && preservesSpecification,
    'Planner が確定済み条件を省略・変更しています',
  );
}

function verifyTestArtifact(featureId, artifact, code, guards) {
  const isSpecFile =
    artifact.path.startsWith('tests/') && /\.spec\.(ts|js|mjs)$/.test(artifact.path);
  requireCondition(
    isSpecFile && hasTestTitle(code, `${featureId}/${artifact.ac}`),
    'テストの保存先またはタイトルが不正です',
  );
  requireCondition(
    guards[artifact.path]?.controls.length === 0,
    '除外・実行制御を含むテストは受け入れられません',
  );
  requireCondition(assertions(code).length > 0, '検証を含まないテストは受け入れられません');
}

async function verifyResultArtifacts(root, featureId, ledger, workflow, result, guards, event) {
  const acceptanceIds = requestedAcceptanceIds(workflow);
  const coversRequestedIds = acceptanceIds.every((id) =>
    result.artifacts.some((artifact) => artifact.ac === id),
  );
  requireCondition(coversRequestedIds, '対象 AC の artifact が不足しています');

  for (const artifact of result.artifacts) {
    const code = await fs.readFile(local(root, artifact.path), 'utf8');
    if (workflow.state === 'awaiting_planner') {
      const updatedLines = code
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(hash);
      let position = 0;
      for (const lineHash of workflow.pending.planLines || []) {
        const found = updatedLines.indexOf(lineHash, position);
        requireCondition(
          found >= 0,
          'Planner による既存計画・メモの削除や変更を検出しました。既存行を保持して追記してください',
        );
        position = found + 1;
      }
      const criterion = ledger.data.criteria.find((criterion) => criterion.id === artifact.ac);
      verifyPlanArtifact(featureId, criterion, artifact, code, workflow);
    } else {
      verifyTestArtifact(featureId, artifact, code, guards);
    }
    event.artifacts.push({ ...artifact, hash: hash(code) });
  }

  if (workflow.state === 'awaiting_healer') {
    const classifiesAllFailures = acceptanceIds.every((id) =>
      result.classifications.some(
        (classification) => classification.ac === id && classification.category === 'test',
      ),
    );
    requireCondition(classifiesAllFailures, 'Healer は各失敗の分類を返してください');
  }
}

function markImplementedCriteria(ledger, artifacts) {
  for (const artifact of artifacts) {
    const criterion = ledger.data.criteria.find((criterion) => criterion.id === artifact.ac);
    criterion.tests = [...new Set([...criterion.tests, artifact.path])];
    criterion.automation = 'implemented';
    delete criterion.blockedReason;
  }
}

function recordFailureClassifications(ledger, workflow, result, event) {
  const record = ledger.data.runs.find((run) => run.id === workflow.lastRun.id);
  for (const classification of result.classifications) {
    const failedResult = record?.results.find((result) => result.ac === classification.ac);
    if (failedResult) {
      Object.assign(failedResult, {
        classification: classification.category,
        reason: classification.reason,
        classifiedAt: event.at,
      });
    }
  }
}

function recordBlockedCriteria(ledger, acceptanceIds, result) {
  for (const question of result.questions) {
    if (question.kind === 'environment') {
      continue;
    }

    const highestGapNumber = Math.max(0, ...ledger.data.gaps.map((gap) => Number(gap.id.slice(4))));
    const gapId = `GAP-${String(highestGapNumber + 1).padStart(3, '0')}`;
    ledger.data.gaps.push({
      id: gapId,
      ac: question.ac,
      status: 'open',
      question: question.question,
    });
    const criterion = ledger.data.criteria.find((criterion) => criterion.id === question.ac);
    criterion.gaps.push(gapId);
    criterion.specification = 'unresolved';
  }

  for (const criterion of ledger.data.criteria.filter((criterion) =>
    acceptanceIds.includes(criterion.id),
  )) {
    criterion.automation = 'blocked';
    criterion.blockedReason = result.summary;
  }
}

export async function acceptWorkflowResult(root, featureId, result, receipt = result?.delegation) {
  validateAgentResult(result);
  const { ledger, workflow } = await loadWorkflow(root, featureId);
  const matchesPendingTask =
    workflow.pending &&
    result.taskId === workflow.pending.taskId &&
    result.agent === workflow.pending.agent;
  requireCondition(matchesPendingTask, '古い結果または別エージェントの結果です');
  validateDelegationEvidence(workflow, result, receipt);
  await verifyResultContext(root, ledger, workflow);

  const acceptanceIds = requestedAcceptanceIds(workflow);
  const resultEntries = [...result.artifacts, ...result.questions, ...result.classifications];
  requireCondition(
    resultEntries.every((entry) => acceptanceIds.includes(entry.ac)),
    '対象外 AC の結果があります',
  );
  const guards = await verifyTestGuards(root, workflow);
  if (workflow.state !== 'awaiting_planner') {
    const planContent = await fs.readFile(local(root, workflow.plan), 'utf8');
    requireCondition(
      hash(planContent) === workflow.pending.planHash,
      'Generator/Healer による計画変更を検出しました',
    );
  }
  for (const reusedPath of result.reused) {
    await fs.access(local(root, reusedPath));
  }

  const event = createResultEvent(workflow, result, receipt);
  const blocked = isBlockedResult(result);
  if (!blocked) {
    await verifyResultArtifacts(root, featureId, ledger, workflow, result, guards, event);
    if (workflow.state !== 'awaiting_planner') {
      markImplementedCriteria(ledger, result.artifacts);
    }
  }
  workflow.events.push(event);
  if (workflow.state === 'awaiting_healer') {
    recordFailureClassifications(ledger, workflow, result, event);
  }

  if (blocked) {
    workflow.state = 'blocked';
    workflow.reason = result.summary;
    recordBlockedCriteria(ledger, acceptanceIds, result);
    delete workflow.pending;
  } else {
    workflow.state = workflow.state === 'awaiting_planner' ? 'awaiting_generator' : 'awaiting_run';
    await issueNextTask(root, ledger, workflow);
  }

  await validate(root, ledger.data);
  await saveLedger(ledger);
  return { workflowId: workflow.id, state: workflow.state, questions: result.questions };
}

function applyVerificationOutcome(workflow, record, acceptanceIds) {
  const allResultsPassed =
    record.results.every((result) => result.status === 'passed') && record.exitCode === 0;
  workflow.lastRun = record;
  workflow.events.push({
    stage: 'verification',
    run: record.id,
    at: now(),
    status: allResultsPassed ? 'completed' : 'failed',
  });
  workflow.failed = acceptanceIds.filter(
    (id) => record.results.find((result) => result.ac === id)?.status !== 'passed',
  );

  if (!workflow.failed.length && record.exitCode === 0) {
    workflow.state = 'complete';
    workflow.completedAt = now();
    return;
  }
  if (workflow.healAttempts < workflow.maxHealAttempts && workflow.failed.length) {
    workflow.healAttempts++;
    workflow.state = 'awaiting_healer';
    return;
  }
  workflow.state = 'blocked';
  workflow.reason = '検証失敗。Healer の上限に到達、または runner 自体が失敗しました';
}

export async function verifyWorkflow(root, featureId, execute = run) {
  const { workflow } = await loadWorkflow(root, featureId);
  requireCondition(workflow.state === 'awaiting_run', '委譲結果の受け入れ後に検証してください');
  const record = await execute(root, featureId, workflow.acs, {
    config: workflow.config || undefined,
  });

  const ledger = await feature(root, featureId);
  const refreshedWorkflow = currentWorkflow(ledger);
  requireCondition(
    refreshedWorkflow.id === workflow.id && refreshedWorkflow.state === 'awaiting_run',
    '検証中にフローが変更されました',
  );
  applyVerificationOutcome(refreshedWorkflow, record, workflow.acs);
  await issueNextTask(root, ledger, refreshedWorkflow);
  await saveLedger(ledger);
  return { workflowId: refreshedWorkflow.id, state: refreshedWorkflow.state, run: record };
}

export async function stopWorkflow(root, featureId, reason) {
  const ledger = await feature(root, featureId);
  const workflow = currentWorkflow(ledger);
  requireCondition(isNonemptyText(reason), '停止理由が必要です');
  requireCondition(
    !['complete', 'stopped'].includes(workflow.state),
    '終了済みフローは停止できません',
  );
  workflow.state = 'stopped';
  workflow.reason = reason;
  delete workflow.pending;
  await saveLedger(ledger);
  return { workflowId: workflow.id, state: workflow.state };
}

function validateResumeOptions(workflow, acceptanceIds, options) {
  requireCondition(
    resumableStates.includes(workflow.state),
    '終了済みフローは新規開始してください',
  );
  if (options.provider) {
    requireCondition(
      options.provider === (workflow.provider || 'codex'),
      '再開時に provider を変更できません。停止後に新規開始してください',
    );
  }
  if (workflow.transport && options.transport) {
    requireCondition(
      options.transport === workflow.transport,
      '再開時に transport を変更できません。停止後に新規開始してください',
    );
  }
  if (acceptanceIds?.length) {
    const requested = JSON.stringify([...acceptanceIds].sort());
    const previous = JSON.stringify([...workflow.acs].sort());
    requireCondition(requested === previous, '再開対象 AC が既存フローと一致しません');
  }
}

export async function orchestrate(root, featureId, acceptanceIds, dispatch, options = {}) {
  const ledger = await feature(root, featureId);
  const previousWorkflow = ledger.data.agentWorkflows?.at(-1);
  if (options.resume && previousWorkflow) {
    validateResumeOptions(previousWorkflow, acceptanceIds, options);
  } else {
    await startWorkflow(root, featureId, acceptanceIds, options);
  }

  // Planner, Generator, verification, and bounded repair rounds.
  for (let step = 0; step < maxWorkflowSteps; step++) {
    const { workflow } = await loadWorkflow(root, featureId);
    if (terminalStates.includes(workflow.state)) {
      return {
        workflowId: workflow.id,
        state: workflow.state,
        reason: workflow.reason,
        questions: workflow.events.at(-1)?.questions || [],
      };
    }
    if (workflow.state === 'awaiting_run') {
      await verifyWorkflow(root, featureId, options.execute || run);
      continue;
    }

    const task = await workflowTask(root, featureId);
    options.onProgress?.({ stage: workflow.state, agent: task.agent, taskId: task.taskId });
    const result = await dispatch(task);
    await acceptWorkflowResult(root, featureId, result);
  }
  throw new Error('委譲フローの処理上限に到達しました');
}
