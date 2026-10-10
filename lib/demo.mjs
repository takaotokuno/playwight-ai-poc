import fs from 'node:fs/promises';
import path from 'node:path';
import { ingest, create, decide, plan, link, ledgers } from './migration.mjs';

export async function prepareDemo(root) {
  const existing = (await ledgers(root)).find((item) => item.data.id === 'F-001');
  if (existing) {
    if (existing.data.title !== '顧客検索（デモ）') {
      throw new Error('F-001 は使用済みです。デモは新しい checkout で実行してください。');
    }
    console.log('デモ台帳は作成済みです。既存の判断・実行記録を保持します。');
  } else {
    const source = await ingest(root, 'requirements/demo-customer.md');
    const originals = [
      '顧客名で検索すると、検索結果が正しく表示される。',
      '該当する顧客がいない場合、該当なしのメッセージが表示される。',
    ];
    const data = {
      version: 1,
      id: 'F-001',
      title: '顧客検索（デモ）',
      sources: [
        { id: 'SRC-001', file: source.file, snapshot: source.snapshot, revision: source.revision },
      ],
      criteria: originals.map((original, i) => ({
        id: `AC-00${i + 1}`,
        source: 'SRC-001',
        original,
        location: source.records.find((r) => r.text === original).location,
        specification: 'unresolved',
        automation: 'not_started',
        gaps: [`GAP-00${i + 1}`],
        decisions: [],
        tests: [],
        prs: [],
      })),
      gaps: [
        { id: 'GAP-001', ac: 'AC-001', status: 'open', question: '照合方法・表示順・表示項目は？' },
        {
          id: 'GAP-002',
          ac: 'AC-002',
          status: 'open',
          question: '該当なしのメッセージ文言と一覧は？',
        },
      ],
      decisions: [],
      runs: [],
      revisions: [],
    };
    await create(root, 'demo-customer', data);
    const answer = JSON.parse(await fs.readFile(path.join(root, 'examples/decision.json'), 'utf8'));
    await decide(root, 'F-001', 'AC-001', {
      ...answer,
      author: 'デモ用の架空回答（実システムの仕様ではない）',
    });
    await decide(root, 'F-001', 'AC-002', {
      question: data.gaps[1].question,
      answer: '「該当する顧客はありません」と表示し、一覧は0件。',
      author: 'デモ用の架空回答（実システムの仕様ではない）',
      resolves: ['GAP-002'],
      preconditions: ['デモの登録データに検索名は存在しない'],
      inputs: ['存在しない顧客'],
      steps: ['顧客検索画面を開く', '顧客名を入力して検索する'],
      expected: ['一覧は0件', '該当する顧客はありませんと表示'],
    });
    await plan(root, 'F-001', undefined, {
      seed: 'tests/demo/seed.spec.ts',
      config: 'playwright.demo.config.ts',
    });
    await link(root, 'F-001', 'AC-001', 'tests/demo/customer-search.spec.ts');
    await link(root, 'F-001', 'AC-002', 'tests/demo/customer-search.spec.ts');
    console.log('デモ台帳・判断履歴・計画・テスト対応を作成しました。');
  }
}
