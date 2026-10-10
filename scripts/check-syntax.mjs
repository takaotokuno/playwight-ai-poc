import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function checkDirectory(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (entry.name.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  }
}
for (const directory of ['lib', 'scripts', 'demo']) await checkDirectory(directory);
console.log('lib / scripts / demo の JavaScript 構文を確認しました（型チェックとは別）。');
