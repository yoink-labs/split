import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle } from '../src/index';
import { balances, type Entry } from '../src/ledger';

const group = 'settlement-group';
const payer = 'payer-seat-123';
const recipient = 'receiver-seat-123';
const payment: Entry = {
  id: 'payment-1234', groupID: group, kind: 'settlement', title: 'Payment',
  amount: 1201, currency: 'USD', paidBy: payer, splits: [{memberID:recipient, amount:1201}],
  splitMode: 'exact', createdAt: '2026-11-27T12:00:00Z'
};

function call(user: string, path: string, body?: unknown) {
  return handle(new Request('https://test' + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  }), env, user);
}

async function setup(registeredRecipient: boolean) {
  await call('payer-user','/v1/groups',{
    id:group, name:'Trip', kind:'trip', currency:'USD',
    members:[{id:payer,name:'Payer',userID:'payer-user'},{id:recipient,name:'Recipient'}]
  });
  if (registeredRecipient) await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?')
    .bind('recipient-user',recipient).run();
  await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)')
    .bind('observer-seat',group,'observer-user','Observer').run();
}

async function snapshot(user: string) {
  return (await call(user,'/v1/snapshot')).json<{entries:Entry[];settlementRequests:Entry[]}>();
}

const decision = (action: string) => '/v1/settlements/' + payment.id + '/' + action;

it('keeps a new payment out of balances until its recipient approves it, exactly once', async () => {
  await setup(true);
  await expect(call('observer-user','/v1/settlements',payment)).rejects.toMatchObject({status:403});
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await (await call('payer-user',attempt === 0 ? '/v1/settlements' : '/v1/entries',payment)).json()).toMatchObject({status:'pending'});
  }
  expect((await snapshot('payer-user')).settlementRequests).toEqual([payment]);
  expect((await snapshot('recipient-user')).settlementRequests).toEqual([payment]);
  expect((await snapshot('observer-user')).settlementRequests).toEqual([]);
  expect(balances((await snapshot('payer-user')).entries,'USD')).toEqual({});
  for (const user of ['payer-user','observer-user','outsider']) {
    await expect(call(user,decision('approve'),{})).rejects.toMatchObject({status:403});
  }
  await expect(call('recipient-user',decision('cancel'),{})).rejects.toMatchObject({status:403});
  const approvals = await Promise.all([
    call('recipient-user',decision('approve'),{}),
    call('recipient-user',decision('approve'),{}),
  ]);
  expect(approvals.map(r => r.status)).toEqual([200,200]);
  const after = await snapshot('payer-user');
  expect(after.settlementRequests).toEqual([]);
  expect(after.entries).toHaveLength(1);
  expect(balances(after.entries,'USD')).toEqual({[payer]:1201,[recipient]:-1201});
  await expect(call('recipient-user',decision('decline'),{})).rejects.toMatchObject({status:409});
  await expect(call('payer-user','/v1/entries/'+payment.id+'/edit',{original:payment,entry:payment}))
    .rejects.toThrow('cannot be edited');
});

it('authorizes decline and cancellation independently and prevents retries from reopening requests', async () => {
  await setup(true);
  await call('payer-user','/v1/entries',payment);
  expect(await (await call('recipient-user',decision('decline'),{})).json()).toMatchObject({status:'declined'});
  expect(await (await call('payer-user','/v1/entries',payment)).json()).toMatchObject({status:'declined'});
  await expect(call('recipient-user',decision('approve'),{})).rejects.toMatchObject({status:409});
  const other = {...payment,id:'payment-5678'};
  await call('payer-user','/v1/entries',other);
  expect(await (await call('payer-user','/v1/settlements/payment-5678/cancel',{})).json()).toMatchObject({status:'cancelled'});
  expect(await snapshot('recipient-user')).toEqual(expect.objectContaining({entries:[],settlementRequests:[]}));
});

it('lets a claimed placeholder approve from the surviving group seat', async () => {
  await setup(false);
  await call('payer-user','/v1/entries',payment);
  await env.DB.prepare('INSERT INTO member_aliases(member_id,canonical_id) VALUES (?,?)')
    .bind(recipient,'observer-seat').run();
  expect((await snapshot('observer-user')).settlementRequests[0].splits).toEqual([{memberID:'observer-seat',amount:1201}]);
  await call('observer-user',decision('approve'),{});
  expect((await snapshot('payer-user')).entries[0].splits).toEqual([{memberID:'observer-seat',amount:1201}]);
});

it('rejects new payments in a shared-group expense CSV', async () => {
  await setup(true);
  await expect(call('observer-user','/v1/groups/'+group+'/import',{
    rows:[{title:'Payment',day:'2026-11-27',payer:'Payer',amount:1201,currency:'USD',
      payment:true,splits:[{name:'Recipient',amount:1201}]}]
  })).rejects.toThrow('Request approval');
  expect((await snapshot('payer-user')).entries).toEqual([]);
});

it('keeps handled expenses in spending while only a payer can change their balance status', async () => {
  await setup(true);
  const expense = {...payment,id:'handled-1234',title:'Airbnb',kind:'expense' as const};
  await call('observer-user','/v1/entries',expense);
  const url = '/v1/entries/'+expense.id;
  await expect(call('observer-user',url+'/handled',{handled:true})).rejects.toMatchObject({status:403});
  await expect(call('observer-user',url+'/edit',{original:expense,entry:{...expense,handled:true}}))
    .rejects.toMatchObject({status:403});
  await expect(call('outsider',url+'/handled',{handled:true})).rejects.toMatchObject({status:404});
  await call('payer-user',url+'/handled',{handled:true});
  const handled = (await snapshot('payer-user')).entries;
  expect(handled[0]).toMatchObject({handled:true,amount:1201,paidBy:payer,splits:expense.splits});
  expect(balances(handled,'USD')).toEqual({});
  await call('payer-user',url+'/handled',{handled:false});
  expect(balances((await snapshot('payer-user')).entries,'USD')).toEqual({[payer]:1201,[recipient]:-1201});

  const newHandled = {...expense,id:'handled-5678',handled:true};
  await call('observer-user','/v1/entries',newHandled);
  expect((await snapshot('payer-user')).entries.find(e=>e.id===newHandled.id)?.handled).toBe(true);
});
