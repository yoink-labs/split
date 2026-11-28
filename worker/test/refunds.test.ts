import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handle } from '../src/index';
import { balances, type Entry } from '../src/ledger';
import { breakdown } from '../src/items';
import { importedBalances, parseSplitwise, reconcile } from '../src/splitwiseCsv';
import { operate } from '../src/cli/operations';
import { adjustedEntry, proportionalCredits, refundRoom, refundsOf } from '../src/refundMath';
import casesJSON from '../../fixtures/refunds/cases.json?raw';

const group = 'refund-group-1';
const [alex, bea, cam] = ['alex-seat-01', 'bea-seat-001', 'cam-seat-001'];

function call(user: string, path: string, body?: unknown) {
  return handle(new Request('https://test' + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  }), env, user);
}
async function setup() {
  await call('alex-user','/v1/groups',{id:group,name:'Trip',kind:'trip',currency:'USD',
    members:[{id:alex,name:'Alex',userID:'alex-user'},{id:bea,name:'Bea'},{id:cam,name:'Cam'}]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('bea-user',bea).run();
  // Someone else's group, to check refunds cannot reach across groups.
  await call('other-user','/v1/groups',{id:'other-group1',name:'Other',kind:'trip',currency:'USD',members:[{id:'other-seat1',name:'O',userID:'other-user'}]});
  await call('other-user','/v1/entries',{...expense('other-expense'),groupID:'other-group1',paidBy:'other-seat1',splits:[{memberID:'other-seat1',amount:10000}]});
}
function expense(id = 'excursion-1', extra: Partial<Entry> = {}): Entry {
  // $100.00 three ways: 33.34 / 33.33 / 33.33
  return { id, groupID: group, kind: 'expense', title: 'Excursion', amount: 10000, currency: 'USD', paidBy: alex,
    splits: [{memberID:alex,amount:3334},{memberID:bea,amount:3333},{memberID:cam,amount:3333}], splitMode: 'equal',
    createdAt: '2026-11-20T12:00:00Z', ...extra };
}
function refund(id: string, amount: number, splits: Entry['splits'], extra: Partial<Entry> = {}): Entry {
  return { id, groupID: group, kind: 'refund', title: 'Refund: Excursion', amount, currency: 'USD', paidBy: alex, splits,
    refundOf: 'excursion-1', splitMode: 'exact', createdAt: '2026-11-21T12:00:00Z', ...extra };
}
async function entries(user = 'alex-user') {
  return (await (await call(user,'/v1/snapshot')).json<{entries:Entry[]}>()).entries;
}
const status = (promise: Promise<Response>) => promise.then(r => r.status, e => e.status ?? (e.constructor.name === 'InputError' ? 422 : 500));

describe('refunds', () => {
  it('lowers the credited shares and balances exactly to the cent', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense());
    expect(balances(await entries(),'USD')).toEqual({[alex]:6666,[bea]:-3333,[cam]:-3333});
    // Cam couldn't go: the vendor refunds Cam's whole share to Alex's card.
    await call('bea-user','/v1/entries',refund('refund-cam-1',3333,[{memberID:cam,amount:3333}]));
    const after = await entries('bea-user');
    expect(balances(after,'USD')).toEqual({[alex]:3333,[bea]:-3333,[cam]:0});
    const report = breakdown(after,[{id:alex,name:'Alex'},{id:bea,name:'Bea'},{id:cam,name:'Cam'}],'USD');
    expect(report.total).toBe(6667);
    expect(report.members.map(m => [m.paid, m.share])).toEqual([[6667,3334],[0,3333],[0,0]]);
    expect(after.find(e => e.id === 'refund-cam-1')).toMatchObject({kind:'refund',refundOf:'excursion-1'});
    // Retrying the same refund is a no-op, not an overshoot.
    expect((await call('bea-user','/v1/entries',refund('refund-cam-1',3333,[{memberID:cam,amount:3333}]))).status).toBe(200);
    expect((await entries()).filter(e => e.kind === 'refund')).toHaveLength(1);
  });

  it('rejects refunds that exceed the original amount, a share, or credit outsiders', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense());
    const tooMuch = refund('refund-big-1',10001,[{memberID:alex,amount:3334},{memberID:bea,amount:3333},{memberID:cam,amount:3334}]);
    await expect(call('alex-user','/v1/entries',tooMuch)).rejects.toThrow('Refunds cannot exceed the original expense amount.');
    await expect(call('alex-user','/v1/entries',refund('refund-share',3334,[{memberID:bea,amount:3334}])))
      .rejects.toThrow('cannot exceed their share');
    await call('alex-user','/v1/entries',refund('refund-part1',2000,[{memberID:bea,amount:2000}]));
    // Cumulative: a second refund to Bea may only use the 13.33 left of her share.
    await expect(call('alex-user','/v1/entries',refund('refund-part2',1334,[{memberID:bea,amount:1334}]))).rejects.toThrow('cannot exceed their share');
    expect((await call('alex-user','/v1/entries',refund('refund-part3',1333,[{memberID:bea,amount:1333}]))).status).toBe(200);
    await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,NULL,?)').bind('dan-seat-001',group,'Dan').run();
    await expect(call('alex-user','/v1/entries',refund('refund-dan1',100,[{memberID:'dan-seat-001',amount:100}]))).rejects.toThrow('Only credit people who shared');
    await expect(call('alex-user','/v1/entries',refund('refund-eur1',100,[{memberID:cam,amount:100}],{currency:'EUR'}))).rejects.toThrow('original expense currency');
    await expect(call('alex-user','/v1/entries',refund('refund-self',100,[{memberID:alex,amount:100}],{refundOf:undefined}))).rejects.toThrow('someone other than');
    await expect(call('alex-user','/v1/entries',{...expense('bad-expense'),refundOf:'excursion-1'})).rejects.toThrow('Only refunds');
    expect(balances(await entries(),'USD')).toEqual({[alex]:3333,[bea]:0,[cam]:-3333});
  });

  it('keeps an expense from shrinking below or being deleted under its refunds', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense());
    await call('alex-user','/v1/entries',refund('refund-cam-1',3333,[{memberID:cam,amount:3333}]));
    const smaller = {...expense(), amount: 6000, splits:[{memberID:alex,amount:3000},{memberID:bea,amount:3000}]};
    await expect(call('alex-user','/v1/entries/excursion-1/edit',{original:expense(),entry:smaller})).rejects.toThrow('This expense has refunds.');
    await expect(call('alex-user','/v1/entries/excursion-1/delete',{original:expense()})).rejects.toThrow('Delete its refunds first.');
    // Editing the refund itself is checked too.
    const r = refund('refund-cam-1',3333,[{memberID:cam,amount:3333}]);
    await expect(call('alex-user','/v1/entries/refund-cam-1/edit',{original:r,entry:{...r,amount:3334,splits:[{memberID:cam,amount:3334}]}})).rejects.toThrow('cannot exceed their share');
    await expect(call('alex-user','/v1/entries/refund-cam-1/edit',{original:r,entry:{...r,refundOf:undefined}})).rejects.toThrow('Invalid edit.');
    expect((await call('alex-user','/v1/entries/refund-cam-1/delete',{original:r})).status).toBe(200);
    expect((await call('alex-user','/v1/entries/excursion-1/delete',{original:expense()})).status).toBe(200);
  });

  it('checks membership for refunds and never links across groups', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense());
    await expect(call('outsider','/v1/entries',refund('refund-out1',100,[{memberID:cam,amount:100}]))).rejects.toMatchObject({status:403});
    await expect(call('alex-user','/v1/entries',refund('refund-xg01',100,[{memberID:cam,amount:100}],{refundOf:'other-expense'}))).rejects.toMatchObject({status:404});
    await expect(call('other-user','/v1/entries',{...refund('refund-xg02',100,[{memberID:'other-seat1',amount:100}]),groupID:'other-group1',paidBy:'other-seat1'}))
      .rejects.toThrow('someone other than');
    await expect(call('alex-user','/v1/entries',refund('refund-miss',100,[{memberID:cam,amount:100}],{refundOf:'missing-expense'}))).rejects.toMatchObject({status:404});
  });

  it('records a standalone credit', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense());
    const credit = refund('credit-bea-1',1000,[{memberID:bea,amount:1000}],{refundOf:undefined,title:'Overcharged Bea'});
    delete credit.refundOf;
    await call('alex-user','/v1/entries',credit);
    expect(balances(await entries(),'USD')).toEqual({[alex]:5666,[bea]:-2333,[cam]:-3333});
  });
});

