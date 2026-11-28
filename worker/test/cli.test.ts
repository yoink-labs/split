import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { handle } from '../src/index';
import { manageDevices } from '../src/cli/devices';
import { saveProfile } from '../src/people';
import tripCSV from '../../fixtures/splitwise/buenos-aires-trip_2026-11-18_export.csv?raw';
import pisoCSV from '../../fixtures/splitwise/piso-compartido_2026-11-18_export.csv?raw';
import wgCSV from '../../fixtures/splitwise/wg-kasse_2026-11-18_export.csv?raw';
import friendCSV from '../../fixtures/splitwise/friend-maya_2026-11-18_export.csv?raw';
import excelCSV from '../../fixtures/splitwise/excel-resaved.csv?raw';
import editedCSV from '../../fixtures/splitwise/edited-totals_export.csv?raw';

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
  it('issues named, revocable MCP-only tokens through signed-in account management', async () => {
    const path = '/v1/device/tokens';
    const payload = { name: '  My MCP client  ' };
    expect((await fetch(path, payload)).status).toBe(401);
    const localToken = await authorize('alex');
    expect((await fetch(path, payload, localToken)).status).toBe(403);
    await expect(manageDevices(req(path, { name: ' ' }), env, 'alex')).rejects.toMatchObject({ status: 422 });
    await expect(manageDevices(req(path, { name: 'x'.repeat(81) }), env, 'alex')).rejects.toMatchObject({ status: 422 });

    const response = await manageDevices(req(path, payload), env, 'alex');
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { connection, token } = await response.json<{ connection: { id: string }; token: string }>();
    expect(token).toMatch(/^spl_/);
    expect(connection).toMatchObject({ name: 'My MCP client', scope: 'cli', is_remote: 1, last_used: null });
    const saved = await env.DB.prepare('SELECT * FROM cli_tokens WHERE id=?').bind(connection.id).first();
    expect(JSON.stringify(saved)).not.toContain(token);
    const list = await (await manageDevices(req(path), env, 'alex')).json();
    expect(list).toEqual(expect.arrayContaining([connection, expect.objectContaining({ name: 'Test computer', is_remote: 0 })]));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(await (await manageDevices(req(path), env, 'maya')).json()).toEqual([]);
    expect((await fetch(path, payload, token)).status).toBe(403);
    expect((await fetch('/v1/cli', { name: 'groups_list' }, token)).status).toBe(403);

    const listTools = () => fetch('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token, { Accept: 'application/json, text/event-stream' });
    expect((await listTools()).status).toBe(200);
    const revoke = req('/v1/device/revoke', { id: connection.id });
    await expect(manageDevices(revoke.clone(), env, 'maya')).rejects.toMatchObject({ status: 404 });
    expect((await listTools()).status).toBe(200);
    await manageDevices(revoke, env, 'alex');
    expect((await listTools()).status).toBe(401);
    expect(await (await manageDevices(req(path), env, 'alex')).json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: connection.id })]));
  });
});
describe('CLI and MCP', () => {
  it('invites individuals, corrects placeholder emails and links verified accounts to their history', async () => {
    const token = await authorize('alex'), outsider = await authorize('maya');
    const send = (name:string, args:object, device=token) => fetch('/v1/cli',{name,arguments:args},device);
    async function run(name:string, args:object) {
      const response = await send(name,args);
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    }
    const {id:group,members:[owner]} = await run('groups_create',{name:'Trip',self:'Alex'});
    const {id:otherGroup} = await run('groups_create',{name:'Other',self:'Alex'});
    expect((await send('invite',{group,email:'maya@example.test'})).status).toBe(422);
    expect((await send('invite',{group,name:'Maya',email:'broken'})).status).toBe(422);
    expect(await run('members_list',{group})).toHaveLength(1);

    const {memberID:member,code} = await run('invite',{group,name:'Maya',email:'Old@EXAMPLE.TEST'});
    const contact = () => env.DB.prepare('SELECT email,phone FROM member_contacts WHERE member_id=?').bind(member).first();
    expect(await contact()).toEqual({email:'old@example.test',phone:null});
    await env.DB.prepare('UPDATE member_contacts SET phone=? WHERE member_id=?').bind('+1 555 0100',member).run();
    const expense = await run('expenses_add',{group,payer:owner.id,title:'Dinner',amount:'10.01',participants:[owner.id,member]});
    const update = {group,member,email:'maya@example.test'};
    expect((await send('members_update',update,outsider)).status).toBe(404);
    const emailRoute = '/v1/groups/'+group+'/members/'+member+'/email';
    await expect(handle(req(emailRoute,{email:update.email}),env,'maya')).rejects.toMatchObject({status:403});
    expect((await send('members_update',{...update,group:otherGroup})).status).toBe(422);
    expect((await send('members_update',{...update,member:owner.id})).status).toBe(422);
    expect((await send('members_update',{...update,email:'broken'})).status).toBe(422);
    expect(await contact()).toEqual({email:'old@example.test',phone:'+1 555 0100'});
    expect((await send('invite',{group,member,name:'Maya'})).status).toBe(422);

    expect(await run('members_update',update)).toEqual({id:member,email:'maya@example.test'});
    expect((await send('join',{invite:code},outsider)).status).toBe(404);
    expect(await run('members_update',{group,member,email:'none'})).toEqual({id:member,email:null});
    expect(await contact()).toEqual({email:null,phone:'+1 555 0100'});

    const personal = await run('invite',{group,member,email:'Maya@EXAMPLE.TEST'});
    expect(personal).toMatchObject({memberID:member,url:expect.stringContaining(personal.code)});
    expect(await run('members_update',update)).toEqual({id:member,email:'maya@example.test'});
    expect((await run('invites_list',{group})).invites).toHaveLength(1);
    expect(await contact()).toEqual({email:'maya@example.test',phone:'+1 555 0100'});
    expect((await run('members_list',{group})).find((m:{id:string})=>m.id===member)).not.toHaveProperty('email');

    await run('members_remove',{group,member});
    expect((await send('members_update',update)).status).toBe(422);
    await run('members_remove',{group,member,mode:'restore'});
    await saveProfile(env.DB,{userID:'other',name:'Other',username:null,email:'old@example.test'});
    expect(await env.DB.prepare('SELECT user_id FROM members WHERE id=?').bind(member).first('user_id')).toBeNull();
    await saveProfile(env.DB,{userID:'maya',name:'Maya',username:null,email:'maya@example.test'});
    const joined = await send('groups_show',{group},outsider);
    expect(await joined.json()).toMatchObject({members:expect.arrayContaining([expect.objectContaining({...owner,payment:{}}),
      expect.objectContaining({id:member,groupID:group,userID:'maya',name:'Maya',payment:{}})])});
    const history = await send('expenses_list',{group},outsider);
    expect(await history.json()).toMatchObject([{id:expense.id,splits:expense.splits}]);
    expect((await send('members_update',update)).status).toBe(422);
    expect((await send('invite',{group,member,email:'other@example.test'})).status).toBe(422);
  });

  it('uploads four full-size receipt photos over both MCP transports', async () => {
    const token = await authorize('alex');
    const outsider = await authorize('maya');
    const send = (name: string, args: object) => fetch('/v1/cli', {name, arguments: args}, token);
    const {id:group, members} = await (await send('groups_create', {name:'Trip', self:'Alex'})).json();
    const photo = btoa('\xff\xd8\xff' + '\x00'.repeat(240 * 1024 - 5) + '\xff\xd9');
    const args = {
      group, payer: members[0].id, title: 'Dinner',
      bill: {items: [{title:'Dinner', amount:'12.01'}], tax: '1.25'},
      photos: Array(4).fill(photo)
    };
    const headers = {Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'};
    const rpc = {jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'expenses_add', arguments:args}};
    const remote = await (await fetch('/mcp', rpc, token, headers)).json();
    const local = await (await send('expenses_add', args)).json();
    for (const entry of [JSON.parse(remote.result.content[0].text), local]) {
      expect(entry.amount).toBe(1326);
      expect(entry.receiptIDs).toHaveLength(4);
      const download = { name:'receipts_get', arguments:{group, expense:entry.id, photo:entry.receiptIDs[3]} };
      expect((await fetch('/v1/cli', download, outsider)).status).toBe(404);
      const response = await (await fetch('/mcp', {...rpc, params:download}, token, headers)).json();
      expect(response.result.content[0]).toEqual({type:'image', mimeType:'image/jpeg', data:photo});
    }
    expect((await send('expenses_add', {...args, amount:'12.00'})).status).toBe(422);
    expect((await send('expenses_edit', {group, expense:local.id, bill:args.bill})).status).toBe(422);
  });
  it('shows retained receipt photos and recurrence in an expense edit preview', async () => {
    const token = await authorize('alex');
    const send = (name: string, args: object) => fetch('/v1/cli', {name, arguments: args}, token);
    const {id:group, members} = await (await send('groups_create', {name:'Home', self:'Alex'})).json();
    const add = {group, payer:members[0].id, title:'Rent', amount:'25.00', category:'Rent',
      photos:[btoa('\xff\xd8\xff' + '\x00'.repeat(12) + '\xff\xd9')]};
    const invalid = await send('expenses_add', {...add, category:'food'});
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error).toMatch(/category.*Dining.*Other/);

    const {id:expense, receiptIDs} = await (await send('expenses_add', add)).json();
    expect(receiptIDs).toHaveLength(1);
    expect((await send('expenses_repeat', {group, expense, cadence:'monthly'})).status).toBe(200);
    const edit = {group, expense, title:'Apartment rent'};
    expect((await send('expenses_edit', {...edit, category:'housing'})).status).toBe(422);
    const review = await (await send('expenses_edit', edit)).json();
    const retained = {receiptIDs, recurrence:'monthly', category:'Rent'};
    expect(review.before).toMatchObject({...retained, title:'Rent'});
    expect(review.after).toMatchObject({...retained, title:'Apartment rent'});
    expect((await send('expenses_edit', {...edit, yes:true, revision:review.revision})).status).toBe(200);
    expect(await (await send('expenses_show', {group, expense})).json()).toMatchObject(review.after);
  });
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
    const args = {group,payer,participants:[payer,other],title:'Dinner',amount:'10.01',category:'Gifts'};
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
    const edit = {...target,category:'Shopping'};
    const review = await run('expenses_edit',edit);
    expect(review.before.category).toBe('Gifts');
    expect(review.after.category).toBe('Shopping');
    expect(await run('expenses_edit',{...edit,revision:review.revision,yes:true})).toEqual({
      applied:true, id:first.id, category:'Shopping'
    });
    expect((await run('expenses_show',target)).category).toBe('Shopping');
    await expect(run('expenses_delete',{...target,revision:preview.revision,yes:true})).rejects.toThrow('fresh preview');
    const fresh = await run('expenses_delete',target);
    await run('expenses_delete',{...target,revision:fresh.revision,yes:true});
    const request = await run('settle_up',{group,from:other,to:payer,amount:'7.01'},outsider);
    expect(request.status).toBe('pending');
    expect((await run('balances',{group})).find(b=>b.currency==='USD').settlements[0].amount).toBe(701);
    const approve = new Request('https://test/v1/settlements/'+request.id+'/approve',{method:'POST'});
    expect((await handle(approve,env,'alex')).status).toBe(200);
    const balances = await run('balances',{group});
    expect(balances.find(b=>b.currency==='USD').settlements).toEqual([]);
    expect(balances.find(b=>b.currency==='EUR').settlements[0].amount).toBe(751);
    expect(await run('activity',{group})).toHaveLength(3);
    expect(await run('expenses_list',{group})).toHaveLength(2);
    await expect(run('groups_list',{typo:'x'})).rejects.toThrow();
  });
  it('lets an agent upload a receipt with fractional shares, then list and assign items exactly to the cent', async () => {
    const token = await authorize('alex'), outsider = await authorize('maya');
    async function run(name:string, args:object, device=token) {
      const r = await fetch('/v1/cli',{name,arguments:args},device);
      const value = await r.json<any>();
      if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)),{status:r.status});
      return value;
    }
    const {id:group, members} = await run('groups_create',{name:'Trip',self:'Alex',placeholders:['Sam','Jo']});
    const [a,b,c] = members.map((m:{id:string})=>m.id);
    const plain = await run('expenses_add',{group,payer:a,title:'Groceries',amount:'10.01',participants:[a,b,c]});
    const whole = await run('items_list',{group,expense:plain.id});
    expect(whole.items).toHaveLength(1);
    expect(whole.items[0]).toMatchObject({title:'Groceries',amount:1001,gross:1001,open:false});
    expect(whole.items[0].portions.map(({memberID,amount}:{memberID:string;amount:number})=>({memberID,amount}))).toEqual(plain.splits);
    await expect(run('items_list',{group,expense:plain.id},outsider)).rejects.toMatchObject({status:404});
    const edit = {group,expense:plain.id,bill:{items:[
      {title:'Produce',amount:'3.34',memberIDs:[a]},
      {title:'Bread and cheese',amount:'6.67',memberIDs:[b,c]}]}};
    await expect(run('expenses_edit', edit, outsider)).rejects.toMatchObject({status:404});
    const preview = await run('expenses_edit', edit);
    expect(preview.after.splits).toEqual(plain.splits);
    await run('expenses_edit', {...edit,yes:true,revision:preview.revision});
    expect((await run('items_list',{group,expense:plain.id})).items.map((i:{gross:number})=>i.gross)).toEqual([334,667]);
    const entry = await run('expenses_add',{group,payer:a,title:'Parrilla',bill:{items:[
      {title:'Beers',amount:'24.00',memberIDs:[a,b],shares:[2,1]},
      {title:'Flan',amount:'10.00'},
      {title:'Steak',amount:'33.33'}],tax:'1.00'}});
    expect(entry.amount).toBe(6833);
    let list = await run('items_list',{group,expense:entry.id});
    expect(list.items.map((i:any)=>i.gross).reduce((x:number,y:number)=>x+y,0)).toBe(6833);
    expect(list.items[0].shares).toEqual({[a]:2,[b]:1});
    expect(list.items.filter((i:any)=>i.open)).toHaveLength(2);
    await run('items_claim',{group,expense:entry.id,item:list.items[1].id,member:c,share:'0.5'});
    await run('items_assign',{group,expense:entry.id,item:list.items[2].id,participants:[a,b,c],shares:[1,1,1.5]});
    list = await run('items_list',{group,expense:entry.id});
    expect(list.items.every((i:any)=>!i.open)).toBe(true);
    expect(list.items[2].shares).toEqual({[a]:1,[b]:1,[c]:1.5});
    const saved = (await run('expenses_list',{group})).find((e:any)=>e.id===entry.id);
    expect(saved.splits.reduce((s:number,p:{amount:number})=>s+p.amount,0)).toBe(6833);
    await run('items_assign',{group,expense:entry.id,item:list.items[2].id,participants:[b]});
    list = await run('items_list',{group,expense:entry.id});
    expect(list.items[2].memberIDs).toEqual([b]); expect(list.items[2].shares).toBeUndefined();
    await expect(run('items_assign',{group,expense:entry.id,item:list.items[2].id,participants:[a,b],shares:[1]})).rejects.toMatchObject({status:422});
    await expect(run('items_list',{group,expense:entry.id},outsider)).rejects.toMatchObject({status:404});
  });
  it('covers every web action: settings, people, invites, comments, likes, photos, multi-payer, export and import', async () => {
    const token = await authorize('alex'), outsider = await authorize('maya');
    async function run(name:string, args:object, device=token) {
      const r = await fetch('/v1/cli',{name,arguments:args},device);
      const value = await r.json<any>();
      if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)),{status:r.status});
      return value;
    }
    const {id:group, members} = await run('groups_create',{name:'Lisbon',self:'Alex',placeholders:['Sam','Jo','Cancelled'],start:'2026-12-01',end:'2026-12-05',description:'Pasteis'});
    const [a,b,c,d] = members.map((m:{id:string})=>m.id);
    expect(await run('groups_show',{group})).toMatchObject({description:'Pasteis',startDate:'2026-12-01',endDate:'2026-12-05'});
    await run('groups_update',{group,name:'Lisbon 2026',end:'none',simplify:'off'});
    expect(await run('groups_show',{group})).toMatchObject({name:'Lisbon 2026',startDate:'2026-12-01'});
    expect((await run('groups_show',{group})).endDate).toBeUndefined();
    await expect(run('groups_update',{group,name:'x'},outsider)).rejects.toMatchObject({status:404});

    const dinner = await run('expenses_add',{group,title:'Dinner, "late"',amount:'100.00',payer:a,payers:[{member:a,amount:'60.00'},{member:b,amount:'40.00'}],participants:[a,b,c],category:'Dining',notes:'=SUM(A1)'});
    expect(dinner.payers).toEqual([{memberID:a,amount:6000},{memberID:b,amount:4000}]);
    await expect(run('expenses_add',{group,title:'Bad',amount:'10.00',payer:a,payers:[{member:a,amount:'5.00'}]})).rejects.toMatchObject({status:422});

    const photo = btoa('\xff\xd8\xff' + '\x00'.repeat(64) + '\xff\xd9');
    await expect(run('receipts_add',{group,expense:dinner.id,photos:[btoa('%PDF-1.7 test receipt')]})).rejects.toThrow('PDF receipts are unsupported');
    const attached = await run('receipts_add',{group,expense:dinner.id,photos:[photo]});
    expect(await run('receipts_list',{group,expense:dinner.id})).toEqual(attached.attached);

    const comment = await run('comments_add',{group,expense:dinner.id,text:'I had the wine'});
    await run('expenses_like',{group,expense:dinner.id});
    const shown = await run('expenses_show',{group,expense:dinner.id});
    expect(shown.comments).toHaveLength(1);
    expect(shown.payerNames.map((p:any)=>p.name)).toEqual(['Alex','Sam']);
    await run('comments_delete',{group,expense:dinner.id,comment:comment.id});
    expect(await run('comments_list',{group,expense:dinner.id})).toHaveLength(0);

    await run('invite',{group});
    await run('invite',{group,member:c});
    const {invites} = await run('invites_list',{group});
    expect(invites).toHaveLength(2);
    await run('invites_revoke',{group,invite:invites[0].id});
    expect((await run('invites_list',{group})).invites).toHaveLength(1);

    await run('members_remove',{group,member:d,mode:'delete'});
    await expect(run('members_remove',{group,member:b,mode:'delete'})).rejects.toMatchObject({status:409});
    await run('members_remove',{group,member:b});
    expect((await run('members_list',{group})).find((m:any)=>m.id===b).removed).toBeTruthy();
    await run('members_remove',{group,member:b,mode:'restore'});

    const ledger = await run('groups_export',{group});
    expect(ledger.content).toContain('"Dinner, ""late"""');
    expect(ledger.content).toContain("'=SUM(A1)");
    expect(ledger.content.split('\r\n')[1]).toMatch(/26\.6[67],6\.6[67],-33\.33/);
    const summary = await run('groups_export',{group,format:'summary'});
    expect(summary.content).toMatch(/USD,Alex,active,60\.00,33\.3[34],26\.6[67]/);
    const full = JSON.parse((await run('groups_export',{group,format:'json'})).content);
    expect(full.entries[0].receiptIDs).toHaveLength(1);
    await expect(run('groups_export',{group},outsider)).rejects.toMatchObject({status:404});

    await run('profile_avatar',{avatar:'preset:ocean'});
    await run('groups_archive',{group});
    await run('groups_archive',{group,action:'restore'});
    expect((await run('groups_leave',{group})).preview).toBe(true);

    const preview = await run('import_splitwise',{csv:tripCSV,file:'buenos-aires-trip_2026-11-18_export.csv'});
    expect(preview.preview).toBe(true);
    const imported = await run('import_splitwise',{csv:tripCSV,file:'buenos-aires-trip_2026-11-18_export.csv',me:preview.members[0]});
    expect(imported.inserted).toBeGreaterThan(0);
    await expect(run('import_splitwise',{csv:tripCSV,me:'Nobody'})).rejects.toMatchObject({status:422});
  });
  it('previews and imports localized, friend, resaved and edited Splitwise exports through the CLI', async () => {
    const token = await authorize('alex');
    const fixtures = [
      ['piso-compartido_2026-11-18_export.csv', pisoCSV, 'José Núñez'],
      ['wg-kasse_2026-11-18_export.csv', wgCSV, 'Person1'],
      ['friend-maya_2026-11-18_export.csv', friendCSV, 'Alex'],
      ['excel-resaved.csv', excelCSV, 'Alex'],
      ['edited-totals_export.csv', editedCSV, 'Harris'],
    ];
    for (const [file, csv, me] of fixtures) {
      const run = (args: object) => fetch('/v1/cli', { name: 'import_splitwise', arguments: { file, csv, ...args } }, token);
      const preview = await run({});
      expect(preview.status, file).toBe(200);
      const result = await preview.json<{ preview: boolean; members: string[]; rows: number }>();
      expect(result.preview, file).toBe(true);
      expect(result.members, file).toContain(me);
      expect(result.rows, file).toBeGreaterThan(0);
      const imported = await run({ me });
      expect(imported.status, file).toBe(200);
      expect(await imported.json(), file).toMatchObject({ created: true, inserted: result.rows });
    }
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
  it('searches people, sends an invitation and lets only the recipient accept it from the CLI', async () => {
    const alex = await authorize('cli-alex'), pat = await authorize('cli-pat'), sam = await authorize('cli-sam');
    async function run(name: string, args: object, device = alex): Promise<any> {
      const r = await fetch('/v1/cli', { name, arguments: args }, device);
      const value = await r.json();
      if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: r.status });
      return value;
    }
    await saveProfile(env.DB, { userID: 'cli-pat', name: 'Pat Rivera', username: 'pat', email: 'pat@example.test' });
    const { id: group } = await run('groups_create', { name: 'Ski', self: 'Alex' });
    const [found] = await run('members_lookup', { query: 'riv' });
    expect(found).toEqual({ userID: 'cli-pat', name: 'Pat Rivera' });
    expect(await run('people_show', { user: 'cli-pat' })).toEqual({ userID: 'cli-pat', name: 'Pat Rivera', sharedGroups: [] });
    const { id } = await run('members_invite', { group, user: found.userID });
    expect(await run('invitations_list', {}, pat)).toMatchObject({ invitations: [{ id, groupName: 'Ski', kind: 'direct' }] });
    await expect(run('invitations_accept', { invitation: id }, sam)).rejects.toMatchObject({ status: 404 });
    expect(await run('invitations_accept', { invitation: id }, pat)).toEqual({ ok: true, groupID: group });
    expect((await run('members_list', { group })).map((m: any) => m.name)).toContain('Pat Rivera');
    expect(await run('profile_discoverable', {}, pat)).toEqual({ discoverable: true });
    expect(await run('profile_discoverable', { discoverable: 'off' }, pat)).toEqual({ discoverable: false });
    expect(await run('members_lookup', { query: 'pat@example.test' })).toEqual([]);
  });
});
