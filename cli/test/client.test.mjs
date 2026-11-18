import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { apiOrigin, client } from '../lib/client.mjs';
import { fileURLToPath } from 'node:url';

test('credentials are private, origin-bound and forgotten independently of env overrides', async t => {
  const dir = await mkdtemp(join(tmpdir(),'split-cli-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const env = { XDG_CONFIG_HOME:dir };
  const first = await client({...env,SPLIT_API_URL:'https://example.test'});
  await first.save('spl_test');
  assert.equal((await stat(join(dir,'split','credentials.json'))).mode & 0o777,0o600);
  assert.equal((await client(env)).origin,'https://example.test');
  assert.equal((await client({...env,SPLIT_API_URL:'https://other.test'})).signedIn,false);
  await (await client({...env,SPLIT_TOKEN:'env-token'})).forget();
  assert.equal((await client(env)).signedIn,true);
  await (await client(env)).forget();
  assert.equal((await client(env)).signedIn,false);
  assert.throws(()=>apiOrigin('http://example.test'));
  assert.throws(()=>apiOrigin('https://user@example.test'));
  assert.equal(apiOrigin('http://127.0.0.1:3000/'),'http://127.0.0.1:3000');
});
test('offline version, help and per-command flags work through the installed launcher', () => {
  const run = args => spawnSync(fileURLToPath(new URL('../bin/split',import.meta.url)),args,{encoding:'utf8'});
  assert.equal(run(['--version']).stdout.trim(),'split 0.1.0');
  assert.match(run(['--help']).stdout,/members lookup/);
  assert.match(run(['--help']).stdout,/github\.com\/yoink-labs\/split/);
  assert.match(run(['expenses','edit','--help']).stdout,/--revision/);
  assert.match(run(['groups','create','--placeholders','nonsense','--json']).stderr,/JSON array/);
  assert.equal(run(['groups','list','--unknown']).status,1);
});
