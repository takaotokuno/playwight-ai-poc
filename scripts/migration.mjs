#!/usr/bin/env node
import fs from 'node:fs/promises';
import {
  ingest,
  create,
  decide,
  plan,
  link,
  revise,
  run,
  context,
  prBody,
  feature,
  ledgers,
  validate,
  writeLedger,
  local,
} from '../lib/migration.mjs';
import {
  startWorkflow,
  workflowTask,
  acceptWorkflowResult,
  verifyWorkflow,
  stopWorkflow,
} from '../lib/agent-workflow.mjs';
import { parseAgentArgs } from '../lib/agent-providers.mjs';

const root = process.cwd();
const [command, ...args] = process.argv.slice(2);
const json = async (file) => JSON.parse(await fs.readFile(local(root, file), 'utf8'));
const output = (value) =>
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
try {
  switch (command) {
    case 'workflow-start': {
      const { id, ids, options, provider } = parseAgentArgs(args, { cli: false });
      if (!provider)
        throw new Error('workflow-start は --provider codex|claude|vscode を指定してください');
      output(await startWorkflow(root, id, ids, { ...options, provider }));
      break;
    }
    case 'workflow-task':
      output(await workflowTask(root, args[0]));
      break;
    case 'workflow-accept':
      output(
        await acceptWorkflowResult(
          root,
          args[0],
          await json(args[1]),
          args[2] ? await json(args[2]) : undefined,
        ),
      );
      break;
    case 'workflow-verify': {
      const result = await verifyWorkflow(root, args[0]);
      output(result);
      if (result.state === 'blocked') {
        process.exitCode = 1;
      }
      break;
    }
    case 'workflow-stop':
      output(await stopWorkflow(root, args[0], args.slice(1).join(' ')));
      break;
    case 'ingest':
      output(await ingest(root, args[0]));
      break;
    case 'create':
      output(await create(root, args[0], await json(args[1])));
      break;
    case 'decide':
      output(await decide(root, args[0], args[1], await json(args[2])));
      break;
    case 'plan':
      output(await plan(root, args[0], args.slice(1)));
      break;
    case 'link':
      await link(root, ...args);
      output('対応づけを保存しました');
      break;
    case 'revise':
      output(await revise(root, ...args));
      break;
    case 'run': {
      const configIndex = args.indexOf('--config');
      const config = configIndex >= 0 ? args[configIndex + 1] : undefined;
      if (configIndex >= 0 && !config) {
        throw new Error('--config の値が必要です');
      }
      const ids = args.slice(1, configIndex >= 0 ? configIndex : undefined);
      const record = await run(root, args[0], ids.length ? ids : undefined, { config });
      output(record);
      if (record.exitCode || record.results.some((r) => r.status !== 'passed')) {
        process.exitCode = 1;
      }
      break;
    }
    case 'context':
      output(await context(root, args[0]));
      break;
    case 'questions': {
      const { data } = await feature(root, args[0]);
      output(
        data.gaps
          .filter((g) => g.status === 'open')
          .map((g) => ({ id: `${data.id}/${g.id}`, ac: g.ac, question: g.question })),
      );
      break;
    }
    case 'validate': {
      const items = args[0] ? [await feature(root, args[0])] : await ledgers(root);
      if (new Set(items.map((i) => i.data.id)).size !== items.length) {
        throw new Error('機能 ID が重複しています');
      }
      for (const item of items) {
        await validate(root, item.data);
      }
      output(`${items.length} 台帳の整合性を確認しました`);
      break;
    }
    case 'status': {
      const items = await ledgers(root);
      output(
        items.map(({ data }) => ({
          id: data.id,
          title: data.title,
          total: data.criteria.length,
          confirmed: data.criteria.filter((ac) => ac.specification === 'confirmed').length,
          implemented: data.criteria.filter((ac) => ac.automation === 'implemented').length,
          gaps: data.gaps.filter((g) => g.status === 'open').length,
          latestRun: data.runs.at(-1) || null,
        })),
      );
      break;
    }
    case 'pr-body':
      output(await prBody(root, args[0]));
      break;
    case 'attach-pr': {
      const item = await feature(root, args[0]);
      if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+$/.test(args[1] || '')) {
        throw new Error('実在する PR の URL を指定してください');
      }
      const ids = args.slice(2);
      const selected = item.data.criteria.filter((ac) => ids.includes(ac.id));
      if (!ids.length || selected.length !== ids.length) {
        throw new Error('PR に含めた AC を指定してください');
      }
      selected.forEach((ac) => {
        ac.prs = [...new Set([...ac.prs, args[1]])];
      });
      await validate(root, item.data);
      await writeLedger(item.file, item.data, item.body);
      output('PR 参照を保存しました（マージ状況は変更しません）');
      break;
    }
    case 'classify': {
      const item = await feature(root, args[0]);
      const input = await json(args[2]);
      const record = item.data.runs.find((r) => r.id === args[1]);
      const result = record?.results.find((r) => r.ac === input.ac);
      if (!result || result.status === 'passed') {
        throw new Error('対象の失敗・未実行記録がありません');
      }
      if (
        !['test', 'environment', 'application', 'specification', 'unclassified'].includes(
          input.classification,
        ) ||
        !input.reason?.trim()
      ) {
        throw new Error('classification と reason が必要です');
      }
      Object.assign(result, {
        classification: input.classification,
        reason: input.reason,
        classifiedAt: new Date().toISOString(),
      });
      await validate(root, item.data);
      await writeLedger(item.file, item.data, item.body);
      output(result);
      break;
    }
    default:
      output(
        [
          'Usage: npm run migration -- <command>',
          '',
          '  ingest <requirements/file.xlsx|md|txt|csv|tsv>',
          '  create <slug> <proposal.json>',
          '  questions <F-ID>',
          '  decide <F-ID> <AC-ID> <decision.json>',
          '  plan <F-ID> [AC-ID ...]',
          '  link <F-ID> <AC-ID> <tests/file.spec.ts>',
          '  run <F-ID> [AC-ID ...] [--config playwright.demo.config.ts]',
          '  classify <F-ID> <run-UUID> <classification.json>',
          '  context <F-ID>',
          '  revise <F-ID> <SRC-ID> <requirements/revision.xlsx>',
          '  validate [F-ID]',
          '  status',
          '  pr-body <F-ID>',
          '  attach-pr <F-ID> <PR-URL> <AC-ID ...>',
          '  workflow-start <F-ID> [AC-ID ...] --provider codex|claude|vscode [--transport native|cli] [--config file] [--seed file]',
          '  workflow-task <F-ID>',
          '  workflow-accept <F-ID> <worker-result.json> <delegation.json>  (native)',
          '  workflow-verify <F-ID>',
          '  workflow-stop <F-ID> <reason>',
        ].join('\n'),
      );
      if (command) {
        process.exitCode = 1;
      }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
