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
const flagName = key => key === 'chargedAmount' ? 'charged-amount' : key;
function usage(tool) {
  const { properties, required } = tool.inputSchema;
  const args = Object.entries(properties).filter(([key]) => key !== 'file' || !properties.csv).map(([key, spec]) => {
    if (key === 'csv') return '(--file PATH [--file PATH ...] | --csv VALUE [--file NAME])';
    const flag = (tool.name === 'expenses_combine' && key === 'yes' ? '--yes|-y' : '--' + flagName(key)) + (spec.type === 'boolean' ? '' : (spec.type === 'array' || spec.type === 'object') ? ' JSON' : ' VALUE');
    return required.includes(key) ? flag : '[' + flag + ']';
  });
  if (properties.photos) args.push('[--photo PATH ...]');
  if (tool.name === 'import_splitwise') args.push('[--yes]');
  if (tool.name === 'expenses_combine') args.push('[--dry-run]');
  if (outputs.has(tool.name)) args.push('[--out PATH]');
  return 'split ' + [spelling(tool), ...args].join(' ');
}
const outputs = new Set(['groups_export', 'receipts_get']);

const help = ['Split by Yoink Labs', 'Usage: split [--json] COMMAND [flags]', '',
  'split login [--name NAME] [--no-open]', 'split auth status', 'split logout [--yes]', 'split mcp',
  ...tools.map(usage), '', 'Use split COMMAND --help for argument details. JSON arrays must be shell-quoted.',
  'SPLIT_API_URL selects a server. SPLIT_TOKEN supplies a device credential.', '',
  'Source, issues and contributing: https://github.com/yoink-labs/split'].join('\n');
// Names in previews come from CSV files and other members. Strip terminal controls (C0, DEL, C1)
// and bidirectional overrides so they cannot move the cursor, recolor, retitle or reorder the screen.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const clean = value => typeof value === 'string' ? value.replace(unsafe, '\uFFFD')
  : Array.isArray(value) ? value.map(clean)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), clean(v)])) : value;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
