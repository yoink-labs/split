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
  it('shares rates only inside the trip and leaves saved expense rates frozen',async()=>{
    const tripID='trip-rates', seat='trip-seat';
    await call('/v1/groups',{id:tripID,name:'Trip',kind:'trip',currency:'USD',members:[{id:seat,name:'Alex',userID:'owner'}]});
    const tripPath='/v1/groups/'+tripID+'/trip-rate';
    const rate={currency:'JPY',target:'USD',rateE8:700_000};
    await expect(call(tripPath,rate,'stranger')).rejects.toThrow('Join');
    await expect(call(path+'trip-rate',rate)).rejects.toThrow('Only active trip members');
    await expect(call(tripPath,{...rate,currency:'USD',rateE8:1})).rejects.toThrow('foreign currency');
    await expect(call(tripPath,{...rate,rateE8:0})).rejects.toThrow('valid rate');
    await call(tripPath,rate);
    let snap=await call('/v1/snapshot');
    expect(snap.groups.find((g:any)=>g.id===tripID).tripRates).toEqual({JPY:700_000});
    expect((await call('/v1/snapshot',undefined,'stranger')).groups).toEqual([]);

    const expense={...entry,id:'trip-expense',groupID:tripID,paidBy:seat,currency:'JPY',splits:[{memberID:seat,amount:1000}],
      exchange:{target:'USD',rateE8:700_000,date:'2025-01-31',source:'Trip'}};
    await call('/v1/entries',expense);
    await call(tripPath,{...rate,rateE8:800_000});
    snap=await call('/v1/snapshot');
    expect(snap.entries.find((e:Entry)=>e.id===expense.id).exchange.rateE8).toBe(700_000);
    await env.DB.prepare("UPDATE members SET removed_at='2025-02-01' WHERE id=?").bind(seat).run();
    await expect(call(tripPath,{...rate,rateE8:null})).rejects.toThrow('Only active trip members');
    await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(seat).run();
    await call(tripPath,{...rate,rateE8:null});
    expect((await call('/v1/snapshot')).groups.find((g:any)=>g.id===tripID).tripRates).toBeUndefined();
  });
  it('clears trip rates when the settlement currency changes and rejects stale settings',async()=>{
    const tripID='change-currency-trip', tripPath='/v1/groups/'+tripID+'/';
    await call('/v1/groups',{id:tripID,name:'Trip',kind:'trip',currency:'USD',members:[{id:'currency-seat',name:'Alex',userID:'owner'}]});
    const rate={currency:'JPY',target:'USD',rateE8:700_000};
    await call(tripPath+'trip-rate',rate);
    await call(tripPath+'update',{name:'Renamed trip'});
    let snapshot=await call('/v1/snapshot');
    expect(snapshot.groups.find((g:any)=>g.id===tripID).tripRates).toEqual({JPY:700_000});

    await call(tripPath+'update',{currency:'EUR'});
    snapshot=await call('/v1/snapshot');
    const trip=snapshot.groups.find((g:any)=>g.id===tripID);
    expect(trip.currency).toBe('EUR');
    expect(trip.tripRates).toBeUndefined();
    await expect(call(tripPath+'trip-rate',rate)).rejects.toThrow('trip currency changed');
    await call(tripPath+'trip-rate',{...rate,target:'EUR'});
    expect((await call('/v1/snapshot')).groups.find((g:any)=>g.id===tripID).tripRates).toEqual({JPY:700_000});
  });
  it('loads trip snapshots before the migration is applied',async()=>{
    const tripID='before-migration';
    await call('/v1/groups',{id:tripID,name:'Trip',kind:'trip',currency:'USD',members:[{id:'migration-seat',name:'Alex',userID:'owner'}]});
    await env.DB.prepare('ALTER TABLE trip_exchange_rates RENAME TO test_trip_rates').run();
    try {
      const trip=(await call('/v1/snapshot')).groups.find((g:any)=>g.id===tripID);
      expect(trip.currency).toBe('USD');
      expect(trip.tripRates).toBeUndefined();
    } finally {
      await env.DB.prepare('ALTER TABLE test_trip_rates RENAME TO trip_exchange_rates').run();
    }
  });
  it('keeps the exact posted total and accepts a published rate newer than the charge',async()=>{
    const charge={...entry,id:'statement-charge',currency:'USD',amount:1_000_000_001,
      splits:[{memberID:owner,amount:500_000_000},{memberID:guest,amount:500_000_001}],
      exchange:{target:'ARS',rateE8:100_000_000,date:'2025-01-31',source:'Statement',statementAmount:1_000_000_004}};
    await call('/v1/entries',charge);
    const saved=(await call('/v1/snapshot')).entries.find((e:Entry)=>e.id===charge.id);
    expect(saved.exchange.statementAmount).toBe(1_000_000_004);
    expect(settlementEntry(saved).amount).toBe(1_000_000_004);
    expect(settlementEntry(saved).splits.map(s=>s.amount)).toEqual([500_000_001,500_000_003]);
    await call('/v1/entries',{...charge,id:'fallback-charge',exchange:{target:'ARS',rateE8:50_000_000,date:'2025-02-01',source:'Frankfurter blended'}});
    await expect(call('/v1/entries',{...charge,id:'invalid-statement',exchange:{...charge.exchange,statementAmount:-1}})).rejects.toThrow('statement');
  });
  it('preserves a statement total when an older client edits the expense',async()=>{
    const charge={...entry,id:'legacy-statement',currency:'USD',
      exchange:{target:'ARS',rateE8:140_000_000,date:'2025-01-31',source:'Statement',statementAmount:1400}};
    await call('/v1/entries',charge);
    const {statementAmount: _omitted,...oldExchange}=charge.exchange;
    const original={...charge,exchange:oldExchange};
    const editPath='/v1/entries/'+charge.id+'/edit';
    await call(editPath,{original,entry:{...original,title:'Card lunch'}});
    const saved=(await call('/v1/snapshot')).entries.find((e:Entry)=>e.id===charge.id);
    expect(saved.title).toBe('Card lunch');
    expect(saved.exchange).toEqual(charge.exchange);
    await expect(call(editPath,{original,entry:{...original,title:'Stale edit'}})).rejects.toThrow('entry changed');
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

describe('Payment preferences and group deletion', () => {
  async function addSecondGroup() {
    await env.DB.prepare("UPDATE members SET user_id='guest' WHERE id=?").bind(guest).run();
    await call('/v1/groups', {
      id: 'another-group', name: 'Another group', kind: 'home', currency: 'USD',
      members: [{ id: 'another-owner', name: 'Alex', userID: 'owner' }],
    });
  }

  it('inherits profile methods, preserves legacy handles, and scopes overrides to the group', async () => {
    await addSecondGroup();
    const defaults = [
      { platform: 'zelle', handle: 'alex@example.com', preferred: true },
      { platform: 'Local wire', handle: 'Account ID / álëx' },
    ];
    await call('/v1/profile/payment-methods', { methods: defaults, userID: 'guest' });
    const other = async () => (await call('/v1/snapshot', undefined, 'guest'));
    const ownerInGroup = async () => (await other()).groups[0].members.find((person: { id: string }) => person.id === owner);
    expect((await other()).paymentMethods).toEqual([]);
    expect((await call('/v1/snapshot')).paymentMethods).toEqual(defaults);
    expect((await ownerInGroup()).paymentMethods).toEqual(defaults);
    expect((await ownerInGroup()).paymentOverride).toBeUndefined();
    expect(await call('/v1/snapshot', undefined, 'stranger')).toMatchObject({ groups: [], paymentMethods: [] });

    await call(path + 'payment-profile', { venmo: 'alex-expenses' });
    expect((await ownerInGroup()).paymentMethods).toEqual([{ platform: 'venmo', handle: 'alex-expenses' }]);
    const override = [{ platform: 'paypal', handle: 'alex+trip@example.com', preferred: true }];
    await call(path + 'payment-profile', { methods: override, memberID: guest });
    expect((await ownerInGroup()).paymentMethods).toEqual(override);
    const own = (await call('/v1/snapshot')).groups.find((g: { id: string }) => g.id === group);
    expect(own.members.find((person: { id: string }) => person.id === owner).paymentOverride).toEqual(override);
    expect(own.members.find((person: { id: string }) => person.id === guest).paymentMethods).toEqual([]);
    expect((await call('/v1/snapshot')).groups.find((g: { id: string }) => g.id === 'another-group').members[0].paymentMethods).toEqual(defaults);

    await call(path + 'payment-profile', { methods: [] });
    expect((await ownerInGroup()).paymentMethods).toEqual([]);
    await call(path + 'payment-profile', { methods: null });
    expect((await ownerInGroup()).paymentMethods).toEqual(defaults);
    await expect(call('/v1/profile/payment-methods', { methods: [defaults[0], defaults[0]] })).rejects.toThrow('one preferred');
    await expect(call('/v1/profile/payment-methods', { methods: [{ platform: 'zelle', handle: 'line\nbreak' }] })).rejects.toThrow('one line');

    await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2025-01-01', guest).run();
    expect((await ownerInGroup()).paymentMethods).toEqual([]);
    await expect(call(path + 'payment-profile', { methods: defaults }, 'guest')).rejects.toThrow('Only active members');
  });

  it('deletes a shared group and its dependent data only as its active creator', async () => {
    await addSecondGroup();
    await call('/v1/profile/payment-methods', { methods: [{ platform: 'zelle', handle: 'alex@example.com' }] });
    await call(path + 'payment-profile', { methods: [{ platform: 'zelle', handle: 'alex+group@example.com' }] });
    await call(path + 'repeat', { entryID: entry.id, cadence: 'weekly' });
    await call(path + 'default-split', { weights: { [owner]: 2 } });
    await call('/v1/entries', { ...entry, id: 'deleted-expense' });
    await call('/v1/entries/deleted-expense/delete', {});
    await env.DB.batch([
      env.DB.prepare('INSERT INTO receipts VALUES (?,?,?)').bind(entry.id, 'photo', new Uint8Array([1, 2, 3, 4])),
      env.DB.prepare('INSERT INTO entry_comments VALUES (?,?,?,?,?,?,?)').bind('comment', entry.id, group, 'owner', 'Alex', 'Lunch', entry.createdAt),
      env.DB.prepare('INSERT INTO entry_reactions VALUES (?,?,?)').bind(entry.id, 'guest', entry.createdAt),
      env.DB.prepare('INSERT INTO member_contacts(member_id,email) VALUES (?,?)').bind(guest, 'guest@example.com'),
      env.DB.prepare('INSERT INTO members(id,group_id,name) VALUES (?,?,?)').bind('alias-seat', group, 'Alias'),
      env.DB.prepare('INSERT INTO member_aliases VALUES (?,?)').bind('alias-seat', guest),
      env.DB.prepare('INSERT INTO invites(token_hash,group_id,member_id,expires_at) VALUES (?,?,?,?)').bind('member-token', group, 'alias-seat', Date.now() + 60000),
      env.DB.prepare('INSERT INTO group_invites VALUES (?,?,?)').bind('group-token', group, Date.now() + 60000),
      env.DB.prepare('INSERT INTO settlement_requests(id,group_id,author,payer_id,recipient_id,payload,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind('request', group, 'owner', owner, guest, JSON.stringify(entry), entry.createdAt),
    ]);
    expect((await call('/v1/snapshot', undefined, 'guest')).groups[0].canDelete).toBe(false);
    await expect(call(path + 'delete', {}, 'guest')).rejects.toMatchObject({ status: 403 });
    await expect(call(path + 'delete', {}, 'stranger')).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2025-01-01', owner).run();
    await expect(call(path + 'delete', {})).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(owner).run();
    expect((await call('/v1/snapshot')).groups.find((g: { id: string }) => g.id === group).canDelete).toBe(true);

    await expect(call(path + 'delete', {})).resolves.toEqual({ ok: true });
    const own = await call('/v1/snapshot');
    expect(own.groups.map((g: { id: string }) => g.id)).toEqual(['another-group']);
    expect(own.entries).toEqual([]);
    expect(own.paymentMethods).toEqual([{ platform: 'zelle', handle: 'alex@example.com' }]);
    expect((await call('/v1/snapshot', undefined, 'guest')).groups).toEqual([]);
    for (const table of ['receipts', 'entry_comments', 'entry_reactions', 'member_contacts', 'member_aliases', 'invites',
      'group_invites', 'payment_profiles', 'settlement_requests', 'deleted_entries', 'group_splits', 'recurring']) {
      expect(await env.DB.prepare('SELECT count(*) AS n FROM ' + table).first('n'), table).toBe(0);
    }
    expect(await env.DB.prepare('SELECT bytes FROM receipt_usage').first('bytes')).toBe(0);
  });
});
