import { requireCondition as requireValue, isNonemptyText as nonempty } from './agent-contract.mjs';

function uniqueIds(items, prefix) {
  requireValue(Array.isArray(items), `${prefix} は配列で指定してください`);
  const ids = items.map((item) => item.id);
  requireValue(
    ids.every((id) => new RegExp(`^${prefix}-\\d{3,}$`).test(id)),
    `${prefix} ID が不正です`,
  );
  requireValue(new Set(ids).size === ids.length, `${prefix} ID が重複しています`);
  return new Set(ids);
}

function validateSources(data) {
  for (const source of data.sources) {
    requireValue(
      nonempty(source.file) && nonempty(source.snapshot) && /^[a-f0-9]{64}$/.test(source.revision),
      `${source.id}: 出典が不足しています`,
    );
  }
}

function validateGaps(data, criteria, decisions) {
  for (const gap of data.gaps) {
    requireValue(
      criteria.has(gap.ac) && nonempty(gap.question) && ['open', 'resolved'].includes(gap.status),
      `${gap.id}: ギャップが不正です`,
    );
    if (gap.status === 'resolved') {
      requireValue(
        decisions.has(gap.decision) &&
          data.decisions.find((d) => d.id === gap.decision).ac === gap.ac,
        `${gap.id}: 解決根拠の判断がありません`,
      );
    }
  }
}

function validateDecisions(data, criteria, decisions) {
  for (const decision of data.decisions) {
    requireValue(
      criteria.has(decision.ac) &&
        nonempty(decision.question) &&
        nonempty(decision.answer) &&
        nonempty(decision.author) &&
        nonempty(decision.at),
      `${decision.id}: 判断記録が不足しています`,
    );
    requireValue(
      ['business', 'observed-baseline'].includes(decision.basis),
      `${decision.id}: 判断の根拠種別が不正です`,
    );
    if (decision.basis === 'observed-baseline') {
      requireValue(
        nonempty(decision.environment) && nonempty(decision.observation),
        '現状基準には環境と観測記録が必要です',
      );
    }
    if (decision.supersedes) {
      requireValue(
        decisions.has(decision.supersedes) && decision.supersedes !== decision.id,
        '旧判断の参照が不正です',
      );
    }
  }
}

