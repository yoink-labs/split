import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { client } from './lib/client.mjs';
import { tools } from './lib/catalog.mjs';
import { serve } from './lib/stdio.mjs';
import { photoData, resolvePhotos } from './lib/photos.mjs';
export { photoData };

import version from './release/version.json' with { type: 'json' };
export { version };
const spelling = tool => tool.name.replaceAll('_',' ');
function usage(tool) {
  const { properties, required } = tool.inputSchema;
  const args = Object.entries(properties).map(([key, spec]) => {
    const flag = '--' + key + (spec.type === 'boolean' ? '' : (spec.type === 'array' || spec.type === 'object') ? ' JSON' : ' VALUE');
    return required.includes(key) ? flag : '[' + flag + ']';
  });
  if (properties.photos) args.push('[--photo PATH ...]');
  if (properties.csv) args.push('[--file PATH]');
  if (outputs.has(tool.name)) args.push('[--out PATH]');
  return 'split ' + [spelling(tool), ...args].join(' ');
}
const outputs = new Set(['groups_export', 'receipts_get']);

const help = ['Split by Yoink Labs', 'Usage: split [--json] COMMAND [flags]', '',
  'split login [--name NAME] [--no-open]', 'split auth status', 'split logout [--yes]', 'split mcp',
  ...tools.map(usage), '', 'Use split COMMAND --help for argument details. JSON arrays must be shell-quoted.',
  'SPLIT_API_URL selects a server. SPLIT_TOKEN supplies a device credential.', '',
  'Source, issues and contributing: https://github.com/yoink-labs/split'].join('\n');
const print = (value, compact) => console.log(JSON.stringify(value, null, compact ? undefined : 2));

async function login(c, options) {
  const pending = await c.request('/v1/device/start', { name: options.name || hostname() }, false);
  const url = new URL('/device', c.origin).href;
  console.error('Approve this computer with code ' + pending.code + ':\n  Web:    ' + url + '\n  iPhone: Split → You → Connected computers');
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
    if (tool.inputSchema.properties.photos) options.photo = { type:'string', multiple:true };
    if (tool.inputSchema.properties.csv) options.file = { type:'string' };
    if (outputs.has(tool.name)) options.out = { type:'string' };
    const { values } = parseArgs({ args: words.slice(spelling(tool).split(' ').length), options });
    const paths = values.photo, out = values.out;
    delete values.photo; delete values.out;
    if (tool.inputSchema.properties.csv && typeof values.file === 'string' && !values.csv) {
      values.csv = await readFile(values.file, 'utf8');
      values.file = basename(values.file);
    }
    for (const [key,value] of Object.entries(values)) {
      const type = tool.inputSchema.properties[key].type;
      if (type === 'array' || type === 'object') {
        const expected = '--' + key + ' requires a JSON ' + type + '.';
        try { values[key] = JSON.parse(value); } catch { throw new Error(expected); }
        if (type === 'array' ? !Array.isArray(values[key])
          : !values[key] || typeof values[key] !== 'object' || Array.isArray(values[key])) throw new Error(expected);
      }
    }
    if (values.photos) values.photos = await resolvePhotos(values.photos);
    if (paths?.length) {
      if (values.photos) throw new Error('Use --photo or --photos, not both.');
      if (paths.length > 4) throw new Error('Attach up to four receipt photos.');
      values.photos = await Promise.all(paths.map(photoData));
    }
    const run = args => c.request('/v1/cli', { name:tool.name, arguments:args });
    if (tool.annotations.destructiveHint && values.yes) {
      const preview = await run({ ...values, yes:false });
      console.error(JSON.stringify(preview));
      values.revision ??= preview.revision;
    }
    const result = await run(values);
    if (tool.name === 'groups_export' && !compact) {
      if (out) { await writeFile(out, result.content); return console.log('Wrote ' + out); }
      return process.stdout.write(result.content);
    }
    if (tool.name === 'receipts_get' && out) {
      await writeFile(out, Buffer.from(result.data, 'base64'));
      return compact ? print({ saved: out }, true) : console.log('Wrote ' + out);
    }
    print(result,compact);
  } catch (error) {
    console.error(compact ? JSON.stringify({ error:error.message }) : 'split: ' + error.message);
    process.exitCode = 1;
  }
}
