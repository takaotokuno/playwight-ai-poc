import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ingest,
  create,
  decide,
  plan,
  link,
  revise,
  readLedger,
  feature,
  validate,
  local,
  run,
} from '../lib/migration.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'requirements'));
  await fs.writeFile(path.join(root, 'requirements/spec.md'), '検索結果が正しく表示される。\n');
  return root;
}
async function proposal(root) {
  const source = await ingest(root, 'requirements/spec.md');
  return {
    version: 1,
    id: 'F-001',
    title: '検索',
    sources: [
      { id: 'SRC-001', file: source.file, snapshot: source.snapshot, revision: source.revision },
    ],
    criteria: [
      {
        id: 'AC-001',
        source: 'SRC-001',
        location: 'L1',
        original: '検索結果が正しく表示される。',
        specification: 'unresolved',
        automation: 'not_started',
        gaps: ['GAP-001'],
        decisions: [],
        tests: [],
        prs: [],
      },
    ],
    gaps: [{ id: 'GAP-001', ac: 'AC-001', status: 'open', question: '並び順は？' }],
    decisions: [],
    runs: [],
    revisions: [],
  };
}
const answer = {
  question: '並び順は？',
  answer: '番号昇順',
  resolves: ['GAP-001'],
  preconditions: ['番号1と2が登録済み'],
  inputs: ['全件'],
  steps: ['検索'],
  expected: ['1、2の順で表示'],
};

test('出典を保存し、未確定条件を計画に含めず、回答から確定・対応づけまで進む', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await assert.rejects(plan(root, 'F-001', ['AC-001']), /未確定/);
  await decide(root, 'F-001', 'AC-001', answer);
  const target = await plan(root, 'F-001', ['AC-001']);
  assert.match(await fs.readFile(path.join(root, target), 'utf8'), /番号昇順|1、2/);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests/search.spec.ts'),
    "test('F-001/AC-001', async () => {});",
  );
  await link(root, 'F-001', 'AC-001', 'tests/search.spec.ts');
  const item = await feature(root, 'F-001');
  assert.equal(item.data.criteria[0].automation, 'implemented');
  assert.equal(item.data.decisions[0].author, 'このチャットの利用者（氏名・役割未確認）');
  assert.equal(item.data.runs.length, 0);
  await validate(root, item.data);
});