describe('pending expenses', () => {
  it('counts pending entries by default and offers a confirmed-only view', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense('dinner-0001',{amount:3000,splits:[{memberID:alex,amount:1500},{memberID:bea,amount:1500}],title:'Dinner'}));
    await call('alex-user','/v1/entries',expense('excursion-1',{pending:true,pendingNote:'Asking for Cam’s ticket back'}));
    const list = await entries();
    expect(list.find(e => e.id === 'excursion-1')).toMatchObject({pending:true,pendingNote:'Asking for Cam’s ticket back'});
    expect(balances(list,'USD')).toEqual({[alex]:8166,[bea]:-4833,[cam]:-3333});
    expect(balances(list,'USD',{includePending:false})).toEqual({[alex]:1500,[bea]:-1500});
    await expect(call('alex-user','/v1/entries',{...expense('bad-pending'),pending:true,handled:true})).rejects.toThrow('cannot be pending');
    await expect(call('alex-user','/v1/entries',{...expense('bad-note-01'),pendingNote:'why'})).rejects.toThrow('Only a pending entry');
  });

  it('lets only the recorder or a payer mark and resolve', async () => {
    await setup();
    await call('bea-user','/v1/entries',expense());
    await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)').bind('obs-seat-001',group,'observer','Obs').run();
    await expect(call('observer','/v1/entries/excursion-1/pending',{pending:true})).rejects.toMatchObject({status:403});
    await expect(call('outsider','/v1/entries/excursion-1/pending',{pending:true})).rejects.toMatchObject({status:404});
    await expect(call('other-user','/v1/entries/excursion-1/resolve',{action:'confirm'})).rejects.toMatchObject({status:404});
    // Alex paid; Bea recorded it. Both may change it.
    expect((await call('alex-user','/v1/entries/excursion-1/pending',{pending:true,note:'Ticket refund requested'})).status).toBe(200);
    expect((await entries()).find(e => e.id === 'excursion-1')).toMatchObject({pending:true,pendingNote:'Ticket refund requested'});
    await expect(call('observer','/v1/entries/excursion-1/resolve',{action:'confirm'})).rejects.toMatchObject({status:403});
    expect((await call('bea-user','/v1/entries/excursion-1/resolve',{action:'confirm'})).status).toBe(200);
    const confirmed = (await entries()).find(e => e.id === 'excursion-1')!;
    expect(confirmed.pending).toBeUndefined();
    expect(confirmed.pendingNote).toBeUndefined();
  });

  it('adjusts a pending amount by rescaling every share exactly', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense('excursion-1',{pending:true}));
    expect((await call('alex-user','/v1/entries/excursion-1/resolve',{action:'adjust',amount:6667})).status).toBe(200);
    const adjusted = (await entries()).find(e => e.id === 'excursion-1')!;
    expect(adjusted.amount).toBe(6667);
    expect(adjusted.splits).toEqual([{memberID:alex,amount:2223},{memberID:bea,amount:2222},{memberID:cam,amount:2222}]);
    expect(adjusted.pending).toBeUndefined();
    await expect(call('alex-user','/v1/entries/excursion-1/resolve',{action:'adjust',amount:5000})).rejects.toMatchObject({status:409});
  });

  it('turns a pending expense into a refund atomically, and refuses an overshoot', async () => {
    await setup();
    await call('alex-user','/v1/entries',expense('excursion-1',{pending:true,pendingNote:'Cam may get a refund'}));
    const over = refund('refund-cam-1',3334,[{memberID:cam,amount:3334}]);
    await expect(call('alex-user','/v1/entries/excursion-1/resolve',{action:'refund',refund:over})).rejects.toThrow('cannot exceed their share');
    expect((await entries()).find(e => e.id === 'excursion-1')!.pending).toBe(true);
    await expect(call('alex-user','/v1/entries/excursion-1/resolve',{action:'refund',refund:{...over,refundOf:'dinner-0001'}})).rejects.toThrow('confirmed refund of this expense');
    const ok = refund('refund-cam-1',3333,[{memberID:cam,amount:3333}]);
    expect((await call('alex-user','/v1/entries/excursion-1/resolve',{action:'refund',refund:ok})).status).toBe(200);
    // A retry after success is harmless.
    expect((await call('alex-user','/v1/entries/excursion-1/resolve',{action:'refund',refund:ok})).status).toBe(200);
    const list = await entries();
    expect(list.find(e => e.id === 'excursion-1')!.pending).toBeUndefined();
    expect(list.filter(e => e.kind === 'refund')).toHaveLength(1);
    expect(balances(list,'USD')).toEqual({[alex]:3333,[bea]:-3333,[cam]:0});
  });

  it('keeps payments from being pending', async () => {
    await setup();
    await expect(call('alex-user','/v1/settlements',{id:'payment-0001',groupID:group,kind:'settlement',title:'Payment',amount:100,currency:'USD',paidBy:alex,
      splits:[{memberID:bea,amount:100}],splitMode:'exact',createdAt:'2026-11-21T12:00:00Z',pending:true})).rejects.toThrow('Only expenses and refunds can be pending.');
  });
});

