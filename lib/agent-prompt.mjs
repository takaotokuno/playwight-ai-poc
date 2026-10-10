import { agentResultSchema } from './agent-contract.mjs';

function workerInstructions(featureId, acceptanceIds, workflow) {
  const scope = acceptanceIds.map((id) => `${featureId}/${id}`).join(', ');

  return `You are running as ${workflow.pending.agent}.
Execute the official definition below using Playwright Test MCP tools,
then return ONLY the JSON result matching the schema.
Do not simulate a tool call or claim an unavailable browser was inspected.

Project rules take precedence over the official examples. Work only on ${scope}.
Preserve adopted business expectations verbatim.
The coordinator owns the ledger, link/run records, git and PR operations:
DO NOT edit migration/, requirements/, AGENTS.md, configuration, or commit/push/create a PR.

Planner: inspect the running application with planner_setup_page using the given seed;
refine only the specified plan file, retaining the exact adopted preconditions,
inputs, steps and expected lines. Preserve existing plan lines and notes and append refinements.
Do not modify tests.

Generator: use generator_setup_page and verify operations/locators live.
Reuse existing helpers/fixtures. Write tests or reuse verified existing ones;
return one or more artifact paths for EVERY requested AC. Test titles must include F/AC IDs.

Healer: inspect the failing tests with test_debug. Classify EVERY requested AC.
Preserve every existing matcher, expected argument and negation;
never add skip/fixme/only/fail.
Repair only implementation errors while retaining verification meaning.
For application/environment/specification blockers, return blocked with reasons;
for business questions return questions to the coordinator (you cannot ask the user directly).

Return status blocked if required tools, environment or business facts are missing.
Do not manufacture an answer. Do not invoke other agents.
Do not run the migration CLI yourself.
Ensure the Playwright browser/session is closed before returning
so that the coordinator can run verification.

Task ID: ${workflow.pending.taskId}
Workflow ID: ${workflow.id}
Plan: ${workflow.plan}
Seed: ${workflow.seed}
Config: ${workflow.config || 'playwright.config.ts'}
`;
}

export function buildWorkerPrompt({
  featureId,
  acceptanceIds,
  workflow,
  projectRules,
  definition,
  context,
}) {
  const instructions = workerInstructions(featureId, acceptanceIds, workflow);
  const contextInstructions = `All required rules, specifications, configuration and existing test assets are embedded below.
Do not run shell commands just to read them.
Use the Playwright MCP tools to inspect the app and write the artifact.
Classify questions as specification or environment;
an environment question must not invalidate confirmed business expectations.`;

  return [
    instructions,
    contextInstructions,
    '## Required project rules',
    projectRules,
    '## Official role definition',
    definition,
    '## Confirmed scope and context',
    JSON.stringify(context, null, 2),
    '## Result schema',
    JSON.stringify(agentResultSchema),
  ].join('\n');
}
