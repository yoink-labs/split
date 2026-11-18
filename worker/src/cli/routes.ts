import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import version from '../../../cli/release/version.json';
import { tools } from '../../../cli/lib/catalog.mjs';
import { body, HTTPError, json } from '../http';
import { InputError } from '../ledger';
import { operate, type LedgerHandler } from './operations';

export async function cliRoute(request: Request, env: Env, user: string, handle: LedgerHandler) {
  if (new URL(request.url).pathname === '/v1/cli') {
    if (request.method !== 'POST') throw new HTTPError(405,'Use POST.');
    const { name, arguments: args } = await body(request);
    if (typeof name !== 'string') throw new InputError('Specify a command.');
    return json(await operate(name, args ?? {}, env, user, handle));
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== env.APP_URL) throw new HTTPError(403, 'Untrusted origin.');
  if (request.method !== 'POST') return new Response(null, {status: 405, headers: { Allow: 'POST' }});
  const server = new Server({ name: 'split', version }, {
    capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await operate(params.name, params.arguments ?? {}, env, user, handle);
      if(params.name==='receipts_get') return {content:[{type:'image',...result as {data:string;mimeType:string}}]};
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      if (!(e instanceof HTTPError || e instanceof InputError)) throw new Error('Split could not complete the request.');
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32768 });
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { await server.close(); }
}
