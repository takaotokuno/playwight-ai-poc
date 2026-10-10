import { orchestrate } from '../lib/agent-workflow.mjs';
import { dispatchCodex } from '../lib/codex-agent-runner.mjs';
import { dispatchClaude } from '../lib/claude-agent-runner.mjs';
import { parseAgentArgs } from '../lib/agent-providers.mjs';
import { feature } from '../lib/migration.mjs';

const dispatchers = { codex: dispatchCodex, claude: dispatchClaude };
const usage =
  'Usage: npm run agents:run -- F-001 [AC-001 ...] [--provider codex|claude] [--config file] [--seed file] [--max-heal 1] [--resume]';

function selectProvider(requestedProvider, previousWorkflow) {
  if (requestedProvider) {
    return requestedProvider;
  }
  if (previousWorkflow) {
    return previousWorkflow.provider || 'codex';
  }
  return process.env.AGENT_PROVIDER || 'codex';
}

async function main() {
  const root = process.cwd();
  const { id, ids, options, provider: requestedProvider } = parseAgentArgs(process.argv.slice(2));
  let previousWorkflow = null;
  if (options.resume) {
    const ledger = await feature(root, id);
    previousWorkflow = ledger.data.agentWorkflows?.at(-1);
  }
  const provider = selectProvider(requestedProvider, previousWorkflow);
  if (!['codex', 'claude'].includes(provider)) {
    throw new Error('CLI provider は codex または claude を指定してください');
  }

  options.provider = provider;
  options.transport = 'cli';
  options.onProgress = ({ agent, taskId }) => {
    console.error(`Delegating via ${provider} to ${agent}: ${taskId}`);
  };
  const dispatch = dispatchers[provider];
  const result = await orchestrate(root, id, ids, (task) => dispatch(root, task), options);
  console.log(JSON.stringify({ provider, ...result }, null, 2));
  if (result.state !== 'complete') {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
