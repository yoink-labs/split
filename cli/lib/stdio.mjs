import { createInterface } from 'node:readline';

// The Worker is stateless and returns a single JSON response (or an empty
// 202 for notifications). Keep stdout exclusively for newline-delimited MCP.
export async function serve(client) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let version;
  for await (const line of input) {
    let message;
    try { message = JSON.parse(line); }
    catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) + '\n');
      continue;
    }
    try {
      const reply = await client.request('/mcp', message, true, {
        Accept: 'application/json, text/event-stream', ...(version ? { 'MCP-Protocol-Version': version } : {})
      });
      if (message?.method === 'initialize' && reply?.result) version = reply.result.protocolVersion;
      if (reply !== undefined) process.stdout.write(JSON.stringify(reply) + '\n');
    } catch (error) {
      if (message?.id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }) + '\n');
      }
    }
  }
}
