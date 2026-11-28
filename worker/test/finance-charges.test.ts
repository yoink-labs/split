import {env} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import worker, {handle} from '../src/index';
import {manageDevices} from '../src/cli/devices';
import {Entry} from '../src/ledger';

const group='fx-group',alexSeat='seat-alex-fx',mayaSeat='seat-maya-fx';
const call=(user:string,path:string,b?:unknown)=>handle(new Request(env.APP_URL+path,b===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env,user);
const dinner:Entry={id:'fx-dinner',groupID:group,title:'Café Azul dinner',amount:25000,currency:'BRL',paidBy:alexSeat,
  splits:[{memberID:alexSeat,amount:5000},{memberID:mayaSeat,amount:20000}],kind:'expense',splitMode:'exact',createdAt:'2026-11-20T12:00:00Z',
  exchange:{target:'USD',rateE8:18_560_000,date:'2026-11-20',source:'Manual'}};
const request=(path:string,data?:unknown,token?:string,headers:Record<string,string>={})=>new Request(env.APP_URL+path,{
  method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},
  body:data===undefined?undefined:JSON.stringify(data)});
const send=(path:string,data?:unknown,token?:string,headers?:Record<string,string>)=>worker.fetch(request(path,data,token,headers),env);
async function connect(user:string,capabilities?:string[]) {
  const started=await send('/v1/device/start',{name:'Finance',scope:'finance',...(capabilities?{capabilities}:{})});
  expect(started.status).toBe(201);
  const {code,device}=await started.json<{code:string;device:string}>();
  const review=await (await manageDevices(request('/v1/device/review',{code}),env,user)).json();
  expect(review).toEqual(capabilities
    ? {name:'Finance (reads expenses, updates card charges)',scope:'finance',capabilities}
    : {name:'Finance (read-only)',scope:'finance'});
  await manageDevices(request('/v1/device/approve',{code}),env,user);
  return (await (await send('/v1/device/poll',{device})).json<{token:string}>()).token;
}
const charge='/v1/integrations/finance/expenses/'+dinner.id+'/charge';
const body={chargedAmount:4682,chargedCurrency:'USD',rateE8:18_728_000,basis:{amount:25000,currency:'BRL',statementAmount:4640}};
const key=(n:string)=>({'Idempotency-Key':'ledgerly-charge-'+n.padEnd(20,'0')});

beforeEach(async()=>{
  await call('alex','/v1/groups',{id:group,name:'Rio',kind:'trip',currency:'USD',members:[{id:alexSeat,name:'Alex',userID:'alex'},{id:mayaSeat,name:'Maya'}]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('maya',mayaSeat).run();
  expect((await call('alex','/v1/entries',dinner)).status).toBe(200);
});

it('keeps existing Finance connections read-only and rejects unknown capabilities', async()=>{
  const token=await connect('alex');
  expect(await (await send('/v1/integrations/finance/capabilities',undefined,token)).json()).toEqual({capabilities:[]});
  const refused=await send(charge,body,token,key('a'));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({code:'scope_required'});
  expect((await send('/v1/device/start',{name:'x',scope:'finance',capabilities:['ledger:write']})).status).toBe(422);
  expect((await send('/v1/device/start',{name:'x',scope:'cli',capabilities:['charges:write']})).status).toBe(422);
});

it('sets the card charge as the statement amount, re-spreads shares, records history, and replays by key', async()=>{
  const token=await connect('alex',['charges:write']);
  expect(await (await send('/v1/integrations/finance/capabilities',undefined,token)).json()).toEqual({capabilities:['charges:write']});
  const listed=await (await send('/v1/integrations/finance/expenses',undefined,token)).json<{expenses:{conversion:unknown;exchange:unknown}[]}>();
  expect(listed.expenses[0]).toMatchObject({conversion:{currency:'USD',total:4640,paid:4640,share:928},exchange:{target:'USD',source:'Manual'}});

  expect((await send(charge,body,token)).status).toBe(422);
  expect(await (await send(charge,{...body,rateE8:1},token,key('rate'))).json()).toMatchObject({code:'invalid'});
  const applied=await send(charge,body,token,key('first'));
  expect(applied.status).toBe(200);
  const result=await applied.json();
  expect(result).toEqual({applied:true,expense:{id:dinner.id,exchange:{target:'USD',rateE8:18_728_000,date:'2026-11-20',source:'Statement',statementAmount:4682},
    conversion:{currency:'USD',total:4682,paid:4682,share:936}}});
  const saved=(await (await call('alex','/v1/snapshot')).json<{entries:Entry[]}>()).entries.find(e=>e.id===dinner.id)!;
  expect(saved.splits).toEqual(dinner.splits);
  expect(saved.exchange).toMatchObject({source:'Statement',statementAmount:4682});
  const history=await env.DB.prepare('SELECT previous_amount,charged_currency,charged_amount FROM charged_amount_history WHERE entry_id=?').bind(dinner.id).all();
  expect(history.results).toEqual([{previous_amount:null,charged_currency:'USD',charged_amount:4682}]);
  const audit=await env.DB.prepare('SELECT user_id,previous_amount,charged_amount,rate_e8 FROM finance_charge_updates WHERE entry_id=?').bind(dinner.id).all();
  expect(audit.results).toEqual([{user_id:'alex',previous_amount:4640,charged_amount:4682,rate_e8:18_728_000}]);

  const replay=await send(charge,body,token,key('first'));
  expect(await replay.json()).toEqual({...result,applied:false});
  expect(await (await send(charge,{...body,chargedAmount:4683,rateE8:18_732_000},token,key('first'))).json()).toMatchObject({code:'idempotency_conflict'});
  const stale=await send(charge,body,token,key('second'));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({code:'expense_changed'});
  expect((await env.DB.prepare('SELECT count(*) n FROM finance_charge_updates').first<{n:number}>())!.n).toBe(1);
});

it('refuses expenses the viewer did not pay in full or did not record, and USD expenses', async()=>{
  const maya=await connect('maya',['charges:write']);
  expect(await (await send(charge,body,maya,key('maya'))).json()).toMatchObject({code:'not_sole_payer'});
  const alex=await connect('alex',['charges:write']);
  await call('alex','/v1/entries',{...dinner,id:'usd-lunch',currency:'USD',exchange:undefined});
  expect(await (await send('/v1/integrations/finance/expenses/usd-lunch/charge',{...body,basis:{amount:25000,currency:'USD',statementAmount:null}},alex,key('usd'))).json())
    .toMatchObject({code:'same_currency'});
  expect(await (await send('/v1/integrations/finance/expenses/missing-entry/charge',body,alex,key('missing'))).json()).toMatchObject({code:'expense_not_found'});
  // Every other Finance write is still refused.
  expect((await send('/v1/integrations/finance/expenses',{},alex)).status).toBe(403);
  expect((await send('/v1/entries/'+dinner.id+'/delete',{},alex)).status).toBe(403);
});
