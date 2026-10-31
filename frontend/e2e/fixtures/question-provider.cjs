const http = require('node:http');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide a loopback port');
const answer = (message, finishReason) => ({ choices: [{ finish_reason: finishReason, message }] });
http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/fixture-health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ fixture: 'terminal-v4-multi-question' }));
    return;
  }
  let input = '';
  request.on('data', chunk => { input += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(input);
      const question = (body.tools || []).find(tool => tool.function?.name === 'ask_user');
      const schema = question?.function?.parameters?.properties?.questions;
      const tool = (body.messages || []).find(message => message.role === 'tool' && message.tool_call_id === 'multi-fixture');
      let result;
      if (tool) {
        const content = JSON.parse(tool.content);
        const good = JSON.stringify(content.answers) === JSON.stringify({ devices: ['Phone', 'Desktop', 'Tablet'], reason: ['The keyboard'] });
        result = answer({ role: 'assistant', content: good ? 'Verified all selected answers.' : 'The fixture received unexpected answers.' }, 'stop');
      } else if (schema?.maxItems === 5 && schema.items?.properties?.multiSelect?.type === 'boolean') {
        result = answer({ role: 'assistant', content: null, tool_calls: [{ id: 'multi-fixture', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ questions: [
          { id: 'devices', question: 'Which devices?', multiSelect: true, options: [{ label: 'Phone' }, { label: 'Desktop' }] },
          { id: 'reason', question: 'What should I check?' },
        ] }) } }] }, 'tool_calls');
      } else result = answer({ role: 'assistant', content: 'The fixture did not receive the expected question schema.' }, 'stop');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
}).listen(port, '127.0.0.1', () => console.log('Synthetic multi-question provider ready'));
