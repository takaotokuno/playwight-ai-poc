import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import YAML from 'yaml';
import ExcelJS from 'exceljs';
import ts from 'typescript';
import 'dotenv/config';
import { validateData } from './ledger-validation.mjs';
import { mergePlan, renderCriterionPlan } from './test-plan.mjs';

export { validateData };

export const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const requireValue = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const now = () => new Date().toISOString();
export function hasTestTitle(text, id) {
  const source = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test'
    ) {
      const first = node.arguments[0];
      if (
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        new RegExp(`${id}(?![0-9])`).test(first.text)
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}
export function local(root, relative) {
  requireValue(
    nonempty(relative) && !path.isAbsolute(relative),
    'リポジトリ相対パスを指定してください',
  );
  const resolved = path.resolve(root, relative);
  requireValue(
    resolved.startsWith(path.resolve(root) + path.sep),
    'リポジトリ外のパスは使用できません',
  );
  return resolved;
}
export async function readLedger(file) {
  const text = await fs.readFile(file, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  requireValue(match, `${file}: YAML front matter がありません`);
  return { data: YAML.parse(match[1]), body: text.slice(match[0].length) };
}
export async function writeLedger(file, data, body = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write via a sibling file so interruption does not truncate the ledger.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `---\n${YAML.stringify(data)}---\n${body}`, 'utf8');
  await fs.rename(temporary, file);
}
export async function ledgers(root) {
  const dir = path.join(root, 'migration/features');
  const entries = await fs.readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  return Promise.all(
    entries
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map(async (name) => ({
        file: path.join(dir, name),
        ...(await readLedger(path.join(dir, name))),
      })),
  );
}
export async function feature(root, id) {
  const matches = (await ledgers(root)).filter((item) => item.data.id === id);
  requireValue(matches.length === 1, `機能 ${id} は一意に特定できません`);
  return matches[0];
}

export async function ingest(root, relative) {
  const file = local(root, relative);
  const bytes = await fs.readFile(file);
  const revision = hash(bytes);
  const records = [];
  if (path.extname(file).toLowerCase() === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (cell.isMerged && cell.master.address !== cell.address) {
            return;
          }
          const formula = cell.formula;
          records.push({
            location: `${sheet.name}!${cell.address}`,
            text: cell.text,
            ...(formula ? { formula, unread: cell.result === undefined } : {}),
          });
        }),
      ),
    );
  } else {
    requireValue(
      ['.md', '.txt', '.csv', '.tsv'].includes(path.extname(file).toLowerCase()),
      '対応形式: .xlsx / .md / .txt / .csv / .tsv',
    );
    bytes
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .forEach((text, i) => records.push({ location: `L${i + 1}`, text }));
  }
  const snapshot = { version: 1, file: relative.replaceAll('\\', '/'), revision, records };
  const target = `migration/sources/${revision}.yaml`;
  await fs.mkdir(path.dirname(local(root, target)), { recursive: true });
  const previous = await fs.readFile(local(root, target), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  // Same bytes at a different path are separate provenance records.
  if (previous && YAML.parse(previous).file !== snapshot.file) {
    const alternate = `migration/sources/${revision}-${hash(snapshot.file).slice(0, 12)}.yaml`;
    await fs.writeFile(local(root, alternate), YAML.stringify(snapshot));
    return { ...snapshot, snapshot: alternate };
  }
  if (!previous) {
    await fs.writeFile(local(root, target), YAML.stringify(snapshot));
  }
  return { ...snapshot, snapshot: target };
}
export async function validate(root, data, { artifacts = true, freshness = true } = {}) {
  validateData(data);
  for (const source of data.sources) {
    const snapshot = YAML.parse(await fs.readFile(local(root, source.snapshot), 'utf8'));
    requireValue(
      snapshot.revision === source.revision && snapshot.file === source.file,
      `${source.id}: snapshot の出典が一致しません`,
    );
    if (freshness) {
      requireValue(
        hash(await fs.readFile(local(root, source.file))) === source.revision,
        `${source.id}: 仕様書が改訂されています。revise を実行してください`,
      );
    }
    for (const ac of data.criteria.filter((ac) => ac.source === source.id)) {
      const record = snapshot.records.find((record) => record.location === ac.location);
      requireValue(
        record && !record.unread && record.text.includes(ac.original),
        `${ac.id}: 原文・出典位置が snapshot と一致しません`,
      );
    }
  }
  if (artifacts) {
    for (const ac of data.criteria) {
      if (ac.plan) {
        const text = await fs.readFile(local(root, ac.plan), 'utf8');
        requireValue(text.includes(`${data.id}/${ac.id}`), `${ac.id}: 計画に ID がありません`);
      }
      for (const test of ac.tests) {
        const text = await fs.readFile(local(root, test), 'utf8');
        requireValue(
          hasTestTitle(text, `${data.id}/${ac.id}`),
          `${ac.id}: テストタイトルに ID がありません`,
        );
      }
    }
  }
}
export async function create(root, slug, proposal) {
  requireValue(/^[a-z][a-z0-9-]*$/.test(slug), 'slug は英小文字とハイフンで指定してください');
  validateData(proposal);
  requireValue(
    !(await ledgers(root)).some((item) => item.data.id === proposal.id),
    '機能 ID が重複しています',
  );
  requireValue(
    proposal.runs.length === 0 && proposal.revisions.length === 0,
    '新規台帳に実行・改訂履歴を持ち込めません',
  );
  await validate(root, proposal);
  const file = local(root, `migration/features/${slug}.md`);
  requireValue(!(await fs.stat(file).catch(() => null)), '既存台帳は上書きできません');
  await writeLedger(
    file,
    proposal,
    `\n# ${proposal.title}\n\n原文・ギャップ・判断・対応先は front matter に保存します。補足や観測メモはここに追記できます。\n`,
  );
  return file;
}
export async function decide(root, id, acId, input) {
  const item = await feature(root, id);
  await validate(root, item.data);
  const ac = item.data.criteria.find((ac) => ac.id === acId);
  requireValue(ac, 'AC がありません');
  const next = `DEC-${String(Math.max(0, ...item.data.decisions.map((d) => Number(d.id.slice(4)))) + 1).padStart(3, '0')}`;
  const decision = {
    id: next,
    ac: acId,
    question: input.question,
    answer: input.answer,
    author: input.author || 'このチャットの利用者（氏名・役割未確認）',
    at: now(),
    basis: input.basis || 'business',
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.observation ? { observation: input.observation } : {}),
    ...(ac.decisions.length ? { supersedes: ac.decisions.at(-1) } : {}),
  };
  decision.specification = Object.fromEntries(
    ['preconditions', 'inputs', 'steps', 'expected'].map((key) => [key, input[key]]),
  );
  item.data.decisions.push(decision);
  ac.decisions.push(next);
  for (const name of ['preconditions', 'inputs', 'steps', 'expected']) {
    ac[name] = input[name];
  }
  for (const gapId of input.resolves || []) {
    const gap = item.data.gaps.find((g) => g.id === gapId && g.ac === acId);
    requireValue(gap, '解決対象 GAP がありません');
    gap.status = 'resolved';
    gap.decision = next;
  }
  ac.specification = 'confirmed';
  delete ac.confirmation;
  // Old code can remain for review, but must be rechecked against the new decision.
  if (ac.tests.length) {
    ac.automation = 'blocked';
    ac.blockedReason = '仕様判断の更新。既存計画・テストの再確認が必要';
  }
  await validate(root, item.data);
  await writeLedger(item.file, item.data, item.body);
  return decision;
}
export async function plan(root, id, ids, options = {}) {
  const item = await feature(root, id);
  await validate(root, item.data);
  const selected = ids?.length
    ? item.data.criteria.filter((ac) => ids.includes(ac.id))
    : item.data.criteria.filter((ac) => ac.specification === 'confirmed');
  requireValue(
    selected.length && (!ids?.length || selected.length === ids.length),
    '対象 AC がありません',
  );
  requireValue(
    selected.every((ac) => ac.specification === 'confirmed'),
    '未確定 AC は計画に含められません',
  );
  const slug = path.basename(item.file, '.md');
  const target = `specs/${slug}.md`;
  let previous = null;
  try {
    previous = await fs.readFile(local(root, target), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let content;
  if (previous !== null) {
    const merged = mergePlan(previous, id, selected);
    if (merged.differences.length) {
      const proposal = `migration/.agent-tmp/plan-update-${id}.json`;
      await fs.mkdir(path.dirname(local(root, proposal)), { recursive: true });
      await fs.writeFile(
        local(root, proposal),
        JSON.stringify(
          {
            plan: target,
            differences: merged.differences,
            proposedSections: selected.map((ac) => renderCriterionPlan(id, ac)),
          },
          null,
          2,
        ) + '\n',
      );
      throw new Error(
        `既存計画と採用済み条件が不一致です。原本は保持しました。${proposal} を確認し、親がメモを保持して計画を更新してください`,
      );
    }
    content = merged.content;
  } else {
    content = `# ${item.data.title}\n\nSeed: ${options.seed || 'tests/seed.spec.ts'}\nConfig: ${options.config || 'playwright.config.ts'}\n台帳: migration/features/${slug}.md\n\n${selected.map((ac) => renderCriterionPlan(id, ac)).join('\n\n')}\n`;
  }
  await fs.mkdir(path.dirname(local(root, target)), { recursive: true });
  if (content !== previous) await fs.writeFile(local(root, target), content);
  selected.forEach((ac) => {
    ac.plan = target;
  });
  await writeLedger(item.file, item.data, item.body);
  return target;
}
export async function link(root, id, acId, test) {
  const item = await feature(root, id);
  await validate(root, item.data);
  const ac = item.data.criteria.find((ac) => ac.id === acId);
  requireValue(ac?.specification === 'confirmed' && ac.plan, '確定済み AC と計画が必要です');
  requireValue(
    test.startsWith('tests/') && /\.spec\.(ts|js|mjs)$/.test(test),
    'tests/ 内の spec を指定してください',
  );
  const text = await fs.readFile(local(root, test), 'utf8');
  requireValue(
    !/\btest\.(skip|fixme)\s*\(/.test(text),
    'skip/fixme を含むテストは自動対応済みにできません',
  );
  requireValue(hasTestTitle(text, `${id}/${acId}`), 'テストタイトルに F/AC ID を含めてください');
  ac.tests = [...new Set([...ac.tests, test])];
  ac.automation = 'implemented';
  delete ac.blockedReason;
  await validate(root, item.data);
  await writeLedger(item.file, item.data, item.body);
}
export async function revise(root, id, sourceId, relative) {
  const item = await feature(root, id);
  await validate(root, item.data, { freshness: false });
  const source = item.data.sources.find((source) => source.id === sourceId);
  requireValue(source, 'SRC がありません');
  const next = await ingest(root, relative);
  const old = YAML.parse(await fs.readFile(local(root, source.snapshot), 'utf8'));
  if (next.revision === source.revision && next.file === source.file) {
    return { changed: [] };
  }
  const changed = item.data.criteria.filter((ac) => ac.source === sourceId).map((ac) => ac.id);
  item.data.revisions.push({
    at: now(),
    source: sourceId,
    previous: { ...source },
    next: { file: next.file, revision: next.revision, snapshot: next.snapshot },
    affected: changed,
  });
  Object.assign(source, { file: next.file, revision: next.revision, snapshot: next.snapshot });
  for (const ac of item.data.criteria.filter((ac) => changed.includes(ac.id))) {
    ac.specification = 'unresolved';
    delete ac.confirmation;
    ac.automation = 'blocked';
    ac.blockedReason = '出典改訂。原文位置・検証条件・判断・既存テストの再確認が必要';
  }
  // Preserve old quotations for review; validate rejects them until an agent reconciles the new source.
  await writeLedger(item.file, item.data, item.body);
  const locations = new Set([...old.records, ...next.records].map((r) => r.location));
  return {
    changed,
    differences: [...locations].filter(
      (location) =>
        old.records.find((r) => r.location === location)?.text !==
        next.records.find((r) => r.location === location)?.text,
    ),
  };
}
export function gitState(root) {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      dirty: Boolean(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
      ),
    };
  } catch {
    return { commit: null, dirty: null };
  }
}
export async function run(root, id, ids, { config } = {}) {
  const item = await feature(root, id);
  await validate(root, item.data);
  const selected = item.data.criteria.filter((ac) =>
    ids ? ids.includes(ac.id) : ac.automation === 'implemented',
  );
  requireValue(selected.length && (!ids || selected.length === ids.length), '実行対象がありません');
  requireValue(
    selected.every(
      (ac) =>
        ac.specification === 'confirmed' && ac.automation === 'implemented' && ac.tests.length,
    ),
    '確定・実装済み AC のみ実行できます',
  );
  const files = [...new Set(selected.flatMap((ac) => ac.tests))];
  const grep = selected.map((ac) => `${id}/${ac.id}(?![0-9])`).join('|');
  const cli = local(root, 'node_modules/@playwright/test/cli.js');
  const args = [
    cli,
    'test',
    ...files,
    '--grep',
    grep,
    '--reporter=json',
    ...(config ? ['--config', config] : []),
  ];
  const at = now();
  const state = gitState(root);
  let stdout = '',
    stderr = '';
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, shell: false });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = null;
  }
  const specs = [];
  function collect(suite) {
    specs.push(...(suite.specs || []));
    (suite.suites || []).forEach(collect);
  }
  (report?.suites || []).forEach(collect);
  const results = selected.map((ac) => {
    const matched = specs.filter((spec) => new RegExp(`${id}/${ac.id}(?![0-9])`).test(spec.title));
    const tests = matched.flatMap((spec) => spec.tests);
    const status =
      tests.length &&
      tests.every(
        (test) =>
          test.status === 'expected' &&
          test.results.length &&
          test.results.every((r) => r.status === 'passed'),
      )
        ? 'passed'
        : tests.length
          ? 'failed'
          : 'not_run';
    return { ac: ac.id, status, classification: status === 'passed' ? null : 'unclassified' };
  });
  const environment = config
    ? `config:${config}`
    : process.env.BASE_URL
      ? new URL(process.env.BASE_URL).origin
      : '未設定';
  const record = {
    id: crypto.randomUUID(),
    at,
    ...state,
    environment,
    command: `node ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    exitCode,
    results,
    report: report
      ? {
          expected: report.stats?.expected,
          unexpected: report.stats?.unexpected,
          skipped: report.stats?.skipped,
          flaky: report.stats?.flaky,
          artifacts: 'test-results/',
        }
      : null,
    diagnostic: report
      ? `runner errors: ${(report.errors || []).length}`
      : 'JSON レポートを取得できませんでした。ローカルの実行結果を確認してください。',
  };
  // Do not persist raw browser reports: they can contain credentials and personal data.
  item.data.runs.push(record);
  await writeLedger(item.file, item.data, item.body);
  return record;
}
export async function context(root, id) {
  const item = await feature(root, id);
  const inventory = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|js|mjs|md)$/.test(entry.name)) {
        inventory.push(path.relative(root, full).replaceAll('\\', '/'));
      }
    }
  }
  await walk(path.join(root, 'tests'));
  await walk(path.join(root, 'specs'));
  return {
    ledger: path.relative(root, item.file).replaceAll('\\', '/'),
    ...item.data,
    inventory,
    git: gitState(root),
  };
}
function formatCriterionSummary(featureId, criterion) {
  const tests = criterion.tests.join(', ') || 'なし';
  const decisions = criterion.decisions.join(', ') || 'なし';
  return `- ${featureId}/${criterion.id}: ${criterion.specification} / ${criterion.automation}; tests: ${tests}; decisions: ${decisions}`;
}

function formatRunSummary(record) {
  const results = record.results
    .map((result) => `${result.ac}: ${result.status} (${result.classification || '成功'})`)
    .join(', ');
  return `- ${record.at} commit=${record.commit} dirty=${record.dirty}: ${record.command}\n  ${results}`;
}

export async function prBody(root, id) {
  const { data } = await feature(root, id);
  await validate(root, data);
  const criteria = data.criteria
    .map((criterion) => formatCriterionSummary(id, criterion))
    .join('\n');
  const verification = data.runs.length ? data.runs.map(formatRunSummary).join('\n') : '未実行';
  const openGaps =
    data.gaps
      .filter((gap) => gap.status === 'open')
      .map((gap) => `- ${gap.id} (${gap.ac}): ${gap.question}`)
      .join('\n') || '未解決 GAP なし';
  const excludedCriteria = data.criteria
    .filter((criterion) => criterion.automation !== 'implemented')
    .map(
      (criterion) =>
        `- 対象外 ${criterion.id}: ${criterion.blockedReason || criterion.specification}`,
    )
    .join('\n');

  return (
    [
      `## ${data.title} (${id})`,
      criteria,
      '## 検証',
      verification,
      '## 未解決・対象外',
      openGaps,
      excludedCriteria,
      '## 再利用と変更後の挙動',
      '<!-- エージェントが差分に基づいて具体的に記入する -->',
    ].join('\n\n') + '\n'
  );
}
