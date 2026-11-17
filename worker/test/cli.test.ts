import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { manageDevices } from '../src/cli/devices';

function req(path: string, data?: unknown, token?: string, headers: Record<string,string> = {}) {
  return new Request(env.APP_URL + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type':'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
}
const fetch = (path: string, data?: unknown, token?: string, headers?: Record<string,string>) =>
  worker.fetch(req(path,data,token,headers),env);
async function start() { return (await fetch('/v1/device/start',{name:'Test computer'})).json<{code:string;device:string}>(); }
async function authorize(user: string) {
  const pending = await start();
  await manageDevices(req('/v1/device/approve',{code:pending.code}),env,user);
  return (await (await fetch('/v1/device/poll',{device:pending.device})).json<{token:string}>()).token;
}
beforeEach(async () => { await env.DB.exec('DELETE FROM cli_requests; DELETE FROM cli_tokens;'); });
describe('device authorization', () => {
  it('requires Clerk approval, hashes secrets, exchanges once and revokes immediately', async () => {
    const pending = await start();
    const poll = () => fetch('/v1/device/poll',{device:pending.device});
    expect((await poll()).status).toBe(202);
    expect((await fetch('/v1/device/approve',{code:pending.code})).status).toBe(401);
    const row = await env.DB.prepare('SELECT * FROM cli_requests').first();
    expect(JSON.stringify(row)).not.toContain(pending.device);
    expect(JSON.stringify(row)).not.toContain(pending.code.replace('-',''));
    expect(await (await manageDevices(req('/v1/device/review',{code:pending.code}),env,'alex')).json()).toEqual({name:'Test computer'});
    await manageDevices(req('/v1/device/approve',{code:pending.code}),env,'alex');
    await expect(manageDevices(req('/v1/device/approve',{code:pending.code}),env,'maya')).rejects.toThrow();
    const responses = await Promise.all([poll(),poll()]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,410]);
    const {token} = await responses.find(r=>r.ok)!.json<{token:string}>();
    expect((await fetch('/v1/device/status',undefined,token)).status).toBe(200);
    expect((await fetch('/v1/device/approve',{code:pending.code},token)).status).toBe(403);
    const saved = await env.DB.prepare('SELECT * FROM cli_tokens').first();
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved?.last_used).toBeGreaterThan(0);
    const devices = await (await manageDevices(req('/v1/device/tokens'),env,'alex')).json<{id:string}[]>();
    expect(devices).toHaveLength(1);
    const revoke = req('/v1/device/revoke',{id:devices[0].id});
    await expect(manageDevices(revoke.clone(),env,'maya')).rejects.toThrow();
    await manageDevices(revoke,env,'alex');
    expect((await fetch('/v1/device/status',undefined,token)).status).toBe(401);
  });
  it('expires codes and limits starts per source', async () => {
    const pending = await start();
    await env.DB.exec('UPDATE cli_requests SET expires_at=0');
    expect((await fetch('/v1/device/poll',{device:pending.device})).status).toBe(410);
    for (let i=0;i<15;i++) expect((await fetch('/v1/device/start',{name:'Test'})).status).toBe(201);
    expect((await fetch('/v1/device/start',{name:'Test'})).status).toBe(429);
  });
});
describe('CLI and MCP', () => {
  it('validates operations, resolves placeholders and preserves the reviewed expense on conflict', async () => {
    const token = await authorize('alex'), outsider = await authorize('maya');
    async function run(name:string, args:object, device=token) {
      const r = await fetch('/v1/cli',{name,arguments:args},device);
      const value = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(value));
      return value;
    }
    const {id:group,members} = await run('groups_create',{name:'Trip',self:'Alex',placeholders:['Maya']});
    const [payer, other] = members.map(m=>m.id);
    expect((await run('groups_list',{},outsider))).toEqual([]);
    await expect(run('groups_show',{group},outsider)).rejects.toThrow('Group not found');
    expect(await run('members_list',{group})).toHaveLength(2);
    await env.DB.prepare('INSERT INTO split_profiles VALUES (?,?,?,?,?)').bind('new-user','Pat','pat','pat@example.test',Date.now()).run();
    expect((await run('members_lookup',{query:'pat@example.test'}))[0].userID).toBe('new-user');
    await run('members_add',{group,name:'Pat',user:'new-user'});
    await run('members_add',{group,name:'Guest',email:'guest@example.test'});
    const invite = await run('invite',{group,member:other});
    expect((await run('join',{invite:invite.url},outsider)).groupID).toBe(group);
    const args = {group,payer,participants:[payer,other],title:'Dinner',amount:'10.01'};
    const first = await run('expenses_add',args);
    expect(first.splits.map(s=>s.amount)).toEqual([501,500]);
    await expect(run('expenses_add',{...args,mode:'percent',values:['50','49']})).rejects.toThrow('sum to 100');
    await expect(run('expenses_add',{...args,mode:'exact',values:['3','4']})).rejects.toThrow('match the total');
    const exact = await run('expenses_add',{...args,mode:'exact',values:['3.00','7.01']});
    expect(exact.splits.map(s=>s.amount)).toEqual([300,701]);
    const pct = await run('expenses_add',{...args,mode:'percent',currency:'EUR',values:['25','75']});
    expect(pct.splits.map(s=>s.amount)).toEqual([250,751]);
    expect(await run('expenses_list',{group})).toHaveLength(3);
    const target = {group,expense:first.id};
    const preview = await run('expenses_delete',target);
    await expect(run('expenses_delete',{...target,yes:true})).rejects.toThrow('fresh preview');
    await expect(run('expenses_edit',{...target,title:'Other'},outsider)).rejects.toThrow('not found');
    const edit = {...target,title:'Supper'};
    const review = await run('expenses_edit',edit);
    await run('expenses_edit',{...edit,revision:review.revision,yes:true});
    await expect(run('expenses_delete',{...target,revision:preview.revision,yes:true})).rejects.toThrow('fresh preview');
    const fresh = await run('expenses_delete',target);
    await run('expenses_delete',{...target,revision:fresh.revision,yes:true});
    await run('settle_up',{group,from:other,to:payer,amount:'7.01'});
    const balances = await run('balances',{group});
    expect(balances.find(b=>b.currency==='USD').settlements).toEqual([]);
    expect(balances.find(b=>b.currency==='EUR').settlements[0].amount).toBe(751);
    expect(await run('activity',{group})).toHaveLength(3);
    expect(await run('expenses_list',{group})).toHaveLength(2);
    await expect(run('groups_list',{typo:'x'})).rejects.toThrow();
  });
  it('serves stateless Streamable HTTP with the same token and rejects foreign origins', async () => {
    const token = await authorize('alex');
    const rpc = {jsonrpc:'2.0',id:1,method:'tools/list'};
    const headers = {Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'};
    expect((await fetch('/mcp',rpc)).status).toBe(401);
    expect((await fetch('/mcp',rpc,token,{...headers,Origin:'https://other.test'})).status).toBe(403);
    const result = await (await fetch('/mcp',rpc,token,headers)).json();
    expect(result.result.tools.find(t=>t.name==='expenses_delete').annotations.destructiveHint).toBe(true);
    const call = { ...rpc, method:'tools/call',params:{name:'groups_list',arguments:{}} };
    expect((await (await fetch('/mcp',call,token,headers)).json()).result.content[0].text).toBe('[]');
    expect((await fetch('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},token,headers)).status).toBe(202);
    expect((await fetch('/mcp',undefined,token)).status).toBe(405);
    await fetch('/v1/device/logout',{},token);
    expect((await fetch('/mcp',call,token,headers)).status).toBe(401);
  });
});