// Plain-language summaries for people at a terminal. Scripts and --json keep the JSON result.
export function describeImport(raw) {
  // Older Workers return only group, members, rows and skipped; print what is there and nothing undefined.
  const plan = clean(raw ?? {});
  const count = (n, word) => Number.isSafeInteger(n) ? n + ' ' + word : null;
  const parts = [count(plan.expenses, 'expenses'), count(plan.payments, 'payments')].filter(Boolean);
  const lines = [(plan.group ? 'Splitwise export "' + plan.group + '"' : 'Splitwise export') +
    (Number.isSafeInteger(plan.rows) ? ': ' + plan.rows + ' entries' + (parts.length ? ' (' + parts.join(', ') + ')' : '') : '') +
    (plan.dates?.from && plan.dates?.to ? ' from ' + plan.dates.from + ' to ' + plan.dates.to : '') + '.'];
  const currencies = plan.currencies && typeof plan.currencies === 'object' ? Object.entries(plan.currencies) : [];
  if (currencies.length) lines.push('Currencies: ' + currencies.map(([c, n]) => c + ' ' + n).join(', ') + '.');
  if (Array.isArray(plan.skipped) && plan.skipped.length)
    lines.push('Skipped ' + plan.skipped.length + ' rows Split cannot import: ' + plan.skipped.map(String).join('; ') + '.');
  const target = plan.target;
  if (target === 'new group') lines.push('Into: a new group.');
  else if (target?.id) lines.push('Into: your group "' + target.name + '".');
  else if (target?.name) lines.push('Into: a new ' + (target.kind ?? '') + ' group "' + target.name + '"' + (target.currency ? ' in ' + target.currency : '') + '.');
  if (Array.isArray(plan.people)) {
    lines.push('People:');
    for (const p of plan.people) lines.push('  ' + p.name + ' → ' + p.becomes);
  } else if (Array.isArray(plan.members)) lines.push('People in this file: ' + plan.members.join(', ') + '.');
  if (plan.suggestedMapping) lines.push('Possible matches are not linked unless you ask. To link them add: --mapping ' + quote(JSON.stringify(plan.suggestedMapping)));
  if (plan.ambiguous) lines.push('Several members share these names, so pick one ID each with --mapping: ' + Object.keys(plan.ambiguous).join(', ') + '.');
  if (plan.note) lines.push(plan.note);
  lines.push(Array.isArray(plan.people) ? 'Nothing is saved yet. Run the same command without --preview to import.'
    : 'Next: add --me with your name from the list above, plus --preview to review who becomes whom.');
  return lines.join('\n');
}
export function describeGroupDelete(raw) {
  const p = clean(raw);
  return [p.action, 'Members: ' + p.members.join(', ') + '.', p.expenses + ' expenses, ' + p.settlements + ' settlements and ' + p.receipts + ' receipt photos will be deleted.',
    'Export a copy first with: split groups export --group ' + p.group + ' --format json --out backup.json',
    'To delete without a prompt: split groups delete --group ' + p.group + ' --yes --revision ' + p.revision].join('\n');
}
function describeExpense(entry, names = {}, receipts = entry.receiptIDs?.join(', ') || 'none') {
  const money = (cents, currency = entry.currency) => {
    const digits = String(cents).padStart(3, '0');
    return `${currency} ${digits.slice(0, -2)}.${digits.slice(-2)}`;
  };
  const portions = people => people.map(p => `${names[p.memberID] ?? p.memberID} (${money(p.amount)})`).join(', ');
  const lines = [
    `  ${entry.title} — ${money(entry.amount)}`,
    `  Date: ${entry.createdAt.slice(0, 10)}`,
    `  Category: ${entry.category ?? 'General'}`,
    `  Paid by: ${portions(entry.payers ?? [{ memberID: entry.paidBy, amount: entry.amount }])}`,
    `  Split (${entry.splitMode}): ${portions(entry.splits)}`,
    `  Receipt photos: ${receipts}`,
    `  Recurrence: ${entry.recurrence ?? 'off'}`
  ];
  if (entry.notes) lines.push(`  Notes: ${entry.notes}`);
  if (entry.handled) lines.push('  Handled outside Split');
  if (entry.exchange) {
    const { target, rateE8, source, date, statementAmount } = entry.exchange;
    if (statementAmount !== undefined) lines.push(`  Actually charged (override): ${money(statementAmount, target)}`);
    lines.push(`  Exchange: 1 ${entry.currency} = ${rateE8 / 100_000_000} ${target} (${source}, ${date})`);
  }
  if (entry.bill) {
    const { items, closed, tax, tip } = entry.bill;
    lines.push(`  Itemized receipt: ${items.length} line items (${closed ? 'closed' : 'open'}), tax ${money(tax)}, tip ${money(tip)}`);
    for (const item of items) {
      lines.push(`    ${item.title}: ${money(item.amount)} · ${item.memberIDs.join(', ') || 'unclaimed'}`);
    }
  }
  return lines;
}
function describeCombine(raw) {
  const { expense, sources, payerNames, splitNames } = clean(raw);
  const names = Object.fromEntries([...payerNames, ...splitNames].map(p => [p.memberID, p.name]));
  return [raw.preview ? 'Combine preview' : 'Combined expense ' + expense.id,
    ...describeExpense(expense, names, expense.receiptIDs.length ? expense.receiptIDs.length + ' (listed below)' : 'none'),
    'Source expenses ' + (raw.preview ? 'to replace:' : 'replaced:'),
    ...sources.map(source => `  ${source.title} (${source.id})${source.receiptIDs.length ? ' — receipts: ' + source.receiptIDs.join(', ') : ''}`),
  ].join('\n');
}
function describeExpenseEdit(raw) {
  const { before, after, revision } = clean(raw);
  // Older Workers omit the unchanged receipt photos and recurrence from the after state.
  const updated = { receiptIDs: before.receiptIDs, recurrence: before.recurrence, ...after };
  return ['Expense edit preview', 'Before', ...describeExpense(before), 'After', ...describeExpense(updated),
    'To apply, rerun this command with --yes --revision ' + revision].join('\n');
}
function describeBalance(raw) {
  return clean(raw).map(({ currency, member, net, lines }) => {
    const signed = amount => {
      const digits = String(Math.abs(amount)).padStart(3, '0');
      const sign = amount < 0 ? '−' : amount > 0 ? '+' : '';
      return sign + currency + ' ' + digits.slice(0, -2) + '.' + digits.slice(-2);
    };
    const names = people => people.map(person => person.name).join(', ');
    return [
      member.name + ' · ' + currency,
      ...lines.map(line => {
        const { kind, from, to, title, refundOf, originalTitle, pending } = line;
        const detail = kind === 'settlement' ? 'Payment · ' + names(from) + ' → ' + names(to)
          : kind === 'refund' ? (refundOf ? 'Refund' : 'Credit') + ' from ' + names(from)
          : 'Expense paid by ' + names(to);
        const original = refundOf ? ' · Refund of ' + (originalTitle ?? refundOf) : '';
        return signed(line.amount) + '  ' + title + ' · ' + detail + original + (pending ? ' · Pending' : '');
      }),
      'Balance  ' + signed(net),
    ].join('\n');
  }).join('\n\n');
}
const print = (value, compact) => console.log(JSON.stringify(value, null, compact ? undefined : 2));

