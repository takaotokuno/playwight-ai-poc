export const agentRoles = {
  planner: 'playwright-test-planner',
  generator: 'playwright-test-generator',
  healer: 'playwright-test-healer',
};

const agentNames = Object.values(agentRoles);
const questionKinds = ['specification', 'environment'];
const failureCategories = ['test', 'environment', 'application', 'specification', 'unclassified'];

export const requiredSetupTools = {
  [agentRoles.planner]: 'planner_setup_page',
  [agentRoles.generator]: 'generator_setup_page',
  [agentRoles.healer]: 'test_debug',
};

export function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function isNonemptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function objectSchema(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const agentResultSchema = objectSchema({
  taskId: { type: 'string' },
  agent: { type: 'string', enum: agentNames },
  status: { type: 'string', enum: ['completed', 'blocked'] },
  summary: { type: 'string' },
  artifacts: {
    type: 'array',
    items: objectSchema({ ac: { type: 'string' }, path: { type: 'string' } }),
  },
  questions: {
    type: 'array',
    items: objectSchema({
      ac: { type: 'string' },
      kind: { type: 'string', enum: questionKinds },
      question: { type: 'string' },
    }),
  },
  classifications: {
    type: 'array',
    items: objectSchema({
      ac: { type: 'string' },
      category: { type: 'string', enum: failureCategories },
      reason: { type: 'string' },
    }),
  },
  reused: { type: 'array', items: { type: 'string' } },
});

export function validateAgentResult(result) {
  requireCondition(
    result && typeof result === 'object',
    'エージェント結果は JSON オブジェクトで指定してください',
  );

  const hasRequiredFields = agentResultSchema.required.every((key) => Object.hasOwn(result, key));
  const hasExpectedFieldCount = Object.keys(result).length === agentResultSchema.required.length;
  requireCondition(
    hasRequiredFields && hasExpectedFieldCount,
    'エージェント結果のフィールドが不正です',
  );
  requireCondition(
    isNonemptyText(result.taskId) &&
      agentNames.includes(result.agent) &&
      ['completed', 'blocked'].includes(result.status) &&
      isNonemptyText(result.summary),
    'エージェント結果の識別子・状態が不正です',
  );

  for (const field of ['artifacts', 'questions', 'classifications', 'reused']) {
    requireCondition(Array.isArray(result[field]), `${field} は配列で指定してください`);
  }
  requireCondition(result.reused.every(isNonemptyText), '再利用先が不正です');

  for (const artifact of result.artifacts) {
    requireCondition(
      Object.keys(artifact).length === 2 &&
        isNonemptyText(artifact.ac) &&
        isNonemptyText(artifact.path),
      'artifact が不正です',
    );
  }
  for (const question of result.questions) {
    requireCondition(
      Object.keys(question).length === 3 &&
        isNonemptyText(question.ac) &&
        isNonemptyText(question.question) &&
        questionKinds.includes(question.kind),
      'question が不正です',
    );
  }
  for (const classification of result.classifications) {
    requireCondition(
      Object.keys(classification).length === 3 &&
        isNonemptyText(classification.ac) &&
        isNonemptyText(classification.reason) &&
        failureCategories.includes(classification.category),
      'classification が不正です',
    );
  }
}

export function hasSuccessfulSetup(invocation, agent) {
  return invocation.calls.some(
    (call) =>
      call.server === 'playwright-test' &&
      call.tool === requiredSetupTools[agent] &&
      call.status === 'completed',
  );
}

export function validateDelegationEvidence(workflow, result, receipt) {
  if (workflow.transport === 'native') {
    requireCondition(
      receipt?.taskId === result.taskId &&
        isNonemptyText(receipt.agentId) &&
        isNonemptyText(receipt.tool),
      '親が記録した native 委譲 receipt が必要です（taskId / agentId / tool）',
    );
    requireCondition(!result.invocation, 'native フローに CLI の実行記録は受け入れられません');
  }

  if (workflow.transport === 'cli') {
    const expectedHarness = workflow.provider === 'claude' ? 'claude-code' : 'codex-exec';
    requireCondition(
      result.invocation?.harness === expectedHarness && Array.isArray(result.invocation.calls),
      'CLI adapter の実行記録が必要です',
    );
    if (result.status === 'completed') {
      requireCondition(
        hasSuccessfulSetup(result.invocation, result.agent),
        '必要な Playwright MCP 呼び出しの成功記録がありません',
      );
    }
  }
}

export function isBlockedResult(result) {
  return (
    result.status === 'blocked' ||
    result.questions.length > 0 ||
    result.classifications.some((classification) => classification.category !== 'test')
  );
}
