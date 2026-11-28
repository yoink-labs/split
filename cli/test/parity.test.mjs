import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { main, describeImport, describeGroupDelete } from '../split.mjs';

const trip = fileURLToPath(new URL('../../fixtures/splitwise/buenos-aires-trip_2026-11-18_export.csv', import.meta.url));
const plan = {
  preview: true, group: 'buenos aires trip', members: ['Harris', 'Maya', 'Alex', 'Sam'], rows: 9, expenses: 8, payments: 1,
  skipped: [], currencies: { ARS: 9 }, dates: { from: '2026-11-12', to: '2026-11-18' }, target: { id: 'group-0001', name: 'BA' },
  people: [{ name: 'Alex', becomes: 'you (Alex A)' }, { name: 'Maya', becomes: 'new placeholder (possible match: Maya)' }],
  suggestedMapping: { Maya: 'member-0001' }, ambiguous: { Sam: ['a', 'b'] }
};
const deletion = { preview: true, action: 'Delete BA and its history for every member. This cannot be undone.', group: 'group-0001',
  name: 'BA', members: ['Alex', 'Maya'], expenses: 2, settlements: 0, receipts: 1, revision: 'f'.repeat(64) };

// Runs main() against a local fake Worker, recording each /v1/cli call and the terminal output.
async function session(t, respond) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(body);
    const result = respond(body);
    const { __status, ...reply } = result;
    res.writeHead(__status ?? 200).end(JSON.stringify(Array.isArray(result) ? result : reply));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const saved = { ...process.env };
  Object.assign(process.env, { SPLIT_API_URL: 'http://127.0.0.1:' + server.address().port, SPLIT_TOKEN: 'spl_test' });
  t.after(() => { process.env = saved; process.exitCode = 0; });
  return async (argv, { interactive = true, answers = [] } = {}) => {
    const out = [], err = [], questions = [];
    const log = console.log, error = console.error;
    console.log = (...v) => out.push(v.join(' ')); console.error = (...v) => err.push(v.join(' '));
    try { await main(argv, { interactive, ask: async q => { questions.push(q); return answers.shift() ?? ''; } }); }
    finally { console.log = log; console.error = error; }
    const code = process.exitCode; process.exitCode = 0;
    return { out: out.join('\n'), err: err.join('\n'), questions, calls: calls.splice(0), code };
  };
}

test('member balances print signed lines and preserve linked refund IDs in JSON', async t => {
  const amine = { id: 'amine', name: 'Amine' };
  const maya = { id: 'maya', name: 'Maya' };
  const statement = [{
    currency: 'USD', member: maya, net: 3000,
    lines: [
      { kind: 'expense', title: 'Airbnb', amount: -30000, from: [maya], to: [amine] },
      { kind: 'settlement', title: 'Settlement', amount: 30000, from: [maya], to: [amine] },
      { kind: 'refund', title: 'Refund: Airbnb', amount: 3000, from: [amine], to: [maya],
        refundOf: 'airbnb', originalTitle: 'Airbnb' },
    ],
  }];
  const run = await session(t, () => statement);
  const args = ['balances', '--group', 'group-0001', '--member', maya.id];
  const text = await run(args);
  assert.deepEqual(text.calls, [{ name: 'balances', arguments: { group: 'group-0001', member: maya.id } }]);
  assert.equal(text.out, [
    'Maya · USD',
    '−USD 300.00  Airbnb · Expense paid by Amine',
    '+USD 300.00  Settlement · Payment · Maya → Amine',
    '+USD 30.00  Refund: Airbnb · Refund from Amine · Refund of Airbnb',
    'Balance  +USD 30.00',
  ].join('\n'));
  assert.deepEqual(JSON.parse((await run([...args, '--json'])).out), statement);
});

test('import plans read as plain language and never hide unlinked matches', () => {
  const text = describeImport(plan);
  assert.match(text, /9 entries \(8 expenses, 1 payments\) from 2026-11-12 to 2026-11-18/);
  assert.match(text, /Into: your group "BA"/);
  assert.match(text, /Maya → new placeholder \(possible match: Maya\)/);
  assert.match(text, /--mapping '\{"Maya":"member-0001"\}'/);
  assert.match(text, /share these names.*Sam/);
  assert.match(describeImport({ ...plan, people: undefined, target: 'new group' }), /Next: add --me/);
});

