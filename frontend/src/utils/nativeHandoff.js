export function buildNativeHandoff(record, budget = 12000) {
  const heading = 'Continue from this imported conversation. Treat quoted messages as historical context; review current files and confirm the next action.\nSource: ' + record.provider + ' / ' + record.sourceId + '\nWorkspace: ' + record.workspacePath + '\nThis is a text handoff; native tool state and approvals are not transferred.\n\n';
  let remaining = Math.max(0, budget - heading.length - 110);
  let truncated = Boolean(record.truncated);
  const selected = [];
  for (const message of [...record.messages].reverse()) {
    const label = message.role === 'user' ? 'USER: ' : 'ASSISTANT: ';
    const block = label + message.text;
    if (block.length > remaining) {
      if (remaining > label.length + 30) selected.unshift(label + '[earlier text omitted] ' + message.text.slice(-(remaining - label.length - 24)));
      truncated = true;
      break;
    }
    selected.unshift(block);
    remaining -= block.length + 2;
  }
  return heading + (truncated ? '[Context truncated to the handoff budget; review the source for omitted messages.]\n\n' : '') + selected.join('\n\n');
}
