import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { client } from './lib/client.mjs';
import { tools } from './lib/catalog.mjs';
import { serve } from './lib/stdio.mjs';

import version from './release/version.json' with { type: 'json' };
export { version };
const spelling = tool => tool.name.replaceAll('_',' ');
function usage(tool) {
  const { properties, required } = tool.inputSchema;
  const args = Object.entries(properties).map(([key, spec]) => {
    const flag = '--' + key + (spec.type === 'boolean' ? '' : spec.type === 'array' ? ' JSON' : ' VALUE');
    return required.includes(key) ? flag : '[' + flag + ']';
  });
  return 'split ' + [spelling(tool), ...args].join(' ');
}
const help = ['Split by Yoink Labs', 'Usage: split [--json] COMMAND [flags]', '',
  'split login [--name NAME] [--no-open]', 'split auth status', 'split logout [--yes]', 'split mcp',
  ...tools.map(usage), '', 'Use split COMMAND --help for argument details. JSON arrays must be shell-quoted.',
  'SPLIT_API_URL selects a server. SPLIT_TOKEN supplies a device credential.', '',
  'Source, issues and contributing: https://github.com/yoink-labs/split'].join('\n');
const print = (value, compact) => console.log(JSON.stringify(value, null, compact ? undefined : 2));

async function login(c, options) {
  const pending = await c.request('/v1/device/start', { name: options.name || hostname() }, false);
  const url = new URL('/device', c.origin).href;
  console.error('In Split on your iPhone, open You → Connected computers. Enter ' + pending.code + ' and approve this computer.\n' + url);
  if (!options['no-open']) {
    const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio:'ignore', detached:true });
    browser.on('error', () => {}); browser.unref();
  }
  const end = Date.now() + pending.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(Math.max(1, pending.interval) * 1000);
    const result = await c.request('/v1/device/poll', { device: pending.device }, false);
    if (result.status === 'pending') continue;
    await c.save(result.token);
    return { signedIn: true, origin: c.origin };
  }
  throw new Error('Approval expired. Run split login again.');
}

export async function main(argv = process.argv.slice(2)) {
  const compact = argv.includes('--json');
  const words = argv.filter(x => !['--json','--help','-h'].includes(x));
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  try {
    if (words[0] === '--version') return compact ? print({ version }, true) : console.log('split ' + version);
    const tool = tools.find(t => spelling(t).split(' ').every((word,i) => words[i] === word));
    if (wantsHelp || !words.length) {
      const message = tool ? [usage(tool),tool.description,...Object.entries(tool.inputSchema.properties).map(([key,s]) => '  --'+key+'  '+s.description)].join('\n') : help;
      return compact ? print({ help: message }, true) : console.log(message);
    }
    const c = await client();
    if (words[0] === 'mcp' && words.length === 1) return await serve(c);
    if (words[0] === 'login') {
      const { values } = parseArgs({ args: words.slice(1), options: { name: {type:'string'}, 'no-open': {type:'boolean'} } });
      return print(await login(c, values), compact);
    }
    if (words.join(' ') === 'auth status') {
      return print(c.signedIn ? { signedIn:true, origin:c.origin, ...await c.request('/v1/device/status') } : {signedIn:false, origin:c.origin}, compact);
    }
    if (words[0] === 'logout') {
      const { values } = parseArgs({ args: words.slice(1), options: {yes:{type:'boolean'}} });
      if (!c.signedIn) return print({ signedIn:false }, compact);
      const preview = { preview:true, action:'Revoke this device credential', origin:c.origin };
      if (!values.yes) return print(preview,compact);
      console.error(JSON.stringify(preview));
      try { await c.request('/v1/device/logout', {}); } catch (e) { if (e.status !== 401) throw e; }
      await c.forget();
      return print({ signedIn:false, revoked:true },compact);
    }
    if (!tool) throw new Error('Unknown command. Run split --help.');
    const options = Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key,spec]) => [key, {type:spec.type === 'boolean' ? 'boolean' : 'string'}]));
    const { values } = parseArgs({ args: words.slice(spelling(tool).split(' ').length), options });
    for (const [key,value] of Object.entries(values)) {
      if (tool.inputSchema.properties[key].type === 'array') {
        try { values[key] = JSON.parse(value); } catch { throw new Error('--' + key + ' requires a JSON array.'); }
        if (!Array.isArray(values[key])) throw new Error('--' + key + ' requires a JSON array.');
      }
    }
    const run = args => c.request('/v1/cli', { name:tool.name, arguments:args });
    if (tool.annotations.destructiveHint && values.yes) {
      const preview = await run({ ...values, yes:false });
      console.error(JSON.stringify(preview));
      values.revision ??= preview.revision;
    }
    print(await run(values),compact);
  } catch (error) {
    console.error(compact ? JSON.stringify({ error:error.message }) : 'split: ' + error.message);
    process.exitCode = 1;
  }
}
