import {env} from 'cloudflare:test';
import {describe,it,expect,beforeEach} from 'vitest';
import {handle} from '../src/index';
import {generateRecurring,nextDate} from '../src/groupTools';
import {transferPlan} from '../src/settle';
import {balances,Entry} from '../src/ledger';
import {settlementEntry} from '../src/exchange';

const group='group-tools',owner='owner-001',guest='guest-001';
const path='/v1/groups/'+group+'/';
const entry:Entry={id:'weekly-meal',groupID:group,title:'Lunch',amount:1000,currency:'ARS',paidBy:owner,splits:[{memberID:owner,amount:400},{memberID:guest,amount:600}],kind:'expense',splitMode:'exact',createdAt:'2025-01-31T12:00:00Z'};
async function call(p:string,b?:unknown,user='owner') {
  return (await handle(new Request(env.APP_URL+p,b===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}),env,user)).json<any>();
}
beforeEach(async()=>{
  await call('/v1/groups',{id:group,name:'Home',kind:'home',currency:'ARS',members:[{id:owner,name:'Alex',userID:'owner'},{id:guest,name:'May'}]});
  await call('/v1/entries',entry);
});
describe('Group tools',()=>{
  it('finds independent balanced components and orders a permuted ledger identically',()=>{
    const values={a:-9,b:-8,c:-6,d:-4,e:17,f:10};
    const plan=transferPlan(values);
    expect(plan.length).toBe(4);
    expect(transferPlan(Object.fromEntries(Object.entries(values).reverse()))).toEqual(plan);
    const v:Record<string,number>={...values};
    for(const p of plan){v[p.from]+=p.amount;v[p.to]-=p.amount;}
    expect(Object.values(v)).toEqual([0,0,0,0,0,0]);
  });
  it('converts once with a fixed rate and allocates the rounded amount without drift',async()=>{
    const fx={target:'ARS',rateE8:103950000000,source:'Manual',date:'2025-01-10'};
    const expense={...entry,id:'foreign-001',currency:'USD',amount:101,splits:[{memberID:owner,amount:51},{memberID:guest,amount:50}],exchange:fx};
    await call('/v1/entries',expense);
    expect(settlementEntry(expense).amount).toBe(104990);
    expect(balances([expense],'USD')).toEqual({});
    expect(Object.values(balances([expense],'ARS')).reduce((a,b)=>a+b)).toBe(0);
    await expect(call('/v1/entries',{...expense,id:'wrong-fx',exchange:{...fx,target:'GBP'}})).rejects.toThrow('group settlement');
  });
  it('only updates the signed-in member’s payment profile and validates defaults',async()=>{
    await expect(call(path+'payment-profile',{paypal:'someone'},'stranger')).rejects.toThrow('Join');
    await expect(call(path+'payment-profile',{mercado:'https://example.com/pay'})).rejects.toThrow('handles');
    await call(path+'payment-profile',{memberID:guest,paypal:'Alex',alias:'alex.expenses'});
    await call(path+'default-split',{weights:{[owner]:2,[guest]:1}});
    await expect(call(path+'default-split',{weights:{someone:5}})).rejects.toThrow('weights');
    const [g]=(await call('/v1/snapshot')).groups;
    expect(g.defaultWeights).toEqual({[owner]:2,[guest]:1});
    expect(g.members.find((m:any)=>m.id===owner).payment.paypal).toBe('Alex');
    expect(g.members.find((m:any)=>m.id===guest).payment).toEqual({});
  });
  it('retries a due occurrence once, honors month boundaries, and cancels on deletion',async()=>{
    await call(path+'repeat',{entryID:entry.id,cadence:'monthly'});
    await env.DB.prepare("UPDATE recurring SET due='2024-02-29',anchor=31").run();
    await Promise.all([generateRecurring(env.DB,'2024-02-29'),generateRecurring(env.DB,'2024-02-29')]);
    expect((await call('/v1/snapshot')).entries).toHaveLength(2);
    expect(await env.DB.prepare('SELECT due FROM recurring').first('due')).toBe('2024-03-31');
    expect(nextDate('2024-02-29','yearly',29)).toBe('2025-02-28');
    await call('/v1/entries/'+entry.id+'/delete',{});
    await generateRecurring(env.DB,'2030-01-01');
    expect((await call('/v1/snapshot')).entries).toHaveLength(1);
  });
  it('previews locally then commits rows and new placeholders atomically and idempotently',async()=>{
    const row={title:'Coffee',day:'2025-01-31',payer:'Alex',amount:901,currency:'USD',splits:[{name:'May',amount:451},{name:'New guest',amount:450}]};
    await expect(call(path+'import',{rows:[row,{...row,amount:900}]})).rejects.toThrow();
    expect((await call('/v1/snapshot')).groups[0].members).toHaveLength(2);
    expect(await call(path+'import',{rows:[row]})).toEqual({inserted:1});
    expect(await call(path+'import',{rows:[row]})).toEqual({inserted:0});
    const snap=await call('/v1/snapshot');
    expect(snap.entries).toHaveLength(2);
    expect(snap.groups[0].members).toHaveLength(3);
  });
});
