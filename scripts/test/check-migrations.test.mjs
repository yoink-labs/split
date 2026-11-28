import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkFiles, findDestructive, localMigrations, optOutReason, parseApplied, pendingMigrations,
} from '../check-migrations.mjs';

const rules = (sql) => findDestructive(sql).map((f) => f.rule);

test('additive migrations pass', () => {
  assert.deepEqual(rules(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    ALTER TABLE groups ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX notes_body ON notes(body);
    INSERT INTO receipt_usage (id, bytes) VALUES (1, 0);
    UPDATE groups SET archived = 0 WHERE archived IS NULL;
    DELETE FROM lookup_limits WHERE hour < 10;
  `), []);
});

test('flags DROP TABLE, DROP COLUMN, RENAME and TRUNCATE', () => {
  assert.deepEqual(rules('DROP TABLE notes;'), ['DROP TABLE']);
  assert.deepEqual(rules('drop table if exists "notes";'), ['DROP TABLE']);
  assert.deepEqual(rules('ALTER TABLE groups DROP COLUMN kind;'), ['DROP COLUMN']);
  assert.deepEqual(rules('ALTER TABLE groups DROP kind;'), ['DROP COLUMN']);
  assert.deepEqual(rules('ALTER TABLE groups RENAME TO teams;'), ['ALTER TABLE RENAME']);
  assert.deepEqual(rules('ALTER TABLE groups RENAME COLUMN kind TO type;'), ['ALTER TABLE RENAME']);
  assert.deepEqual(rules('TRUNCATE TABLE entries;'), ['TRUNCATE']);
});

test('flags DELETE and UPDATE without a top-level WHERE', () => {
  assert.deepEqual(rules('DELETE FROM entries;'), ['DELETE without WHERE']);
  assert.deepEqual(rules('DELETE FROM entries WHERE 1;'), ['DELETE without WHERE']);
  assert.deepEqual(rules('UPDATE members SET name = upper(name);'), ['UPDATE without WHERE']);
  assert.deepEqual(rules('UPDATE OR IGNORE members SET name = \'x\';'), ['UPDATE without WHERE']);
  assert.deepEqual(
    rules('UPDATE members SET name = (SELECT name FROM split_profiles WHERE user_id = members.user_id);'),
    ['UPDATE without WHERE'],
  );
});

test('flags a table rebuild', () => {
  const found = rules(`
    CREATE TABLE members_new (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO members_new (id, name) SELECT id, name FROM members;
    DROP TABLE members;
    ALTER TABLE members_new RENAME TO members;
  `);
  assert.deepEqual(found.sort(), ['ALTER TABLE RENAME', 'DROP TABLE', 'table rebuild']);
});

test('allows scoped deletes in triggers, like 0017', () => {
  assert.deepEqual(rules(`
    CREATE TRIGGER delete_group_ledger BEFORE DELETE ON groups
    BEGIN
      DELETE FROM invites WHERE group_id=OLD.id;
      DELETE FROM member_aliases WHERE member_id IN (SELECT id FROM members WHERE group_id=OLD.id)
        OR canonical_id IN (SELECT id FROM members WHERE group_id=OLD.id);
      DELETE FROM members WHERE group_id=OLD.id;
    END;
    CREATE TRIGGER claim_capacity BEFORE UPDATE OF user_id ON members BEGIN SELECT 1; END;
    CREATE TABLE r (entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE);
  `), []);
});

test('flags an unscoped delete inside a trigger', () => {
  assert.deepEqual(
    rules('CREATE TRIGGER wipe AFTER INSERT ON groups BEGIN DELETE FROM entries; END;'),
    ['DELETE without WHERE'],
  );
});

test('ignores keywords in comments and strings', () => {
  assert.deepEqual(rules(`
    -- We used to DROP TABLE notes here.
    /* DELETE FROM entries; */
    INSERT INTO notes (id, body) VALUES ('a', 'DROP TABLE groups; DELETE FROM entries');
  `), []);
});

test('reports line numbers', () => {
  assert.equal(findDestructive('CREATE TABLE a (id TEXT);\n\nDROP TABLE b;')[0].line, 3);
});

test('opt-out requires an explicit reason', () => {
  assert.equal(optOutReason('-- allow-destructive: table was never used in production\nDROP TABLE x;'),
    'table was never used in production');
  assert.equal(optOutReason('-- allow-destructive:\nDROP TABLE x;'), null);
  assert.equal(optOutReason('DROP TABLE x;'), null);
});

test('checkFiles separates failures from opted-out migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-migrations-'));
  writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id TEXT);');
  writeFileSync(join(dir, '0002_bad.sql'), 'DROP TABLE a;');
  writeFileSync(join(dir, '0003_allowed.sql'), '-- allow-destructive: replaced by b\nDROP TABLE a;');
  const { failures, allowed } = checkFiles(localMigrations(dir), dir);
  assert.deepEqual(failures.map((f) => f.file), ['0002_bad.sql']);
  assert.deepEqual(allowed.map((f) => [f.file, f.reason]), [['0003_allowed.sql', 'replaced by b']]);
});

test('pending migrations are local files missing from d1_migrations', () => {
  const applied = parseApplied(`noise\n[{"results":[{"name":"0001_a.sql"},{"name":"0002_b.sql"}],"success":true}]`);
  assert.deepEqual(pendingMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql'], applied), ['0003_c.sql']);
});

test('every committed migration passes the guard', () => {
  const { failures } = checkFiles(localMigrations());
  assert.deepEqual(failures, []);
});