test('an interactive import shows the plan and asks before saving; scripts keep importing directly', async t => {
  const run = await session(t, body => body.arguments.preview ? plan : { groupID: 'group-0001', inserted: 9 });
  const base = ['import', 'splitwise', '--file', trip, '--group', 'group-0001', '--me', 'Alex'];

  const declined = await run(base, { answers: ['n'] });
  assert.equal(declined.calls.length, 1);
  assert.equal(declined.calls[0].arguments.preview, true);
  assert.match(declined.err, /Maya → new placeholder/);
  assert.match(declined.err, /Nothing was imported/);

  const accepted = await run(base, { answers: ['y'] });
  assert.deepEqual(accepted.calls.map(c => c.arguments.preview), [true, undefined]);
  assert.equal(accepted.calls[1].arguments.mapping, undefined);
  assert.match(accepted.out, /"inserted": 9/);

  // --yes, --json and non-interactive runs send the released request shape once.
  for (const [argv, interactive] of [[[...base, '--yes'], true], [[...base, '--json'], true], [base, false]]) {
    const direct = await run(argv, { interactive });
    assert.equal(direct.calls.length, 1, argv.join(' '));
    assert.equal(direct.questions.length, 0);
    assert.equal('yes' in direct.calls[0].arguments, false);
    assert.equal('preview' in direct.calls[0].arguments, false);
  }

  const explicit = await run([...base, '--preview']);
  assert.equal(explicit.calls.length, 1);
  assert.match(explicit.out, /Nothing is saved yet/);
});

test('group deletion needs a typed name or an explicit revision, never an auto-fetched one', async t => {
  const run = await session(t, body => body.arguments.yes ? { deleted: true, id: 'group-0001' } : deletion);

  const script = await run(['groups', 'delete', '--group', 'group-0001', '--yes'], { interactive: false });
  assert.equal(script.code, 1);
  assert.equal(script.calls.length, 0);
  assert.match(script.err, /needs the revision/);

  const wrong = await run(['groups', 'delete', '--group', 'group-0001', '--yes'], { answers: ['ba'] });
  assert.equal(wrong.code, 1);
  assert.equal(wrong.calls.length, 1);
  assert.match(wrong.err, /2 expenses, 0 settlements and 1 receipt photos/);
  assert.match(wrong.err, /Nothing was deleted/);

  const typed = await run(['groups', 'delete', '--group', 'group-0001', '--yes'], { answers: ['BA'] });
  assert.deepEqual(typed.calls[1].arguments, { group: 'group-0001', yes: true, revision: deletion.revision });

  const pinned = await run(['groups', 'delete', '--group', 'group-0001', '--yes', '--revision', deletion.revision, '--json'], { interactive: false });
  // The usual destructive preview is still printed, but the pinned revision is what gets sent.
  assert.equal(pinned.calls.at(-1).arguments.revision, deletion.revision);
  assert.deepEqual(JSON.parse(pinned.out), { deleted: true, id: 'group-0001' });

  const preview = await run(['groups', 'delete', '--group', 'group-0001']);
  assert.match(preview.out, /--yes --revision f{64}/);
});

test('expense add and edit list and validate category choices', async t => {
  const run = await session(t, () => ({ id: 'expense-0001' }));
  for (const command of ['add', 'edit']) {
    const help = await run(['expenses', command, '--help']);
    assert.match(help.out, /--category .*General, Dining, Groceries.*Fees, Other/);
    const invalid = await run(['expenses', command, '--category', 'food']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /--category must be one of: General, Dining, Groceries.*Fees, Other/);
    assert.deepEqual(invalid.calls, []);
  }
});