async function csvFile(path) {
  return { csv: await readFile(path, 'utf8'), file: basename(path) };
}

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

const upgradeImport = 'This Split server cannot show an import plan yet. Nothing was imported. Try again later, or pass --yes to import without reviewing the plan.';
async function askLine(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await Promise.race([rl.question(question), new Promise(resolve => rl.once('close', () => resolve('')))]);
  } finally { rl.close(); }
}
const terminal = () => ({ stdinTTY: Boolean(process.stdin.isTTY), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY), ask: askLine });

export async function main(argv = process.argv.slice(2), io = terminal()) {
  const compact = argv.includes('--json');
  const words = argv.filter(x => !['--json','--help','-h'].includes(x));
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  try {
    if (words[0] === '--version') return compact ? print({ version }, true) : console.log('split ' + version);
    const tool = tools.find(t => spelling(t).split(' ').every((word,i) => words[i] === word));
    if (wantsHelp || !words.length) {
      const message = tool ? [usage(tool), tool.description, ...Object.entries(tool.inputSchema.properties).map(([key, spec]) => {
        const description = key === 'file' && tool.inputSchema.properties.csv
          ? 'Path to a CSV export. Repeat for multiple files. With --csv, supply a file name.'
          : spec.description;
        return '  --' + flagName(key) + '  ' + description;
      }), ...(tool.name === 'expenses_combine' ? [
        '  -y  Alias for --yes.',
        '  --dry-run  Print the preview without saving.'
      ] : [])].join('\n') : help;
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
    const options = Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key,spec]) => [flagName(key), {type:spec.type === 'boolean' ? 'boolean' : 'string'}]));
    if (tool.inputSchema.properties.photos) options.photo = { type:'string', multiple:true };
    if (tool.inputSchema.properties.csv) options.file = { type:'string', multiple:true };
    if (outputs.has(tool.name)) options.out = { type:'string' };
    if (tool.name === 'import_splitwise') options.yes = { type:'boolean' };
    if (tool.name === 'expenses_combine') {
      options.yes.short = 'y';
      options['dry-run'] = {type:'boolean'};
    }
    const parsed = parseArgs({ args: words.slice(spelling(tool).split(' ').length), options });
    const paths = tool.inputSchema.properties.photos ? parsed.values.photo : undefined;
    if (paths) delete parsed.values.photo;
    const { file: files, out, "dry-run": dryRun, "charged-amount": chargedAmount, ...values } = parsed.values;
    if (chargedAmount !== undefined) values.chargedAmount = chargedAmount;
    const confirmed = tool.name === 'import_splitwise' && values.yes;
    if (tool.name === 'import_splitwise') delete values.yes;
    const guided = io.interactive && !compact;
    for (const [key,value] of Object.entries(values)) {
      const { type, enum: allowed } = tool.inputSchema.properties[key];
      if (key === 'category' && !allowed.includes(value)) {
        throw new Error('--category must be one of: ' + allowed.join(', ') + '.');
      }
      if (type === 'array' || type === 'object') {
        const expected = '--' + key + ' requires a JSON ' + type + '.';
        try { values[key] = JSON.parse(value); } catch { throw new Error(expected); }
        if (type === 'array' ? !Array.isArray(values[key])
          : !values[key] || typeof values[key] !== 'object' || Array.isArray(values[key])) throw new Error(expected);
      }
    }
    if (paths?.length) {
      if (values.photos) throw new Error('Use --photo or --photos, not both.');
      if (paths.length > 4) throw new Error('Attach up to four receipt photos.');
      values.photos = await Promise.all(paths.map(photoData));
    } else if (values.photos) {
      values.photos = await resolvePhotos(values.photos);
    }
    const run = args => c.request('/v1/cli', { name:tool.name, arguments:args });
    if (tool.name === 'expenses_combine') {
      const { yes, revision, ...args } = values;
      if (!dryRun && !yes && !io.stdinTTY && !io.interactive)
        throw new Error('Combining expenses requires a terminal to confirm. Use --yes to save or --dry-run to preview.');
      const unsupported = 'This Split server does not support combine previews. Update the server and try again.';
      let preview;
      try {
        // Older servers reject the unknown flag before they can save anything.
        preview = await run({...args, yes:false});
      } catch (error) {
        if (error.status === 422 && /additional propert/i.test(error.message)) throw new Error(unsupported);
        throw error;
      }
      if (!preview?.preview || !preview.revision || !preview.expense)
        throw new Error(unsupported);
      if (dryRun) return compact ? print(preview, true) : console.log(describeCombine(preview));
      console.error(describeCombine(preview));
      if (!yes) {
        const answer = await io.ask('Save the combined expense? [y/N] ');
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.error('Nothing was combined.');
          if (compact) print({cancelled:true}, true);
          return;
        }
      }
      const saved = await run({...args, yes:true, revision:revision ?? preview.revision});
      return compact ? print(saved, true) : console.log(describeCombine(saved));
    }
    if (files?.length > 1) {
      if (values.csv !== undefined) throw new Error('Use repeated --file flags or --csv for a single export.');
      const results = [];
      for (const path of files) {
        try {
          const result = await run({ ...values, ...await csvFile(path) });
          results.push({ file: path, result });
        } catch (error) {
          results.push({ file: path, error: error.message });
          process.exitCode = 1;
        }
      }
      return print({ files: results }, compact);
    }
    if (files?.length) {
      const [path] = files;
      if (values.csv) values.file = path;
      else Object.assign(values, await csvFile(path));
    }
    if (tool.name === 'groups_delete' && values.yes && !values.revision) {
      // A whole group is never deleted from a fingerprint fetched in the same breath.
      if (!guided) throw new Error('Deleting a group needs the revision from its preview. Run split groups delete --group ' + values.group + ' first, then add --yes --revision VALUE.');
      const preview = await run({ ...values, yes:false });
      console.error(describeGroupDelete(preview));
      const typed = await io.ask('Type the group name to delete it for everyone: ');
      if (typed.trim() !== clean(preview.name)) throw new Error('The name did not match. Nothing was deleted.');
      values.revision = preview.revision;
    } else if (tool.name === 'expenses_edit' && values.yes) {
      if (!values.revision) values.revision = (await run({ ...values, yes:false })).revision;
    } else if (tool.annotations.destructiveHint && values.yes) {
      const preview = await run({ ...values, yes:false });
      console.error(JSON.stringify(preview));
      values.revision ??= preview.revision;
    }
    if (tool.name === 'import_splitwise' && guided && !values.preview && !confirmed && (values.me || values.group)) {
      let plan;
      try { plan = await run({ ...values, preview:true }); }
      catch (error) {
        // A Worker without the preview flag rejects it before reading the file. Never fall back to importing.
        if (error.status === 422 && /additional propert|preview/i.test(error.message)) throw new Error(upgradeImport);
        throw error;
      }
      if (!plan?.preview) throw new Error(upgradeImport);
      console.error(describeImport(plan));
      if (!Array.isArray(plan.people)) {
        if (values.me) throw new Error(upgradeImport);
        return;
      }
      const answer = await io.ask('Import ' + plan.rows + ' entries now? [y/N] ');
      if (!/^y(es)?$/i.test(answer.trim())) return console.error('Nothing was imported.');
    }
    let result;
    try { result = await run(values); }
    catch (error) {
      if (tool.name === 'import_splitwise' && values.preview && error.status === 422 && /additional propert|preview/i.test(error.message)) throw new Error(upgradeImport);
      throw error;
    }
    if (tool.name === 'import_splitwise' && result?.preview && guided) return console.log(describeImport(result));
    if (tool.name === 'groups_delete' && result?.preview && guided) return console.log(describeGroupDelete(result));
    if (tool.name === 'expenses_edit' && !compact) {
      if (result.preview) return console.log(describeExpenseEdit(result));
      const category = result.category ? ' Saved category is ' + clean(result.category) + '.' : '';
      return console.log('Updated expense ' + clean(result.id ?? values.expense) + '.' + category);
    }
    if (tool.name === 'groups_export' && out) {
      await writeFile(out, result.content);
      return compact ? print({ saved: out }, true) : console.log('Wrote ' + out);
    }
    if (tool.name === 'groups_export' && !compact) return process.stdout.write(result.content);
    if (tool.name === 'receipts_get' && out) {
      await writeFile(out, Buffer.from(result.data, 'base64'));
      return compact ? print({ saved: out }, true) : console.log('Wrote ' + out);
    }
    if (tool.name === 'balances' && values.member && !compact) return console.log(describeBalance(result));
    print(result,compact);
  } catch (error) {
    console.error(compact ? JSON.stringify({ error:error.message }) : 'split: ' + clean(String(error.message)));
    process.exitCode = 1;
  }
}
