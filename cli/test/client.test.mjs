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
  assert.equal(run(['--version']).stdout.trim(),'split 0.3.0');
  assert.match(run(['--help']).stdout,/members lookup/);
  assert.match(run(['--help']).stdout,/github\.com\/yoink-labs\/split/);
  assert.match(run(['expenses','edit','--help']).stdout,/--revision/);
  assert.match(run(['members','update','--help']).stdout,/--email/);
  assert.match(run(['invite','--help']).stdout,/--email/);
  assert.match(run(['groups','create','--placeholders','nonsense','--json']).stderr,/JSON array/);
  assert.equal(run(['groups','list','--unknown']).status,1);
});
test('the release archive and npm package include every module the CLI imports', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = await readFile(join(root, 'release/package.sh'), 'utf8');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = JSON.parse(await readFile(join(root, 'release/version.json'), 'utf8'));
  assert.equal(pkg.version, version);
  for (const file of ['split.mjs', ...(await readdir(join(root, 'lib'))).map(f => 'lib/' + f)]) {
    assert.match(script, new RegExp('cli/' + file.replace('.', '\\.')), file + ' is missing from package.sh');
  }
});
test('photo paths become receipt JPEGs and base64 passes through untouched', async () => {
  const { resolvePhotos } = await import('../lib/photos.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'split-photo-test-'));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);
  await writeFile(join(dir, 'r.jpg'), jpeg);
  const [fromPath, passthrough] = await resolvePhotos([join(dir, 'r.jpg'), '/9j/notAFile']);
  assert.equal(fromPath, jpeg.toString('base64'));
  assert.equal(passthrough, '/9j/notAFile');
  await rm(dir, { recursive: true, force: true });
});
test('every web action has a CLI command with file flags where they help', () => {
  const run = args => spawnSync(fileURLToPath(new URL('../bin/split',import.meta.url)),args,{encoding:'utf8'});
  const help = run(['--help']).stdout;
  for (const command of ['groups update','groups archive','groups leave','groups export','members remove','invites list','invites revoke',
    'expenses show','expenses like','comments add','comments delete','receipts add','items list','items assign','import splitwise','profile avatar'])
    assert.match(help, new RegExp('split ' + command + ' '), command);
  assert.match(run(['expenses','add','--help']).stdout, /--photo PATH/);
  assert.match(run(['import','splitwise','--help']).stdout, /--file PATH/);
  assert.match(run(['groups','export','--help']).stdout, /--out PATH/);
});
