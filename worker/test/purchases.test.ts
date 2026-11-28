import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import worker, {handle} from '../src/index';
import {manageDevices} from '../src/cli/devices';
import {operate} from '../src/cli/operations';
import {Entry} from '../src/ledger';
import {Bill,breakdown,grossItems,itemSplit} from '../src/items';

const group='receipt-group',payer='seat-alex',other='seat-maya',guest='seat-jules';
function call(user:string,path:string,b?:unknown) {
  return handle(new Request(env.APP_URL+path,b===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env,user);
}
const bill:Bill={items:[{id:'line-coffee',title:'Coffee',amount:501,memberIDs:[payer,other]},
  {id:'line-toast',title:'Toast',amount:999,memberIDs:[]}],tax:101,tip:200,closed:false};
const e:Entry={id:'receipt-entry',groupID:group,title:'Brunch',amount:1801,currency:'USD',paidBy:payer,
  splits:itemSplit(bill,payer),kind:'expense',splitMode:'exact',createdAt:'2026-11-17T12:00:00Z',category:'Dining',bill};
const base='/v1/entries/'+e.id;
const photo={id:'photo-test',data:btoa(String.fromCharCode(255,216,255,224,0,8,255,217))};
async function snapshot(user='alex') {return (await (await call(user,'/v1/snapshot')).json<{entries:Entry[]}>()).entries[0];}
beforeEach(async()=>{
  await call('alex','/v1/groups',{id:group,name:'Weekend',kind:'trip',currency:'USD',members:[{id:payer,name:'Alex',userID:'alex'},{id:other,name:'Maya'},{id:guest,name:'Jules'}]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('maya',other).run();
});
it('conserves cents including open items and excludes settlements from spending',()=>{
  expect(grossItems(bill).map(i=>i.gross)).toEqual([602,1199]);
  expect(e.splits).toEqual([{memberID:payer,amount:1500},{memberID:other,amount:301}]);
  const report=breakdown([e,{...e,kind:'settlement',amount:100,paidBy:other,splits:[{memberID:payer,amount:100}]}],[{id:payer,name:'Alex'},{id:other,name:'Maya'}],'USD');
  expect(report).toMatchObject({total:1801,months:{'2026-11':1801},categories:{Dining:1801},members:[{paid:1801,share:1500,net:201},{paid:0,share:301,net:-201}]});
});
it('shares, reopens and closes remaining purchases, rejecting stale and outsider claims',async()=>{
  await call('alex','/v1/entries',e);
  const claim={itemID:'line-toast',memberIDs:[other,guest],original:[]};
  await expect(call('outsider',base+'/claim',claim)).rejects.toThrow('not found');
  await expect(call('maya',base+'/claim',{...claim,memberIDs:['foreign-seat']})).rejects.toThrow('group members');
  expect((await snapshot()).bill?.closed).toBe(false);
  const closed = await call('maya',base+'/claim',claim);
  expect(await closed.json()).toEqual({ok:true,closed:true});
  expect((await snapshot()).bill?.closed).toBe(true);
  const activity = () => env.DB.prepare("SELECT data FROM email_activity WHERE kind='receiptStatus' AND user_id='alex' ORDER BY rowid").all<{data:string}>();
  expect((await activity()).results.map(r=>JSON.parse(r.data).variant)).toEqual(['closed']);
  await expect(call('alex',base+'/claim',{...claim,memberIDs:[payer]})).rejects.toThrow('claims changed');
  expect((await snapshot()).splits).toEqual([{memberID:payer,amount:301},{memberID:other,amount:901},{memberID:guest,amount:599}]);
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-28T00:00:00Z',other).run();
  await expect(call('maya',base+'/claim',{...claim,original:[other,guest],memberIDs:[]})).rejects.toThrow('not found');
  await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(other).run();
  await call('maya',base+'/claim',{...claim,original:[other,guest],memberIDs:[]});
  expect((await snapshot()).bill?.closed).toBe(false);
  expect((await activity()).results.map(r=>JSON.parse(r.data).variant)).toEqual(['closed','reopened']);
  const cmd=(name:string,args:object,user='alex')=>operate(name,{group,...args},env,user,handle);
  expect(await cmd('items_open',{})).toMatchObject([{gross:1199}]);
  await cmd('items_claim',{expense:e.id,item:'line-toast'},'maya');
  expect(await cmd('items_open',{})).toEqual([]);
  await cmd('items_claim',{expense:e.id,item:'line-toast',action:'remove'},'maya');
  await expect(call('maya',base+'/close',{memberIDs:[other]})).rejects.toThrow('Only the payer');
  await cmd('items_close',{expense:e.id,participants:[guest]});
  expect((await snapshot('maya')).bill).toMatchObject({closed:true,items:[{memberIDs:[payer,other]},{memberIDs:[guest]}]});
  expect(await cmd('items_close',{expense:e.id,participants:[guest]})).toEqual({ok:true,closed:true});
  await expect(call('alex',base+'/claim',claim)).rejects.toThrow('claims changed');
});
it('closes fully assigned bills at creation and reopens them when an author edits in an open item',async()=>{
  const full={...bill,items:[bill.items[0],{...bill.items[1],memberIDs:[other]}]};
  const assigned={...e,bill:full,splits:itemSplit(full,payer)};
  await expect(call('alex','/v1/entries',{...assigned,amount:e.amount+1,
    splits:[{memberID:other,amount:e.amount+1}]})).rejects.toThrow('match the expense total');
  await call('alex','/v1/entries',assigned);
  const original=await snapshot();
  expect(original.bill?.closed).toBe(true);
  // A client may retain its original closed flag when adding an unassigned item.
  const edit={...original,bill:{...bill,closed:true},splits:e.splits};
  await expect(call('maya',base+'/edit',{original,entry:edit})).rejects.toThrow('recorded');
  await call('alex',base+'/edit',{original,entry:edit});
  expect((await snapshot()).bill?.closed).toBe(false);
});

it('stores photos atomically and privately, handles retries, caps attachments and frees bytes on delete',async()=>{
  await expect(call('alex','/v1/entries',{...e,photos:[{...photo,data:'invalid'}]})).rejects.toThrow();
  expect(await snapshot()).toBeUndefined();
  const data={...e,photos:[photo]};
  await call('alex','/v1/entries',data); await call('alex','/v1/entries',data);
  expect((await snapshot('maya')).receiptIDs).toEqual([photo.id]);
  const path=base+'/receipts/'+photo.id;
  await expect(call('outsider',path)).rejects.toThrow('not found');
  const image=await call('maya',path);
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([255,216,255,224,0,8,255,217]);
  expect(image.headers.get('cache-control')).toContain('no-store');
  const extras=[1,2,3,4].map(i=>({...photo,id:'another-photo-'+i}));
  await expect(call('alex',base+'/edit',{original:e,entry:{...e,title:'Updated'},photos:extras})).rejects.toThrow();
  expect((await snapshot()).title).toBe(e.title);
  await call('alex',base+'/delete',{});
  await expect(call('maya',path)).rejects.toThrow('not found');
  expect(await env.DB.prepare('SELECT bytes FROM receipt_usage').first('bytes')).toBe(0);
});
it('retains both historical shares and rounding order when a placeholder merges into another claimant',async()=>{
  const shared={...bill,items:[{...bill.items[0],memberIDs:[other,payer,guest]},bill.items[1]]};
  const before={...e,bill:shared,splits:itemSplit(shared,payer)};
  await call('alex','/v1/entries',before);
  await env.DB.prepare('INSERT INTO member_aliases VALUES (?,?)').bind(guest,other).run();
  const after=await snapshot();
  expect(after.bill?.items[0].memberIDs).toEqual([other,payer]);
  const paidShare=before.splits.find(p=>p.memberID===payer)!.amount;
  expect(after.splits.find(p=>p.memberID===payer)?.amount).toBe(paidShare);
  await call('alex',base+'/edit',{original:after,entry:{...after,title:'Updated receipt'}});
  await call('maya',base+'/claim',{original:[other,payer],itemID:shared.items[0].id,memberIDs:[other]});
  expect((await snapshot()).bill?.items[0].roundingSeats).toBeUndefined();
});
it('merges a claimant draft onto a different member’s saved edit',async()=>{
  await call('alex','/v1/entries',e);
  await call('maya',base+'/claim',{itemID:'line-toast',original:[],memberIDs:[other],mergeEdits:true});
  await call('alex',base+'/claim',{itemID:'line-toast',original:[],memberIDs:[guest],mergeEdits:true});
  expect((await snapshot()).bill?.items[1].memberIDs).toEqual([other,guest]);
});

it('exposes only the viewer’s expenses and photos to a revocable Finance connection', async () => {
  await call('alex','/v1/entries',{...e,photos:[photo]});
  const payerOnly = {
    ...e, id:'payer-only', bill:undefined, splits:[{memberID:payer,amount:e.amount}], photos:[photo],
  };
  await call('alex','/v1/entries',payerOnly);
  await call('alex','/v1/entries',{
    ...payerOnly, id:'no-receipt', title:'Groceries', photos:undefined,
    splits:[{memberID:payer,amount:900},{memberID:other,amount:901}],
  });
  await call('alex','/v1/entries',{
    ...payerOnly, id:'settlement-entry', kind:'settlement', photos:undefined, category:undefined,
    splits:[{memberID:other,amount:e.amount}],
  });

  const request = (path:string, data?:unknown, token?:string) => new Request(env.APP_URL+path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer '+token } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const send = (path:string, data?:unknown, token?:string) => worker.fetch(request(path,data,token),env);
  async function connect(user:string, scope='finance') {
    const started = await send('/v1/device/start',{name:'Local test',scope});
    expect(started.status).toBe(201);
    const {code,device} = await started.json<{code:string;device:string}>();
    if (scope==='finance') {
      const review = await manageDevices(request('/v1/device/review',{code}),env,user);
      expect(await review.json()).toEqual({name:'Finance (read-only)',scope});
    }
    expect((await send('/v1/device/poll',{device})).status).toBe(202);
    await manageDevices(request('/v1/device/approve',{code}),env,user);
    return (await (await send('/v1/device/poll',{device})).json<{token:string}>()).token;
  }

  const token = await connect('maya'), outsider = await connect('outsider'), cli = await connect('maya','cli');
  expect(token).toMatch(/^sfi_/);
  const base = '/v1/integrations/finance';
  const list = base+'/expenses';
  const receipt = base+'/receipts/'+e.id+'/'+photo.id;
  const result = await (await send(list,undefined,token)).json<{total:number;expenses:Entry[]}>();
  expect(result.total).toBe(2);
  expect(result.expenses.map(x=>x.id).sort()).toEqual(['no-receipt',e.id]);
  expect(await (await send(list+'?receipts=1&q=coffee',undefined,token)).json()).toMatchObject({
    total:1,expenses:[{id:e.id,paid:0,share:301,group:'Weekend',receiptIDs:[photo.id],
      bill:{closed:false,items:[{title:'Coffee',mine:true,share:301},{title:'Toast',mine:false,share:0}]}}],
  });
  expect(await (await send(list,undefined,outsider)).json()).toMatchObject({total:0});
  expect((await send(list,undefined,cli)).status).toBe(403);
  const image = await send(receipt,undefined,token);
  expect(image.status).toBe(200);
  expect(image.headers.get('cache-control')).toContain('no-store');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from(atob(photo.data),c=>c.charCodeAt(0)));
  expect((await send(receipt,undefined,outsider)).status).toBe(404);
  expect((await send(base+'/receipts/'+payerOnly.id+'/'+photo.id,undefined,token)).status).toBe(404);
  expect((await send('/v1/cli',{name:'groups_list'},token)).status).toBe(403);
  expect((await send('/mcp',{},token)).status).toBe(403);
  expect((await send(list,{},token)).status).toBe(403);
  // Every other write or ledger path stays closed to a Finance token.
  for (const method of ['PUT','PATCH','DELETE']) {
    expect((await worker.fetch(new Request(env.APP_URL+list,{method,headers:{Authorization:'Bearer '+token}}),env)).status).toBe(403);
  }
  expect((await send('/v1/entries',{...e,id:'finance-write'},token)).status).toBe(403);
  expect((await send('/v1/entries/'+e.id+'/claim',{itemID:'line-toast',original:[],memberIDs:[payer]},token)).status).toBe(403);
  expect((await send('/v1/entries/'+e.id+'/delete',{},token)).status).toBe(403);
  expect((await send('/v1/snapshot',undefined,token)).status).toBe(403);
  expect((await send('/v1/entries/'+e.id+'/receipts/'+photo.id,undefined,token)).status).toBe(403);
  expect((await send(base+'/receipts/'+e.id+'/'+photo.id,{},token)).status).toBe(403);
  // A Finance token cannot approve a full-access computer or manage other tokens.
  const pending = await (await send('/v1/device/start',{name:'Escalation'})).json<{code:string;device:string}>();
  expect((await send('/v1/device/approve',{code:pending.code},token)).status).toBe(403);
  expect((await send('/v1/device/review',{code:pending.code},token)).status).toBe(403);
  expect((await send('/v1/device/poll',{device:pending.device})).status).toBe(202);
  expect((await send('/v1/device/tokens',undefined,token)).status).toBe(403);
  expect((await send('/v1/device/revoke',{id:'anything'},token)).status).toBe(403);
  expect((await send('/v1/device/start',{name:'x',scope:'admin'})).status).toBe(422);
  await call('alex','/v1/entries/'+e.id+'/delete',{});
  expect((await send(receipt,undefined,token)).status).toBe(404);
  expect((await send('/v1/device/logout',{},token)).status).toBe(200);
  expect((await send(list,undefined,token)).status).toBe(401);
});

it('lets an active non-payer explicitly reopen without changing cents or closing on a no-op', async () => {
  const full = {...bill,items:[bill.items[0],{...bill.items[1],memberIDs:[other]}]};
  await call('alex','/v1/entries',{...e,bill:full,splits:itemSplit(full,payer)});
  const closed = await snapshot();
  await expect(call('outsider',base+'/reopen',{})).rejects.toThrow('not found');
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-28T00:00:00Z',other).run();
  await expect(call('maya',base+'/reopen',{})).rejects.toThrow('not found');
  await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(other).run();

  expect(await operate('receipts_reopen',{group,expense:e.id},env,'maya',handle)).toEqual({ok:true,closed:false});
  const reopened = await snapshot();
  expect(reopened.bill).toEqual({...closed.bill,closed:false});
  expect(reopened.splits).toEqual(closed.splits);
  await call('maya',base+'/reopen',{});
  await call('maya',base+'/claim',{itemID:'line-toast',original:[other],memberIDs:[other],shares:{[other]:100}});
  await call('alex',base+'/edit',{original:reopened,entry:{...reopened,title:'Late brunch'}});
  expect((await snapshot()).bill?.closed).toBe(false);
  const activity = await env.DB.prepare("SELECT data FROM email_activity WHERE kind='receiptStatus' AND user_id='alex' ORDER BY rowid").all<{data:string}>();
  expect(activity.results.map(r=>JSON.parse(r.data).variant)).toEqual(['reopened']);

  await call('maya',base+'/claim',{itemID:'line-toast',original:[other],memberIDs:[other,guest]});
  expect((await snapshot()).bill?.closed).toBe(true);
});

it('applies receipt-wide changes atomically and conserves cents at each status transition', async () => {
  await call('alex','/v1/entries',e);
  const path=base+'/receipt-people';
  await expect(call('outsider',path,{add:[guest],remove:[]})).rejects.toThrow('not found');
  await expect(call('maya',path,{add:['foreign-seat'],remove:[]})).rejects.toThrow('group members');
  await expect(call('maya',path,{add:[guest],remove:[guest]})).rejects.toThrow('group members');
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-28T00:00:00Z',guest).run();
  await expect(call('maya',path,{add:[guest],remove:[]})).rejects.toThrow('group members');
  await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(guest).run();

  expect(await operate('receipts_people',{group,expense:e.id,add:[other],remove:[payer]},env,'maya',handle))
    .toEqual({ok:true,closed:true});
  const closed = await snapshot();
  expect(closed.bill?.items.map(i=>i.memberIDs)).toEqual([[other],[other]]);
  expect(closed.splits).toEqual([{memberID:other,amount:1801}]);

  await call('maya',path,{add:[],remove:[other]});
  const reopened = await snapshot();
  expect(reopened.bill?.closed).toBe(false);
  expect(reopened.splits).toEqual([{memberID:payer,amount:1801}]);

  await call('maya',path,{add:[payer,other,guest],remove:[]});
  expect((await snapshot()).splits).toEqual([
    {memberID:payer,amount:601},{memberID:other,amount:601},{memberID:guest,amount:599},
  ]);
});

it('allows only the author to edit people on a photo-only receipt', async () => {
  const {bill: _, ...standard}=e;
  await call('alex','/v1/entries',{...standard,photos:[photo]});
  await expect(call('maya',base+'/receipt-people',{add:[guest],remove:[]})).rejects.toThrow('recorded');
  await expect(call('alex',base+'/reopen',{})).rejects.toThrow('no items');
  await expect(call('alex',base+'/receipt-people',{add:[],remove:[payer,other]})).rejects.toThrow('one and fifty');
  await call('alex',base+'/receipt-people',{add:[guest],remove:[]});
  expect(await snapshot()).toMatchObject({splitMode:'equal',splits:[
    {memberID:payer,amount:601},{memberID:other,amount:600},{memberID:guest,amount:600},
  ]});
});
