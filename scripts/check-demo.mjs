import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { prepareDemo } from '../lib/demo.mjs';
import { run, validate, feature } from '../lib/migration.mjs';

const projectRoot = process.cwd();
const temporaryParent = path.resolve(projectRoot, 'migration/.agent-tmp');
await fs.mkdir(temporaryParent, { recursive: true });
const root = await fs.mkdtemp(path.join(temporaryParent, 'demo-check-'));
try {
  for (const file of [
    'requirements/demo-customer.md',
    'examples/decision.json',
    'tests/demo/customer-search.spec.ts',
    'tests/demo/seed.spec.ts',
    'tests/fixtures/index.ts',
    'tests/helpers/customer-search.ts',
    'demo/server.mjs',
  ]) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(projectRoot, file), target);
  }
  // Only the three Playwright packages are needed by the isolated TS tests/config.
  for (const dependency of ['@playwright/test', 'playwright', 'playwright-core']) {
    await fs.cp(
      path.join(projectRoot, 'node_modules', dependency),
      path.join(root, 'node_modules', dependency),
      { recursive: true },
    );
  }
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const serverFile = path.join(root, 'demo/server.mjs');
  await fs.writeFile(
    serverFile,
    (await fs.readFile(serverFile, 'utf8')).replaceAll('4173', String(port)),
  );
  await fs.writeFile(
    path.join(root, 'playwright.demo.config.ts'),
    `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/demo', retries: 0, workers: 1,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://127.0.0.1:${port}' },
  webServer: { command: 'node demo/server.mjs', url: 'http://127.0.0.1:${port}', env: { DEMO_PORT: '${port}' }, reuseExistingServer: false },
});
`,
  );
  await prepareDemo(root);
  const record = await run(root, 'F-001', undefined, { config: 'playwright.demo.config.ts' });
  await validate(root, (await feature(root, 'F-001')).data);
  const passed =
    record.exitCode === 0 && record.results.every((result) => result.status === 'passed');
  console.log(
    `独立デモ: ${record.results.map((result) => `${result.ac}=${result.status}`).join(', ')}`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  // Delete only the directory created above, after checking its resolved parent.
  if (path.dirname(path.resolve(root)) !== temporaryParent)
    throw new Error('検証ディレクトリの範囲が不正です');
  await fs.rm(root, { recursive: true, force: true });
}
