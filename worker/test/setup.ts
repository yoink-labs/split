import { env, applyD1Migrations } from 'cloudflare:test';
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// This Vitest integration reuses a D1 instance across tests in a file.
import { beforeEach } from 'vitest';
beforeEach(async () => {
  for (const table of ['entry_comments','entry_reactions','deleted_entries','invites','group_invites','member_aliases','member_contacts','entries','members','groups','lookup_limits','split_profiles'])
    await env.DB.prepare('DELETE FROM '+table).run();
});
