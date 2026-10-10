export const providers = ['codex', 'claude', 'vscode'];
export const transports = ['native', 'cli'];

const cliProviders = ['codex', 'claude'];
const optionProperties = {
  '--provider': 'provider',
  '--transport': 'transport',
  '--config': 'config',
  '--seed': 'seed',
  '--max-heal': 'maxHealAttempts',
};

export function definitionPath(agent, provider = 'vscode') {
  if (!providers.includes(provider)) {
    throw new Error(`未対応の provider: ${provider}`);
  }
  if (provider === 'claude') {
    return `.claude/agents/${agent}.md`;
  }
  return `.github/agents/${agent}.agent.md`;
}

export function normalizeTools(tools) {
  let toolNames;
  if (Array.isArray(tools)) {
    toolNames = tools;
  } else if (typeof tools === 'string') {
    toolNames = tools
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (!toolNames || !toolNames.every((tool) => typeof tool === 'string')) {
    throw new Error('エージェント tools の形式が不正です');
  }
  const normalized = toolNames.map((tool) =>
    tool.replace(/^mcp__playwright-test__/, 'playwright-test/'),
  );
  return [...new Set(normalized)];
}

function validateParsedOptions(parsed, cli) {
  if (!parsed.id) {
    throw new Error('機能 ID を指定してください');
  }
  const allowedProviders = cli ? cliProviders : providers;
  if (parsed.provider && !allowedProviders.includes(parsed.provider)) {
    throw new Error('provider が不正です');
  }
  if (parsed.options.transport && !transports.includes(parsed.options.transport)) {
    throw new Error('transport は native または cli を指定してください');
  }
  if (cli && parsed.options.transport === 'native') {
    throw new Error('native 委譲は対話環境から workflow-start / workflow-accept を使ってください');
  }
}

export function parseAgentArgs(args, { cli = true } = {}) {
  const parsed = { ids: [], options: {}, provider: undefined };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--resume') {
      parsed.options.resume = true;
      continue;
    }

    const property = Object.hasOwn(optionProperties, argument)
      ? optionProperties[argument]
      : undefined;
    if (property) {
      const value = args[++index];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} の値が必要です`);
      }
      if (property === 'provider') {
        parsed.provider = value;
      } else {
        parsed.options[property] = property === 'maxHealAttempts' ? Number(value) : value;
      }
      continue;
    }
    if (/^F-\d{3,}$/.test(argument) && !parsed.id) {
      parsed.id = argument;
      continue;
    }
    if (/^AC-\d{3,}$/.test(argument)) {
      parsed.ids.push(argument);
      continue;
    }
    throw new Error(`未知の引数: ${argument}`);
  }

  validateParsedOptions(parsed, cli);
  return parsed;
}