describe('Splitwise refunds and CLI', () => {
  it('imports a negative-cost Splitwise row as a refund that still reconciles', async () => {
    const csv = 'Date,Description,Category,Cost,Currency,Alex,Bea,Cam\n' +
      '2026-11-20,Excursion,Entertainment,90.00,USD,60.00,-30.00,-30.00\n' +
      '2026-11-21,Excursion refund,Entertainment,-30.00,USD,-20.00,10.00,10.00\n' +
      '2026-11-22,Total balance, , ,USD,40.00,-20.00,-20.00\n';
    const parsed = await parseSplitwise(csv, 'trip.csv');
    expect(parsed.rows[1]).toMatchObject({refund:true,payer:'Alex',amount:3000,
      splits:[{name:'Alex',amount:1000},{name:'Bea',amount:1000},{name:'Cam',amount:1000}]});
    expect(importedBalances(parsed).USD).toEqual({Alex:4000,Bea:-2000,Cam:-2000});
    expect(reconcile(parsed)).toEqual([]);
    const imported = await (await call('alex-user','/v1/import/splitwise',{group:{id:'sw-refund-group',name:'Trip',kind:'trip',currency:'USD'},
      people:[{name:'Alex',me:true},{name:'Bea'},{name:'Cam'}],rows:parsed.rows})).json<{groupID:string}>();
    const list = (await entries()).filter(e => e.groupID === imported.groupID);
    expect(list.map(e => e.kind).sort()).toEqual(['expense','refund']);
    expect(Object.values(balances(list,'USD')).sort((a,b)=>a-b)).toEqual([-2000,-2000,4000]);
  });

  it('records refunds and resolves pending expenses through the CLI', async () => {
    await setup();
    const ledger = (r: Request, e: Env, u: string) => handle(r, e, u);
    await call('alex-user','/v1/entries',expense('excursion-1',{pending:true,pendingNote:'Cam may not go'}));
    const shown = await operate('balances',{group},env,'alex-user',ledger) as any[];
    expect(shown[0]).toMatchObject({net:{[alex]:6666},confirmedNet:{},pending:[{id:'excursion-1',note:'Cam may not go'}]});
    const resolved = await operate('expenses_resolve',{group,expense:'excursion-1',action:'refund',amount:'33.33',participants:[cam]},env,'alex-user',ledger) as any;
    expect(resolved.refund).toMatchObject({kind:'refund',paidBy:alex,amount:3333,splits:[{memberID:cam,amount:3333}]});
    // Proportional default: the 33.34 left is shared by Alex and Bea in proportion to what remains of their shares.
    const rest = await operate('refunds_add',{group,expense:'excursion-1',amount:'20.00'},env,'alex-user',ledger) as any;
    expect(rest.splits).toEqual([{memberID:alex,amount:1000},{memberID:bea,amount:1000}]);
    await expect(operate('refunds_add',{group,expense:'excursion-1',amount:'50.00'},env,'alex-user',ledger)).rejects.toThrow('cannot exceed');
    const credit = await operate('refunds_add',{group,amount:'5.00',receiver:alex,participants:[bea],title:'Overcharge'},env,'alex-user',ledger) as any;
    expect(credit).toMatchObject({kind:'refund',amount:500,splits:[{memberID:bea,amount:500}]});
    expect(credit.refundOf).toBeUndefined();
    const listed = await operate('expenses_list',{group},env,'alex-user',ledger) as any[];
    expect(listed.map(e => e.kind).sort()).toEqual(['expense','refund','refund','refund']);
    const after = await operate('balances',{group},env,'alex-user',ledger) as any[];
    expect(after[0].confirmedNet).toBeUndefined();
    expect(after[0].net).toEqual({[alex]:6666-3333-2000-500+1000,[bea]:-3333+1000+500,[cam]:0});
    const marked = await operate('expenses_pending',{group,expense:'excursion-1',note:'Bea may get a refund too'},env,'alex-user',ledger);
    expect(marked).toEqual({id:'excursion-1',pending:true,note:'Bea may get a refund too'});
    const settle = await operate('settle_up',{group,from:bea,to:alex,amount:'1.00'},env,'bea-user',ledger) as any;
    expect(settle.warning).toMatch(/1 pending entry in USD/);
  });
});

