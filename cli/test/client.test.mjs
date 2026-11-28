import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
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
test('offline version, help and per-command flags work through the installed launcher', async () => {
  const run = args => spawnSync(fileURLToPath(new URL('../bin/split',import.meta.url)),args,{encoding:'utf8'});
  const version = JSON.parse(await readFile(new URL('../release/version.json', import.meta.url), 'utf8'));
  assert.equal(run(['--version']).stdout.trim(),`split ${version}`);
  assert.match(run(['--help']).stdout,/members lookup/);
  assert.match(run(['--help']).stdout,/github\.com\/yoink-labs\/split/);
  assert.match(run(['expenses','edit','--help']).stdout,/--revision/);
  assert.match(run(['members','update','--help']).stdout,/--email/);
  assert.match(run(['invite','--help']).stdout,/--email/);
  assert.match(run(['groups','create','--placeholders','nonsense','--json']).stderr,/JSON array/);
  assert.equal(run(['groups','list','--unknown']).status,1);
});
test('the release archive contains every CLI module and reports its automatic release version', async t => {
  const { readdir } = await import('node:fs/promises');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const declared = JSON.parse(await readFile(join(root, 'release/version.json'), 'utf8'));
  assert.equal(pkg.version, declared);

  const [major, minor, patch] = declared.split('.').map(Number);
  const version = `${major}.${minor}.${patch + 1}`;
  const dir = await mkdtemp(join(tmpdir(), 'split-cli-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = promisify(execFile);
  await run('bash', ['cli/release/package.sh', `split-v${version}`, dir], { cwd: join(root, '..') });
  await run('tar', ['-xzf', join(dir, `split-${version}.tar.gz`), '-C', dir]);
  const archived = join(dir, `split-${version}`, 'cli');
  for (const file of (await readdir(join(root, 'lib'))).filter(file => file.endsWith('.mjs'))) {
    assert.ok((await stat(join(archived, 'lib', file))).isFile());
  }
  const { stdout } = await run(join(archived, 'bin', 'split'), ['--version']);
  assert.equal(stdout.trim(), `split ${version}`);
});
test('photo paths become receipt JPEGs and base64 passes through untouched', async () => {
  const { resolvePhotos } = await import('../lib/photos.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'split-photo-test-'));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);
  await writeFile(join(dir, 'r.jpg'), jpeg);
  const [fromPath, passthrough] = await resolvePhotos([join(dir, 'r.jpg'), '/9j/notAFile']);
  assert.equal(fromPath, jpeg.toString('base64'));
  assert.equal(passthrough, '/9j/notAFile');
  await writeFile(join(dir, 'document.bin'), '%PDF-1.7');
  await assert.rejects(resolvePhotos([join(dir, 'document.bin')]), /PDF receipts are unsupported/);
  await rm(dir, { recursive: true, force: true });
});
test('every web action has a CLI command with file flags where they help', () => {
  const run = args => spawnSync(fileURLToPath(new URL('../bin/split',import.meta.url)),args,{encoding:'utf8'});
  const help = run(['--help']).stdout;
  for (const command of ['groups update','groups archive','groups leave','groups export','members remove','invites list','invites revoke',
    'expenses show','expenses like','comments add','comments delete','receipts add','items list','items assign','import splitwise','profile avatar'])
    assert.match(help, new RegExp('split ' + command + ' '), command);
  assert.match(run(['expenses','add','--help']).stdout, /--photo PATH/);
  assert.match(run(['expenses','add','--help']).stdout, /"items":\[\{"title":"Coffee","amount":"4\.50"\}/);
  assert.match(run(['expenses','repeat','--help']).stdout, /off, daily, weekly, monthly, or yearly/);
  assert.match(run(['import','splitwise','--help']).stdout, /--file PATH/);
  assert.match(run(['groups','export','--help']).stdout, /--out PATH/);
});

test('CLI downloads write files and confirmed edits print one result', async t => {
  const launcher = fileURLToPath(new URL('../bin/split', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'split-cli-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const group = 'group-1234', expense = 'expense-1234', photo = 'receipt-1234';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const content = '{"entries":[]}\n';
  const csv = 'Title,Amount\r\nCoffee,4.50\r\n';
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(payload);
    const result = payload.name === 'expenses_edit' ? { applied: true } : payload.name === 'receipts_get'
      ? { data: jpeg.toString('base64') }
      : { content: payload.arguments.format === 'json' ? content : csv };
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const env = { ...process.env, SPLIT_TOKEN: 'spl_test', SPLIT_API_URL: 'http://127.0.0.1:' + server.address().port };
  const run = args => promisify(execFile)(launcher, args, { env });
  const receiptPath = join(dir, 'receipt.jpg');
  const exportPath = join(dir, 'export.json');
  const ledgerPath = join(dir, 'ledger.csv');
  const receipt = await run(['receipts', 'get', '--group', group, '--expense', expense, '--photo', photo, '--out', receiptPath, '--json']);
  const exported = await run(['groups', 'export', '--group', group, '--format', 'json', '--out', exportPath, '--json']);
  const ledger = await run(['groups', 'export', '--group', group, '--out', ledgerPath, '--json']);
  const edit = await run(['expenses', 'edit', '--group', group, '--expense', expense, '--yes', '--revision', 'revision', '--json']);
  assert.equal(edit.stderr, '');
  assert.deepEqual(JSON.parse(edit.stdout), { applied: true });
  assert.deepEqual(JSON.parse(receipt.stdout), { saved: receiptPath });
  assert.deepEqual(JSON.parse(exported.stdout), { saved: exportPath });
  assert.deepEqual(JSON.parse(ledger.stdout), { saved: ledgerPath });
  assert.deepEqual(await readFile(receiptPath), jpeg);
  assert.equal(await readFile(exportPath, 'utf8'), content);
  assert.equal(await readFile(ledgerPath, 'utf8'), csv);
  assert.deepEqual(requests, [
    { name: 'receipts_get', arguments: { group, expense, photo } },
    { name: 'groups_export', arguments: { group, format: 'json' } },
    { name: 'groups_export', arguments: { group } },
    { name: 'expenses_edit', arguments: { group, expense, yes: true, revision: 'revision' } }
  ]);
});

test('Splitwise file batches send each export and report partial failures', async t => {
  const fixtures = fileURLToPath(new URL('../../fixtures/splitwise/', import.meta.url));
  const launcher = fileURLToPath(new URL('../bin/split', import.meta.url));
  const trip = 'buenos-aires-trip_2026-11-18_export.csv';
  const friend = 'friend-maya_2026-11-18_export.csv';
  const edited = 'edited-totals_export.csv';
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, ...payload });
    if (payload.arguments.file === edited) {
      res.writeHead(422).end(JSON.stringify({ error: 'Choose your name from this file.' }));
    } else {
      res.end(JSON.stringify({ inserted: 3 }));
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const run = (files) => promisify(execFile)(launcher, [
    'import', 'splitwise', '--me', 'Alex', '--json',
    ...files.flatMap(file => ['--file', join(fixtures, file)]),
  ], { env: { ...process.env, SPLIT_API_URL: 'http://127.0.0.1:' + server.address().port, SPLIT_TOKEN: 'spl_test' } });

  const single = await run([trip]);
  assert.deepEqual(JSON.parse(single.stdout), { inserted: 3 });
  requests.length = 0;
  await assert.rejects(run([trip, edited, friend]), error => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), { files: [
      { file: join(fixtures, trip), result: { inserted: 3 } },
      { file: join(fixtures, edited), error: 'Choose your name from this file.' },
      { file: join(fixtures, friend), result: { inserted: 3 } },
    ] });
    return true;
  });
  assert.deepEqual(requests, await Promise.all([trip, edited, friend].map(async file => ({
    url: '/v1/cli',
    name: 'import_splitwise',
    arguments: { me: 'Alex', file, csv: await readFile(join(fixtures, file), 'utf8') },
  }))));
});
