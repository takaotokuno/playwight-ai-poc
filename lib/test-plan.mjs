const fields = [
  ['前提条件', 'preconditions'],
  ['入力', 'inputs'],
  ['操作', 'steps'],
  ['期待結果', 'expected'],
];

export function renderCriterionPlan(featureId, criterion) {
  const conditions = fields
    .map(([label, field]) =>
      [`### ${label}`, '', criterion[field].map((value) => `- ${value}`).join('\n')].join('\n'),
    )
    .join('\n\n');
  return [
    `## ${featureId}/${criterion.id}`,
    '',
    `出典: ${criterion.source} ${criterion.location}`,
    `判断: ${criterion.decisions.join(', ') || '原文から確定'}`,
    '',
    conditions,
  ].join('\n');
}

function criterionSection(content, featureId, acceptanceId) {
  const headings = [...content.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  const index = headings.findIndex((match) => match[1].trim() === `${featureId}/${acceptanceId}`);
  if (index < 0) return null;
  return content.slice(headings[index].index, headings[index + 1]?.index ?? content.length);
}

function conditionValues(section, label) {
  const headings = [...section.matchAll(/^### ([^\r\n]+)\r?$/gm)];
  const index = headings.findIndex((match) => match[1].trim() === label);
  if (index < 0) return null;
  const body = section.slice(
    headings[index].index + headings[index][0].length,
    headings[index + 1]?.index ?? section.length,
  );
  return [...body.matchAll(/^- ([^\r\n]*)\r?$/gm)].map((match) => match[1]);
}

export function mergePlan(content, featureId, criteria) {
  const additions = [];
  const differences = [];
  for (const criterion of criteria) {
    const section = criterionSection(content, featureId, criterion.id);
    if (section === null) {
      // An ID mentioned in another format must not lead to a duplicate section.
      if (content.includes(`${featureId}/${criterion.id}`)) {
        differences.push({
          ac: criterion.id,
          field: 'format',
          planned: null,
          adopted: '## F-ID/AC-ID と ### 条件見出し',
        });
      } else {
        additions.push(renderCriterionPlan(featureId, criterion));
      }
      continue;
    }
    const plannedSource = section.match(/^出典: ([^\r\n]+)\r?$/m)?.[1];
    const adoptedSource = `${criterion.source} ${criterion.location}`;
    if (plannedSource !== adoptedSource) {
      differences.push({
        ac: criterion.id,
        field: 'source',
        planned: plannedSource ?? null,
        adopted: adoptedSource,
      });
    }
    const plannedDecisions = section.match(/^判断: ([^\r\n]+)\r?$/m)?.[1];
    const adoptedDecisions = criterion.decisions.join(', ') || '原文から確定';
    if (plannedDecisions !== adoptedDecisions) {
      differences.push({
        ac: criterion.id,
        field: 'decisions',
        planned: plannedDecisions ?? null,
        adopted: adoptedDecisions,
      });
    }
    for (const [label, field] of fields) {
      const planned = conditionValues(section, label);
      if (JSON.stringify(planned) !== JSON.stringify(criterion[field])) {
        differences.push({ ac: criterion.id, field, planned, adopted: criterion[field] });
      }
    }
  }
  if (differences.length) return { content, differences };
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  return {
    content: additions.length ? content + separator + additions.join('\n\n') + '\n' : content,
    differences,
  };
}