describe('shared refund math', () => {
  // The same fixture drives SplitTests/RefundTests.swift so iOS stays in step with the Worker and web.
  it('matches fixtures/refunds/cases.json', () => {
    const c = JSON.parse(casesJSON);
    const report = breakdown(c.entries, c.members, c.currency);
    expect(balances(c.entries, c.currency)).toEqual(c.expected.balances);
    expect(balances(c.entries, c.currency, {includePending:false})).toEqual(c.expected.confirmedBalances);
    expect({total:report.total, categories:{...report.categories}, months:{...report.months}})
      .toEqual({total:c.expected.total, categories:c.expected.categories, months:c.expected.months});
    expect(report.members.map(m => ({id:m.id, paid:m.paid, share:m.share, net:m.net}))).toEqual(c.expected.members);
    const original = c.entries.find((e: Entry) => e.id === c.proportional.original);
    const room = refundRoom(original, refundsOf(c.entries, original.id));
    expect(room).toEqual(c.expected.room);
    expect(proportionalCredits(c.proportional.amount, room.members, original.splits.map((s: {memberID:string}) => s.memberID))).toEqual(c.expected.proportionalCredits);
    expect(adjustedEntry(c.entries.find((e: Entry) => e.id === c.adjust.entry), c.adjust.amount).splits).toEqual(c.expected.adjustedSplits);
  });
});
