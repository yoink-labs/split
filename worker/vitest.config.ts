import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig(async()=>({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'},miniflare:{bindings:{CLERK_SECRET_KEY:'local-test-fixture',TEST_MIGRATIONS:await readD1Migrations({projectPath:import.meta.dirname})}}})],test:{setupFiles:['./test/setup.ts']}}));