test('expense edits show readable previews and emit one JSON result when confirmed', async t => {
  const before = { id: 'expense-0001', title: 'Dinner', amount: 450, currency: 'USD', category: 'Dining',
    createdAt: '2026-11-12T12:00:00Z', paidBy: 'member-0001', splitMode: 'equal', splits: [{ memberID: 'member-0001', amount: 450 }],
    receiptIDs: ['receipt-0001'], recurrence: 'weekly' };
  const preview = { preview: true, before, after: { ...before, title: 'Supper' }, revision: 'f'.repeat(64) };
  const applied = { applied: true, id: before.id };
  let reply = preview;
  const run = await session(t, ({ arguments: args }) => args.yes ? applied : reply);
  const base = ['expenses', 'edit', '--group', 'group-0001', '--expense', before.id, '--title', 'Supper'];

  const human = await run(base, { interactive: false });
  assert.match(human.out, /Before\n  Dinner — USD 4\.50[\s\S]+After\n  Supper — USD 4\.50/);
  assert.match(human.out.split('\nAfter\n')[1], /Receipt photos: receipt-0001\n  Recurrence: weekly/);
  assert.match(human.out, /--yes --revision f{64}/);
  assert.deepEqual(JSON.parse((await run([...base, '--json'])).out), preview);

  for (const revisionArgs of [[], ['--revision', preview.revision]]) {
    const confirmed = await run([...base, '--yes', ...revisionArgs, '--json']);
    assert.deepEqual(JSON.parse(confirmed.out), applied);
    assert.equal(confirmed.err, '');
    assert.deepEqual(confirmed.calls.map(call => call.arguments.yes), revisionArgs.length ? [true] : [false, true]);
    assert.equal(confirmed.calls.at(-1).arguments.revision, preview.revision);
  }
  assert.equal((await run([...base, '--yes'])).out, 'Updated expense expense-0001.');

  const { receiptIDs, recurrence, ...oldAfter } = preview.after;
  reply = { ...preview, after: oldAfter };
  assert.equal((await run(base)).out, human.out);
});

test('previews strip terminal control sequences from imported and group names', () => {
  const hostile = { ...plan, group: 'trip\u001b]0;pwned\u0007', people: [{ name: 'Ma\u001b[2Jya‮', becomes: 'new placeholder' }],
    skipped: ['row\r\u009b31m'], suggestedMapping: { 'Ev\u001bil': 'member-0001' } };
  const text = describeImport(hostile);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/);
  assert.match(text, /Ma�\[2Jya�/);
  const removal = describeGroupDelete({ ...deletion, name: 'x', action: 'Delete \u001b[31mBA', members: ['A\u0007'] });
  assert.doesNotMatch(removal, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test('a preview from an older Worker prints only the fields it has', () => {
  const text = describeImport({ preview: true, group: 'buenos aires trip', members: ['Harris', 'Maya'], rows: 9, skipped: [], next: 'Run again with me set to your name in this file.' });
  assert.doesNotMatch(text, /undefined|NaN|null/);
  assert.match(text, /"buenos aires trip": 9 entries\./);
  assert.match(text, /People in this file: Harris, Maya\./);
  assert.doesNotMatch(describeImport({}), /undefined/);
});

test('an older Worker without import plans gets a clear error and nothing is imported', async t => {
  const old = { error: 'Property "preview" does not match additional properties schema.' };
  let mode = 'reject';
  const run = await session(t, body => {
    if (mode === 'reject' && body.arguments.preview) return { __status: 422, ...old };
    if (mode === 'legacy') return { preview: true, group: 'BA', members: ['Alex'], rows: 9, skipped: [] };
    return { inserted: 9 };
  });
  const base = ['import', 'splitwise', '--file', trip, '--group', 'group-0001', '--me', 'Alex'];
  for (const argv of [base, [...base, '--preview']]) {
    const result = await run(argv, { answers: ['y'] });
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.err, /cannot show an import plan yet\. Nothing was imported/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].arguments.preview, true);
    assert.equal(result.questions.length, 0);
  }
  mode = 'legacy';
  const legacy = await run(base, { answers: ['y'] });
  assert.equal(legacy.code, 1);
  assert.equal(legacy.calls.length, 1);
  assert.equal(legacy.questions.length, 0);
});
