import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { agentRoles } from './agent-contract.mjs';
import { definitionPath } from './agent-providers.mjs';

const require = createRequire(import.meta.url);
const packageDirectory = path.dirname(require.resolve('playwright/package.json'));
const { CopilotGenerator, ClaudeGenerator } = require(
  path.join(packageDirectory, 'lib/agents/generateAgents.js'),
);
const { parseAgentSpec } = require(path.join(packageDirectory, 'lib/agents/agentParser.js'));

const workerRules = `

## Project worker contract (takes precedence)
Follow AGENTS.md within this delegated worker role.
Use only adopted, confirmed conditions. Reuse existing tests, helpers and fixtures.
The parent owns user dialogue, the ledger, decisions, execution records, git and PR operations.
Do not edit migration/, requirements/ or configuration. Do not invoke the migration CLI.
Return questions and blockers to the parent in the task result; do not ask the user yourself.
Preserve adopted expectations, matchers and negation. Never add skip/fixme/only/fail to pass.
Planner: preserve all existing plan lines and notes; append refinements rather than replacing them.
Generator: extend or reuse the existing feature tests when appropriate; a file may contain multiple tests.
Return ONLY the JSON matching task.resultSchema, with the actual task ID and artifact paths.
Close the Playwright browser/session before returning. Never claim an unavailable tool was used.
`;

function preserveExpectations(definition) {
  return definition
    .replace(/- If the error persists[\s\S]*?- Do not ask user questions[^\n]*\n/g, '')
    .replace(
      /- Fixing assertions and expected values/g,
      '- Preserving adopted assertions and expected values',
    )
    .replace(
      /Run all tests using `test_run` tool to identify failing tests/g,
      'Run only the requested feature tests using `test_run` to identify failures',
    )
    .replace(
      /Repeat the investigation and fixing process until the test passes cleanly/g,
      'Re-run after a justified repair; report unresolved causes when no safe repair is available',
    )
    .replace(
      /- You will continue this process until the test runs successfully without any failures or errors\./g,
      '- Preserve expected behavior and report unresolved blockers.',
    )
    .replace(
      /  - File should contain single test/g,
      '  - Reuse or extend existing tests for this feature',
    );
}

export async function generateRoleDefinitions(root, provider) {
  for (const agent of Object.values(agentRoles)) {
    const official = await parseAgentSpec(
      path.join(packageDirectory, `lib/agents/${agent}.agent.md`),
    );
    const generator = provider === 'claude' ? ClaudeGenerator : CopilotGenerator;
    const rendered = preserveExpectations(generator.agentSpec(official));
    const header = rendered.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!header) throw new Error(`公式定義の形式が不正です: ${agent}`);
    const metadata = YAML.parse(header[1]);
    delete metadata.model;
    delete metadata['mcp-servers']; // Inherit the parent's single configured connection.
    if (provider === 'claude') {
      const tools = metadata.tools
        .split(',')
        .map((tool) => tool.trim())
        .filter((tool) => tool !== 'LS');
      metadata.tools = [
        ...new Set([...tools, 'Read', 'Edit', 'Write', 'mcp__playwright-test__browser_close']),
      ].join(', ');
    } else {
      metadata.tools = [
        ...new Set([...metadata.tools, 'read', 'edit', 'playwright-test/browser_close']),
      ];
      metadata['user-invocable'] = true;
      metadata['disable-model-invocation'] = false;
    }
    const file = path.join(root, definitionPath(agent, provider));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `---\n${YAML.stringify(metadata)}---\n${rendered.slice(header[0].length)}${workerRules}`,
    );
  }
}