function validateCriteria(data, sources, gaps, decisions) {
  for (const ac of data.criteria) {
    requireValue(
      nonempty(ac.original) && sources.has(ac.source) && nonempty(ac.location),
      `${ac.id}: 原文・出典位置が不足しています`,
    );
    requireValue(
      ['unresolved', 'confirmed'].includes(ac.specification),
      `${ac.id}: 仕様状態が不正です`,
    );
    requireValue(
      ['not_started', 'implemented', 'blocked'].includes(ac.automation),
      `${ac.id}: 自動化状態が不正です`,
    );
    for (const name of ['gaps', 'decisions', 'tests', 'prs']) {
      requireValue(Array.isArray(ac[name]), `${ac.id}: ${name} は配列で指定してください`);
    }
    requireValue(
      ac.gaps.every((id) => gaps.has(id) && data.gaps.find((g) => g.id === id).ac === ac.id),
      `${ac.id}: GAP 参照が不正です`,
    );
    requireValue(
      ac.decisions.every(
        (id) => decisions.has(id) && data.decisions.find((d) => d.id === id).ac === ac.id,
      ),
      `${ac.id}: DEC 参照が不正です`,
    );
    if (ac.specification === 'confirmed') {
      for (const name of ['preconditions', 'inputs', 'steps', 'expected']) {
        requireValue(
          Array.isArray(ac[name]) && ac[name].length > 0 && ac[name].every(nonempty),
          `${ac.id}: ${name} を具体化してください（該当なしは明記）`,
        );
      }
      requireValue(
        ac.gaps.every((id) => data.gaps.find((g) => g.id === id).status === 'resolved'),
        `${ac.id}: 未解決ギャップがあります`,
      );
      requireValue(
        ac.decisions.length > 0 || ac.confirmation?.basis === 'source',
        `${ac.id}: 確定の根拠がありません`,
      );
      if (ac.confirmation?.basis === 'source') {
        requireValue(
          nonempty(ac.confirmation.note) && nonempty(ac.confirmation.at),
          `${ac.id}: 原文から確定した根拠を記録してください`,
        );
      }
    }
    if (ac.automation === 'implemented') {
      requireValue(ac.tests.length > 0, `${ac.id}: 実装先がありません`);
    }
    if (ac.automation === 'blocked') {
      requireValue(nonempty(ac.blockedReason), `${ac.id}: 阻害理由がありません`);
    }
    requireValue(ac.tests.every(nonempty), `${ac.id}: テスト参照が不正です`);
    requireValue(
      ac.prs.every((url) => /^https:\/\//.test(url)),
      `${ac.id}: PR URL が不正です`,
    );
  }
}

function validateRuns(data, criteria) {
  for (const record of data.runs) {
    requireValue(
      nonempty(record.id) &&
        nonempty(record.at) &&
        nonempty(record.command) &&
        Array.isArray(record.results),
      '実行記録が不正です',
    );
    for (const result of record.results) {
      requireValue(
        criteria.has(result.ac) && ['passed', 'failed', 'not_run'].includes(result.status),
        '実行結果の AC/状態が不正です',
      );
      requireValue(
        result.status === 'passed'
          ? result.classification === null
          : ['test', 'environment', 'application', 'specification', 'unclassified'].includes(
              result.classification,
            ),
        '失敗分類が不正です',
      );
    }
  }
}

function validateWorkflows(data, criteria) {
  if (data.agentWorkflows !== undefined) {
    requireValue(Array.isArray(data.agentWorkflows), 'agentWorkflows は配列で指定してください');
    const flowIds = new Set();
    for (const flow of data.agentWorkflows) {
      requireValue(
        flow.provider === undefined || ['codex', 'claude', 'vscode'].includes(flow.provider),
        '委譲 provider が不正です',
      );
      requireValue(
        flow.transport === undefined || ['native', 'cli'].includes(flow.transport),
        '委譲 transport が不正です',
      );
      requireValue(
        nonempty(flow.id) && !flowIds.has(flow.id),
        '委譲フローの ID が不正・重複しています',
      );
      flowIds.add(flow.id);
      requireValue(
        [
          'awaiting_planner',
          'awaiting_generator',
          'awaiting_run',
          'awaiting_healer',
          'complete',
          'blocked',
          'stopped',
        ].includes(flow.state),
        '委譲フローの状態が不正です',
      );
      requireValue(
        Array.isArray(flow.acs) &&
          flow.acs.length &&
          flow.acs.every((id) => criteria.has(id)) &&
          new Set(flow.acs).size === flow.acs.length,
        '委譲対象の AC が不正です',
      );
      requireValue(
        Array.isArray(flow.events) && nonempty(flow.startedAt) && /^[a-f0-9]{64}$/.test(flow.basis),
        '委譲フローの履歴・根拠が不正です',
      );
      requireValue(
        Number.isInteger(flow.maxHealAttempts) &&
          flow.maxHealAttempts >= 1 &&
          flow.maxHealAttempts <= 3 &&
          Number.isInteger(flow.healAttempts) &&
          flow.healAttempts >= 0 &&
          flow.healAttempts <= flow.maxHealAttempts,
        '修復回数が不正です',
      );
      if (['awaiting_planner', 'awaiting_generator', 'awaiting_healer'].includes(flow.state)) {
        requireValue(
          flow.pending &&
            nonempty(flow.pending.taskId) &&
            flow.pending.agent === `playwright-test-${flow.state.slice('awaiting_'.length)}` &&
            /^[a-f0-9]{64}$/.test(flow.pending.definitionHash),
          '委譲タスクの識別子・役割が不正です',
        );
      } else {
        requireValue(!flow.pending, 'この状態では委譲タスクを保持できません');
      }
    }
  }
}

export function validateData(data) {
  requireValue(
    data?.version === 1 && /^F-\d{3,}$/.test(data.id) && nonempty(data.title),
    'version/id/title が不正です',
  );
  const sources = uniqueIds(data.sources, 'SRC');
  const criteria = uniqueIds(data.criteria, 'AC');
  const gaps = uniqueIds(data.gaps, 'GAP');
  const decisions = uniqueIds(data.decisions, 'DEC');
  requireValue(
    Array.isArray(data.runs) && Array.isArray(data.revisions),
    'runs/revisions は配列で指定してください',
  );

  validateSources(data);
  validateGaps(data, criteria, decisions);
  validateDecisions(data, criteria, decisions);
  validateCriteria(data, sources, gaps, decisions);
  validateRuns(data, criteria);
  validateWorkflows(data, criteria);
  return data;
}
