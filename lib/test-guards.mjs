import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { hash, local } from './migration.mjs';
import { requireCondition } from './agent-contract.mjs';

export function assertions(code) {
  const source = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
  const signatures = [];
  const printer = ts.createPrinter({ removeComments: true });

  function visit(node) {
    const isMatcherCall =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^to[A-Z]/.test(node.expression.name.text);

    if (isMatcherCall) {
      const chain = node.expression.expression.getText(source);
      if (/\bexpect\s*\(/.test(chain)) {
        // Locator repairs may change the target expression, but not the assertion.
        signatures.push(
          JSON.stringify({
            matcher: node.expression.name.text,
            not: /\.not\b/.test(chain),
            args: node.arguments.map((argument) =>
              printer.printNode(ts.EmitHint.Unspecified, argument, source),
            ),
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return signatures.sort();
}

function testControls(code) {
  const controlCalls = /\b(?:test|describe)(?:\.describe)?\.(?:skip|fixme|only|fail)\s*\(/g;
  return (code.match(controlCalls) || []).sort();
}

async function readDirectory(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function captureTestGuards(root) {
  const guards = {};

  async function visitDirectory(directory) {
    for (const entry of await readDirectory(directory)) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(file);
        continue;
      }
      if (!/\.(ts|js|mjs)$/.test(entry.name)) {
        continue;
      }

      const code = await fs.readFile(file, 'utf8');
      const relativePath = path.relative(root, file).replaceAll('\\', '/');
      guards[relativePath] = {
        hash: hash(code),
        assertions: assertions(code),
        controls: testControls(code),
      };
    }
  }

  await visitDirectory(local(root, 'tests'));
  return guards;
}

function verifyExistingAssertions(file, before, after) {
  const remaining = [...after.assertions];
  for (const signature of before.assertions) {
    const index = remaining.indexOf(signature);
    requireCondition(index >= 0, `既存 assertion の削除・期待値変更を検出しました: ${file}`);
    remaining.splice(index, 1);
  }
  requireCondition(
    JSON.stringify(after.controls) === JSON.stringify(before.controls),
    `テストの除外・実行制御の変更を検出しました: ${file}`,
  );
}

export async function verifyTestGuards(root, workflow) {
  const currentGuards = await captureTestGuards(root);
  const originalGuards = workflow.pending.tests;
  const isPlanner = workflow.state === 'awaiting_planner';

  for (const [file, before] of Object.entries(originalGuards)) {
    const after = currentGuards[file];
    requireCondition(after, `既存テスト・helper が削除されています: ${file}`);
    if (isPlanner) {
      requireCondition(after.hash === before.hash, `Planner がテストを変更しました: ${file}`);
    } else {
      verifyExistingAssertions(file, before, after);
    }
  }

  for (const [file, guard] of Object.entries(currentGuards)) {
    if (!originalGuards[file]) {
      requireCondition(
        guard.controls.length === 0 && !isPlanner,
        `許可されないテスト追加です: ${file}`,
      );
    }
  }
  return currentGuards;
}
