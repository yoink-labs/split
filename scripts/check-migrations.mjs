#!/usr/bin/env node
// Database guard for Split's D1 migrations.
//
//   node scripts/check-migrations.mjs --all      check every file in worker/migrations
//   node scripts/check-migrations.mjs --remote   check only migrations not yet applied
//                                                 to the remote `split` database
//
// Fails (exit 1) when a checked migration contains destructive SQL: DROP TABLE,
// DROP COLUMN, ALTER TABLE ... RENAME, DELETE or UPDATE without WHERE, TRUNCATE,
// or a table rebuild (create new table, copy rows, drop old). A migration opts
// out only with an explicit `-- allow-destructive: <reason>` comment.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const migrationsDir = join(root, 'worker', 'migrations');
const wranglerConfig = join(root, 'worker', 'wrangler.jsonc');

const OPT_OUT = /--[ \t]*allow-destructive:[ \t]*(\S[^\n]*)/i;

/** Removes comments and string literal contents so keywords inside them are ignored. */
function stripSql(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (sql[i] === quote) break;
        else i++;
      }
      out += quote;
    } else {
      out += c;
    }
  }
  return out;
}

/** Drops everything inside parentheses, so a WHERE in a subquery does not count. */
function topLevel(text) {
  let depth = 0;
  let out = '';
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** The text from `index` up to the end of the statement (the next `;`). */
function statementFrom(sql, index) {
  const end = sql.indexOf(';', index);
  return sql.slice(index, end === -1 ? sql.length : end);
}

function lineOf(sql, index) {
  return sql.slice(0, index).split('\n').length;
}

const IDENT = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[\w$]+)(?:\s*\.\s*(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[\w$]+))?`;
const name = (raw) => raw.replace(/["`[\]]/g, '').replace(/\s+/g, '').split('.').pop().toLowerCase();
const unscopedWhere = /\bWHERE\b\s*(?:1|TRUE|1\s*=\s*1|'[^']*'\s*=\s*'[^']*')\s*$/i;

/**
 * Returns the destructive operations in one migration's SQL.
 * Each finding is `{ line, rule, detail }`.
 */
