const http = require('node:http');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide a loopback port');
const answer = (message, finishReason) => ({ choices: [{ finish_reason: finishReason, message }] });

http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/fixture-health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ fixture: 'terminal-v4-background-delegation' }));
    return;
  }
  let input = '';
  request.on('data', chunk => { input += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(input);
      const parent = (body.tools || []).some(tool => tool.function?.name === 'delegate_task_background');
      const messages = body.messages || [];
      const transcript = JSON.stringify(messages);
      let result;
      if (transcript.includes('Delegated task ')) {
        result = answer({ role: 'assistant', content: transcript.includes('Verified fixture child answer.') ? 'Parent received the verified background answer.' : 'Fixture child verification failed.' }, 'stop');
      } else if (parent && messages.some(message => message.role === 'tool')) {
        result = answer({ role: 'assistant', content: 'Background investigation started.' }, 'stop');
      } else if (parent) {
        result = answer({ role: 'assistant', content: null, tool_calls: [{ id: 'delegate-fixture', type: 'function', function: { name: 'delegate_task_background', arguments: JSON.stringify({ prompt: 'Inspect notes in the fixture project.' }) } }] }, 'tool_calls');
      } else if (messages.some(message => message.role === 'tool')) {
        const verified = transcript.includes('Tool denied by read-only child policy') && transcript.includes('original');
        result = answer({ role: 'assistant', content: verified ? 'Verified fixture child answer.' : 'Fixture child verification failed.' }, 'stop');
      } else {
        result = answer({ role: 'assistant', content: null, tool_calls: [
          { id: 'write-fixture', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes', content: 'changed' }) } },
          { id: 'read-fixture', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes' }) } },
        ] }, 'tool_calls');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
}).listen(port, '127.0.0.1', () => console.log('Synthetic background delegation provider ready'));
