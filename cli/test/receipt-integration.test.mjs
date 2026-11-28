import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const enabled = process.env.SPLIT_TEST_RECEIPTS === '1';
const testPhotos = process.env.SPLIT_TEST_RECEIPT_PHOTOS === '1';

test('CLI receipts close automatically and accept large HEIC and PNG uploads', { skip: !enabled, timeout: 180_000 }, async t => {
  const scratch = join(root, '.ade');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'cli-receipts-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const portFinder = createServer().listen(0, '127.0.0.1');
  await once(portFinder, 'listening');
  const { port } = portFinder.address();
  await new Promise(resolve => portFinder.close(resolve));

  const origin = 'http://127.0.0.1:' + port;
  const env = { ...process.env, CLERK_SECRET_KEY: 'local-receipt-test', WRANGLER_SEND_METRICS: 'false' };
  const worker = join(root, 'worker');
  const wrangler = join(worker, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const local = ['--local', '--persist-to', dir];
  const wranglerRun = args => run(process.execPath, [wrangler, ...args], { cwd: worker, env });
  await wranglerRun(['d1', 'migrations', 'apply', 'split', ...local]);
  const token = 'spl_' + randomUUID() + randomUUID();
  const hash = createHash('sha256').update(token).digest('hex');
  const seed = `INSERT INTO cli_tokens(id,token_hash,user_id,name,created_at,scope)
    VALUES ('test-receipts','${hash}','test-receipts','Local test',0,'cli')`;
  await wranglerRun(['d1', 'execute', 'split', ...local, '--command', seed]);

  server = spawn(process.execPath, [wrangler, 'dev', ...local, '--ip', '127.0.0.1', '--port', String(port),
    '--var', 'APP_URL:' + origin], { cwd: worker, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  let ready = false;
  for (let tries = 0; tries < 200 && server.exitCode === null; tries++) {
    const health = await fetch(origin + '/health').catch(() => null);
    if (health?.ok) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, logs);

  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, [join(root, 'cli', 'bin', 'split'), ...args, '--json'], {
      env: { ...env, SPLIT_API_URL: origin, SPLIT_TOKEN: token },
    });
    return JSON.parse(stdout);
  };
  const { id: group, members: [payer] } = await cli('groups', 'create', '--name', 'Receipt test', '--self', 'Alex');
  const receipt = await cli('expenses', 'add', '--group', group, '--payer', payer.id, '--title', 'Lunch',
    '--bill', JSON.stringify({ items: [{ title: 'Lunch', amount: '14.01' }], tax: '0.99', tip: '2.01' }));
  const receiptArgs = ['--group', group, '--expense', receipt.id];
  const before = await cli('items', 'list', ...receiptArgs);
  assert.equal(before.closed, false);
  t.diagnostic('split items list before final assignment → closed: ' + before.closed);
  const item = before.items[0].id;
  const assigned = await cli('items', 'assign', ...receiptArgs, '--item', item, '--participants', JSON.stringify([payer.id]));
  assert.deepEqual(assigned, { ok: true, closed: true });
  t.diagnostic('split items assign → ' + JSON.stringify(assigned));
  const after = await cli('items', 'list', ...receiptArgs);
  assert.equal(after.closed, true);
  assert.equal(after.items[0].portions[0].amount, 1701);
  t.diagnostic('split items list after assignment → closed: true, claimant share: 1701 cents');
  const explicit = await cli('receipts', 'reopen', ...receiptArgs);
  assert.deepEqual(explicit, { ok: true, closed: false });
  assert.deepEqual((await cli('items', 'list', ...receiptArgs)).items, after.items);
  const remove = await cli('receipts', 'people', ...receiptArgs, '--remove', JSON.stringify([payer.id]));
  assert.deepEqual(remove, { ok: true, closed: false });
  const add = await cli('receipts', 'people', ...receiptArgs, '--add', JSON.stringify([payer.id]));
  assert.deepEqual(add, { ok: true, closed: true });
  const reopened = await cli('items', 'claim', ...receiptArgs, '--item', item, '--action', 'remove');
  assert.equal(reopened.closed, false);
  assert.equal((await cli('items', 'close', ...receiptArgs)).closed, true);

  if (!testPhotos) return;
  assert.equal(process.platform, 'linux');
  const png = join(dir, 'large-receipt.png');
  const heic = join(dir, 'large-receipt.heic');
  await run('convert', ['-limit', 'thread', '2', '-seed', '42', '-size', '3200x2400', 'xc:gray',
    '+noise', 'Gaussian', '-depth', '8', 'PNG24:' + png]);
  await run('convert', ['-limit', 'thread', '2', png, '-quality', '90', heic], { maxBuffer: 8 * 1024 * 1024 });
  const limit = 240 * 1024;
  for (const path of [heic, png]) {
    const originalBytes = (await stat(path)).size;
    assert.ok(originalBytes > limit);
    const { uploaded: [photo] } = await cli('receipts', 'upload', '--group', group, '--photo', path);
    assert.ok(photo);
    const out = join(dir, 'download.jpg');
    await cli('receipts', 'get', '--group', group, '--photo', photo, '--out', out);
    const bytes = await readFile(out);
    assert.ok(bytes.length > 4 && bytes.length <= limit);
    assert.deepEqual([...bytes.subarray(0, 3), ...bytes.subarray(-2)], [255, 216, 255, 255, 217]);
    t.diagnostic(`Linux split receipts upload --photo ${path.split('/').at(-1)} (${originalBytes} bytes) → uploaded and downloaded JPEG (${bytes.length} bytes)`);
  }
});