export function findDestructive(source) {
  const sql = stripSql(source);
  const findings = [];
  const add = (index, rule, detail) => findings.push({ line: lineOf(sql, index), rule, detail });

  for (const m of sql.matchAll(new RegExp(String.raw`\bDROP\s+TABLE\b(?:\s+IF\s+EXISTS)?\s+(${IDENT})`, 'gi'))) {
    add(m.index, 'DROP TABLE', `drops table ${name(m[1])}`);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bALTER\s+TABLE\s+(${IDENT})\s+DROP\b(?:\s+COLUMN)?\s+(${IDENT})`, 'gi'))) {
    add(m.index, 'DROP COLUMN', `drops column ${name(m[2])} from ${name(m[1])}`);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bALTER\s+TABLE\s+(${IDENT})\s+RENAME\b`, 'gi'))) {
    add(m.index, 'ALTER TABLE RENAME', `renames ${name(m[1])} or one of its columns`);
  }
  for (const m of sql.matchAll(/\bTRUNCATE\b/gi)) {
    add(m.index, 'TRUNCATE', 'truncates a table');
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bDELETE\s+FROM\s+(${IDENT})`, 'gi'))) {
    const statement = topLevel(statementFrom(sql, m.index)).trim();
    if (!/\bWHERE\b/i.test(statement) || unscopedWhere.test(statement)) {
      add(m.index, 'DELETE without WHERE', `deletes every row in ${name(m[1])}`);
    }
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?(${IDENT})\s+SET\b`, 'gi'))) {
    const statement = topLevel(statementFrom(sql, m.index)).trim();
    if (!/\bWHERE\b/i.test(statement) || unscopedWhere.test(statement)) {
      add(m.index, 'UPDATE without WHERE', `updates every row in ${name(m[1])}`);
    }
  }

  // Table rebuild: a table created here is filled from another table by
  // INSERT ... SELECT, and the source table is then dropped.
  const dropped = new Set(
    [...sql.matchAll(new RegExp(String.raw`\bDROP\s+TABLE\b(?:\s+IF\s+EXISTS)?\s+(${IDENT})`, 'gi'))].map((m) => name(m[1])),
  );
  const created = new Set(
    [...sql.matchAll(new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'gi'))]
      .map((m) => name(m[1])),
  );
  for (const m of sql.matchAll(new RegExp(String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(${IDENT})`, 'gi'))) {
    const target = name(m[1]);
    if (!created.has(target)) continue;
    const statement = statementFrom(sql, m.index);
    const source = new RegExp(String.raw`\bSELECT\b[\s\S]*?\bFROM\s+(${IDENT})`, 'i').exec(statement);
    if (source && name(source[1]) !== target && dropped.has(name(source[1]))) {
      add(m.index, 'table rebuild', `copies rows from ${name(source[1])} into new table ${target}`);
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/** The opt-out reason, or null when the migration has no `-- allow-destructive:` comment. */
export function optOutReason(source) {
  return OPT_OUT.exec(source)?.[1].trim() || null;
}

/** Checks named migration files. Returns `{ failures, allowed }`. */
export function checkFiles(files, dir = migrationsDir) {
  const failures = [];
  const allowed = [];
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    const findings = findDestructive(source);
    if (!findings.length) continue;
    const reason = optOutReason(source);
    (reason ? allowed : failures).push({ file, findings, reason });
  }
  return { failures, allowed };
}

export function localMigrations(dir = migrationsDir) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/** Parses `wrangler d1 execute --json` output into the applied migration names. */
export function parseApplied(stdout) {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output:\n${stdout}`);
  const batches = JSON.parse(stdout.slice(start));
  return new Set(batches.flatMap((b) => b.results ?? []).map((r) => r.name));
}

export function pendingMigrations(local, applied) {
  return local.filter((f) => !applied.has(f));
}

function remoteApplied() {
  const wrangler = join(root, 'worker', 'node_modules', '.bin', 'wrangler');
  try {
    const stdout = execFileSync(
      wrangler,
      ['d1', 'execute', 'split', '--remote', '--json', '--config', wranglerConfig,
        '--command', 'SELECT name FROM d1_migrations ORDER BY id'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return parseApplied(stdout);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (/no such table: d1_migrations/i.test(output)) return new Set();
    throw new Error(`Could not list applied migrations on the remote split database.\n${output || error.message}`);
  }
}

function report({ failures, allowed }, checked) {
  for (const { file, findings, reason } of allowed) {
    console.log(`Allowed destructive migration ${file}: ${reason}`);
    for (const f of findings) console.log(`  line ${f.line}: ${f.rule} (${f.detail})`);
  }
  if (failures.length) {
    console.error('\nDatabase guard: destructive SQL in a migration. Nothing was applied or deployed.\n');
    for (const { file, findings } of failures) {
      console.error(`  worker/migrations/${file}`);
      for (const f of findings) console.error(`    line ${f.line}: ${f.rule} (${f.detail})`);
    }
    console.error(
      '\nRewrite the migration additively (add a new table or column and stop using the old one),\n' +
      'or, if losing or rewriting this data is intended, have a person add a comment such as\n' +
      '  -- allow-destructive: <why this is safe>\n' +
      'to the migration and get it reviewed.\n',
    );
    return 1;
  }
  console.log(`Database guard: ${checked.length} migration(s) checked, no unapproved destructive SQL.`);
  return 0;
}

function main(argv) {
  const mode = argv[0];
  const local = localMigrations();
  let files;
  if (mode === '--all') {
    files = local;
  } else if (mode === '--remote') {
    files = pendingMigrations(local, remoteApplied());
    console.log(files.length ? `Pending remote migrations: ${files.join(', ')}` : 'No pending remote migrations.');
  } else {
    console.error('Usage: node scripts/check-migrations.mjs --all | --remote');
    return 2;
  }
  return report(checkFiles(files), files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