test('回答に不足があると既存台帳を変更しない', async (t) => {
  const root = await workspace(t);
  const file = await create(root, 'search', await proposal(root));
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(decide(root, 'F-001', 'AC-001', { ...answer, expected: [] }), /expected/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(decide(root, 'F-001', 'AC-001', { ...answer, resolves: [] }), /未解決/);
});

test('公開 CLI の plan で AC を省略でき、再実行でメモを失わない', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await decide(root, 'F-001', 'AC-001', answer);
  const cli = fileURLToPath(new URL('../scripts/migration.mjs', import.meta.url));
  execFileSync(process.execPath, [cli, 'plan', 'F-001'], { cwd: root });
  const file = path.join(root, 'specs/search.md');
  await fs.appendFile(file, '\n### 実装メモ\n\n既存 helper を再利用する。\n');
  const before = await fs.readFile(file, 'utf8');
  await plan(root, 'F-001', []);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('判断と計画が不一致なら原本を保持し、変更候補を提示する', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await decide(root, 'F-001', 'AC-001', answer);
  await plan(root, 'F-001');
  const file = path.join(root, 'specs/search.md');
  await fs.appendFile(file, '\n### 観測メモ\n\n観測は業務仕様とは区別する。\n');
  const before = await fs.readFile(file, 'utf8');
  await decide(root, 'F-001', 'AC-001', { ...answer, expected: ['2、1の順で表示'] });
  await assert.rejects(plan(root, 'F-001'), /不一致.*原本は保持/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const candidate = JSON.parse(
    await fs.readFile(path.join(root, 'migration/.agent-tmp/plan-update-F-001.json'), 'utf8'),
  );
  assert.deepEqual(candidate.differences.find((change) => change.field === 'expected').adopted, [
    '2、1の順で表示',
  ]);
});

test('出典の捏造、ID重複、上書き、リポジトリ外パスを拒否する', async (t) => {
  const root = await workspace(t);
  assert.throws(() => local(root, '../secret'), /リポジトリ外/);
  const data = await proposal(root);
  data.criteria[0].original = '捏造された仕様';
  await assert.rejects(create(root, 'search', data), /snapshot/);
  const valid = await proposal(root);
  await create(root, 'search', valid);
  await assert.rejects(create(root, 'other', valid), /重複/);
});

test('Excel の位置、結合セル、計算結果がない式を保存する', async (t) => {
  const root = await workspace(t);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('検索仕様');
  sheet.getCell('B12').value = '正しく表示';
  sheet.mergeCells('B12:C12');
  sheet.getCell('D12').value = { formula: '1+1' };
  await wb.xlsx.writeFile(path.join(root, 'requirements/spec.xlsx'));
  const source = await ingest(root, 'requirements/spec.xlsx');
  assert.deepEqual(
    source.records.map((r) => r.location),
    ['検索仕様!B12', '検索仕様!D12'],
  );
  assert.equal(source.records[1].unread, true);
});

test('仕様改訂で古い判断を保持し、出典に依存する条件を再確認に戻す', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await decide(root, 'F-001', 'AC-001', answer);
  await fs.writeFile(path.join(root, 'requirements/spec.md'), '検索結果は番号降順。\n');
  await assert.rejects(plan(root, 'F-001'), /改訂/);
  const result = await revise(root, 'F-001', 'SRC-001', 'requirements/spec.md');
  assert.deepEqual(result.changed, ['AC-001']);
  const { data } = await feature(root, 'F-001');
  assert.equal(data.criteria[0].specification, 'unresolved');
  assert.equal(data.criteria[0].automation, 'blocked');
  assert.equal(data.decisions.length, 1);
  assert.equal(data.revisions.length, 1);
});

test('skipを自動対応済みにせず、改訂された判断でコード再確認を要求する', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await decide(root, 'F-001', 'AC-001', answer);
  await plan(root, 'F-001');
  await fs.mkdir(path.join(root, 'tests'));
  const file = path.join(root, 'tests/search.spec.ts');
  await fs.writeFile(file, "test.skip('F-001/AC-001', async () => {});");
  await assert.rejects(link(root, 'F-001', 'AC-001', 'tests/search.spec.ts'), /skip/);
  await fs.writeFile(file, "// F-001/AC-001\ntest('別の検証', async () => {});");
  await assert.rejects(link(root, 'F-001', 'AC-001', 'tests/search.spec.ts'), /タイトル/);
  await fs.writeFile(file, "test('F-001/AC-001', async () => {});");
  await link(root, 'F-001', 'AC-001', 'tests/search.spec.ts');
  await decide(root, 'F-001', 'AC-001', { ...answer, answer: '番号降順', expected: ['2、1の順'] });
  const { data } = await feature(root, 'F-001');
  assert.equal(data.criteria[0].automation, 'blocked');
  assert.equal(data.decisions[1].supersedes, 'DEC-001');
});

test('現状基準の採用には環境と観測根拠を要求する', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await assert.rejects(
    decide(root, 'F-001', 'AC-001', { ...answer, basis: 'observed-baseline' }),
    /環境/,
  );
  await decide(root, 'F-001', 'AC-001', {
    ...answer,
    basis: 'observed-baseline',
    environment: 'staging',
    observation: '画面で1、2の順を確認',
  });
  assert.equal((await feature(root, 'F-001')).data.decisions[0].basis, 'observed-baseline');
});

test('runは未実行を成功にせず、仕様状態を変更しない', async (t) => {
  const root = await workspace(t);
  await create(root, 'search', await proposal(root));
  await decide(root, 'F-001', 'AC-001', answer);
  await plan(root, 'F-001');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(
    path.join(root, 'tests/search.spec.ts'),
    "test('F-001/AC-001', async () => {});",
  );
  await link(root, 'F-001', 'AC-001', 'tests/search.spec.ts');
  await fs.mkdir(path.join(root, 'node_modules/@playwright/test'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'node_modules/@playwright/test/cli.js'),
    'console.log(JSON.stringify({suites:[], stats:{}}));',
  );
  const record = await run(root, 'F-001');
  assert.equal(record.results[0].status, 'not_run');
  assert.equal(
    (await readLedger(path.join(root, 'migration/features/search.md'))).data.criteria[0]
      .specification,
    'confirmed',
  );
});
