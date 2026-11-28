import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const args = ['expenses', 'combine', '--group', 'trip', '--expenses', '["first","second"]'];
const portions = [{memberID:'maya',amount:501}, {memberID:'alex',amount:500}];
const summary = {
  expense: {title:'Airport rides', amount:1001, currency:'USD', payers:portions, splits:portions,
    createdAt:'2026-11-20T12:00:00Z', splitMode:'equal', receiptIDs:['combined-photo']},
  sources: [{id:'first', title:'Taxi', receiptIDs:['photo']}, {id:'second', title:'Ride share', receiptIDs:[]}],
  payerNames: [{...portions[0],name:'Maya'}, {...portions[1],name:'Alex'}],
  splitNames: [{...portions[0],name:'Maya'}, {...portions[1],name:'Alex'}],
};
const preview = {...summary, preview:true, revision:'a'.repeat(64)};
const saved = {...summary, entryID:'combined-id', expense:{...summary.expense, id:'combined-id'}};
const run = promisify(execFile);
const entrypoint = new URL('../split.mjs', import.meta.url).href;

async function harness(t) {
  const requests = [];
  let oldServer = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { name, arguments: input } = JSON.parse(Buffer.concat(chunks));
    requests.push({name, ...input});
    res.setHeader('Content-Type','application/json');
    if (oldServer) res.writeHead(422).end(JSON.stringify({error:'Additional properties are not allowed.'}));
    else res.end(JSON.stringify(input.yes ? saved : preview));
  });
  server.listen(0,'127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return {
    requests,
    useOldServer() { oldServer = true; },
    invoke(flags = [], answer) {
      const code = `import {main} from ${JSON.stringify(entrypoint)};
        const answer = ${JSON.stringify(answer)};
        await main(${JSON.stringify([...args, ...flags])}, {
          stdinTTY: answer !== undefined,
          ask(question) { console.error(question); return answer; }
        });`;
      return run(process.execPath, ['--input-type=module','-e',code], {
        env: {...process.env, SPLIT_API_URL:`http://127.0.0.1:${server.address().port}`, SPLIT_TOKEN:'test-token'},
      });
    },
  };
}

test('combine previews before confirming and prints the full saved summary with ID', async t => {
  const { invoke, requests } = await harness(t);
  const { stdout, stderr } = await invoke([], 'y');
  assert.match(stderr, /Combine preview[\s\S]*Taxi \(first\)[\s\S]*Ride share \(second\)[\s\S]*Save the combined expense\? \[y\/N\]/);
  for (const output of [stderr, stdout]) {
    assert.match(output, /Airport rides — USD 10\.01/);
    assert.match(output, /Paid by: Maya \(USD 5\.01\), Alex \(USD 5\.00\)/);
    assert.match(output, /Split \(equal\): Maya \(USD 5\.01\), Alex \(USD 5\.00\)/);
    assert.match(output, /Receipt photos: 1 \(listed below\)/);
    assert.match(output, /Taxi \(first\) — receipts: photo/);
  }
  assert.match(stdout, /^Combined expense combined-id/);
  assert.deepEqual(requests.map(r => [r.name,r.yes,r.revision]), [
    ['expenses_combine',false,undefined], ['expenses_combine',true,preview.revision],
  ]);
});

test('combine declines on the default answer or an explicit no', async t => {
  const { invoke, requests } = await harness(t);
  for (const answer of ['', 'n']) {
    const { stdout, stderr } = await invoke([], answer);
    assert.equal(stdout, '');
    assert.match(stderr, /\[y\/N\][\s\S]*Nothing was combined\./);
  }
  assert.deepEqual(requests.map(r => r.yes), [false, false]);
});

test('combine --yes and -y skip the prompt and --json writes one complete result', async t => {
  const { invoke, requests } = await harness(t);
  for (const flag of ['--yes', '-y']) {
    const { stdout, stderr } = await invoke([flag, '--json']);
    assert.match(stderr, /Combine preview/);
    assert.doesNotMatch(stderr, /\[y\/N\]/);
    assert.deepEqual(JSON.parse(stdout), saved);
  }
  assert.deepEqual(requests.map(r => r.yes), [false, true, false, true]);
});

test('combine --dry-run previews with redirected stdin even alongside --yes', async t => {
  const { invoke, requests } = await harness(t);
  const { stdout, stderr } = await invoke(['--dry-run','--yes']);
  assert.match(stdout, /^Combine preview/);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse((await invoke(['--dry-run','--json'])).stdout), preview);
  assert.deepEqual(requests.map(r => r.yes), [false, false]);
});

test('combine refuses without a TTY or an explicit flag', async t => {
  const { invoke, requests } = await harness(t);
  await assert.rejects(invoke(), {code:1, stderr:/requires a terminal.*--yes.*--dry-run/});
  assert.deepEqual(requests, []);
});

test('combine on older Workers fails closed even with --yes', async t => {
  const { invoke, requests, useOldServer } = await harness(t);
  useOldServer();
  await assert.rejects(invoke(['--yes']), {code:1, stderr:/does not support combine previews/});
  assert.deepEqual(requests.map(r => r.yes), [false]);
});
