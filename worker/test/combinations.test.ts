import {env} from 'cloudflare:test';
import {beforeEach, expect, it} from 'vitest';
import {handle} from '../src/index';
import {operate} from '../src/cli/operations';
import {balances, type Entry} from '../src/ledger';
import {itemSplit, type Bill} from '../src/items';

const group = 'brazil-trip', other = 'other-trip';
const arul = 'seat-arul', amine = 'seat-amine', harris = 'seat-harris', outsider = 'seat-outsider';
const first = 'expense-tickets-five', second = 'expense-tickets-four';
const groupPath = '/v1/groups/' + group;
const jpeg = (n: number) => btoa(String.fromCharCode(255,216,255,224,n,8,255,217));
const call = (user: string, path: string, input?: unknown) => handle(new Request(env.APP_URL + path, input === undefined ? {} : {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input),
}), env, user);
const snapshot = async (user = 'arul') => (await (await call(user, '/v1/snapshot')).json<{entries:Entry[]}>()).entries;
const make = (id: string, payer: string, amount: number, extra?: Partial<Entry>): Entry => ({
  id, groupID:group, title:'Christ the Redeemer', amount, currency:'BRL', paidBy:payer,
  splits:[{memberID:payer, amount}], kind:'expense', splitMode:'equal', createdAt:'2026-11-20T12:00:00Z', ...extra,
});

beforeEach(async () => {
  await call('arul', '/v1/groups', {id:group,name:'Brazil',kind:'trip',currency:'BRL',members:[
    {id:arul,name:'Arul',userID:'arul'}, {id:amine,name:'Amine'}, {id:harris,name:'Harris'},
  ]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('amine', amine).run();
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('harris', harris).run();
  await call('outsider', '/v1/groups', {id:other,name:'Other',kind:'trip',currency:'BRL',members:[{id:outsider,name:'Other',userID:'outsider'}]});
});

it('preserves payers, exact cents, all receipts, and original item claims through reversal', async () => {
  const bill: Bill = {closed:false,tax:0,tip:0,items:[{id:'ticket-line',title:'Tickets',amount:5000,memberIDs:[arul, harris]}]};
  await call('arul', '/v1/entries', {...make(first, arul, 5000, {bill, splitMode:'exact', splits:itemSplit(bill, arul)}),
    photos:[1,2,3,4].map(n => ({id:'photo-ticket-'+n,data:jpeg(n)}))});
  await call('amine', '/v1/entries', {...make(second, amine, 4001), photos:[{id:'photo-ticket-1',data:jpeg(5)}]});
  await call('amine', groupPath+'/receipts', {id:'photo-waiting',data:jpeg(6)});
  const originals = await snapshot();
  const before = balances(originals, 'BRL');
  const response = await call('harris', groupPath+'/combine', {entryIDs:[first,second]});
  expect(response.status).toBe(201);
  const {entryID} = await response.json<{entryID:string}>();
  const combined = (await snapshot()).find(e => e.id === entryID)!;
  expect((await snapshot()).map(e => e.id)).toEqual([entryID]);
  expect(combined).toMatchObject({amount:9001, combinedCount:2, payers:expect.arrayContaining([
    {memberID:arul,amount:5000}, {memberID:amine,amount:4001},
  ]), splits:[{memberID:arul,amount:3001},{memberID:amine,amount:3000},{memberID:harris,amount:3000}]});
  expect(balances([combined], 'BRL')).toEqual({[arul]:1999,[amine]:1001,[harris]:-3000});
  expect(combined.bill).toBeUndefined();
  expect(new Set(combined.receiptIDs).size).toBe(5);
  const images = await Promise.all(combined.receiptIDs!.map(async photo => {
    const response = await call('amine', `/v1/entries/${entryID}/receipts/${photo}`);
    return new Uint8Array(await response.arrayBuffer())[4];
  }));
  expect(images.sort()).toEqual([1,2,3,4,5]);
  expect(await env.DB.prepare('SELECT bytes FROM receipt_usage WHERE id=1').first('bytes')).toBe(48);
  await expect(call('outsider', `/v1/entries/${entryID}/receipts/${combined.receiptIDs![0]}`)).rejects.toMatchObject({status:404});
  await expect(call('arul', `/v1/entries/${first}/claim`, {})).rejects.toMatchObject({status:404});
  await expect(call('arul', groupPath+'/receipts/photo-waiting/pair', {entryID})).rejects.toMatchObject({status:404});
  await expect(call('arul', `/v1/entries/${first}/receipts/photo-ticket-1/move`, {entryID:null})).rejects.toMatchObject({status:404});
  await expect(call('harris', `/v1/entries/${entryID}/delete`, {})).rejects.toMatchObject({status:409});
  await expect(call('outsider', `/v1/entries/${entryID}/uncombine`, {})).rejects.toMatchObject({status:404});
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-21', harris).run();
  await expect(call('harris', `/v1/entries/${entryID}/uncombine`, {})).rejects.toMatchObject({status:404});
  await call('amine', `/v1/entries/${entryID}/uncombine`, {});
  await call('amine', `/v1/entries/${entryID}/uncombine`, {});
  expect(await snapshot()).toEqual(originals);
  expect(balances(await snapshot(), 'BRL')).toEqual(before);
  const log = await (await call('arul', groupPath+'/combine-activity')).json<{events:{action:string}[]}>();
  expect(log.events.map(e => e.action).sort()).toEqual(['combine','uncombine']);
  await call('arul', `/v1/entries/${first}/claim`, {itemID:'ticket-line', original:[arul,harris], memberIDs:[arul,amine]});
  expect((await snapshot()).find(e => e.id === first)?.bill?.items[0].memberIDs).toEqual([arul,amine]);
});

it('scopes every combination route to active membership and rejects mixed currencies', async () => {
  await call('arul', '/v1/entries', make(first, arul, 5000));
  await call('amine', '/v1/entries', make(second, amine, 4001, {currency:'USD'}));
  await call('outsider', '/v1/entries', make('other-expense', outsider, 4001, {groupID:other}));
  for (const route of ['combine-activity','combine-suggestions']) {
    await expect(call('outsider', groupPath+'/'+route)).rejects.toMatchObject({status:403});
  }
  await expect(call('outsider', groupPath+'/combine', {entryIDs:[first,second]})).rejects.toMatchObject({status:403});
  await expect(call('arul', groupPath+'/combine', {entryIDs:[first,'other-expense']})).rejects.toMatchObject({status:409});
  await expect(call('arul', groupPath+'/combine', {entryIDs:[first,second]})).rejects.toThrow('same currency');
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-21', amine).run();
  await expect(call('amine', groupPath+'/combine', {entryIDs:[first,second]})).rejects.toMatchObject({status:403});
  await expect(call('amine', groupPath+'/combine-suggestions')).rejects.toMatchObject({status:403});
  await expect(call('amine', groupPath+'/combine-activity')).rejects.toMatchObject({status:403});
  expect(await snapshot()).toHaveLength(2);
});

it('suggests nearby rides with matching descriptions and only combines overlapping requests once', async () => {
  const ride = (id:string, payer:string, at:string, title = 'Uber to Copacabana') =>
    make(id, payer, 1001, {title, createdAt:'2026-11-20T'+at+'Z'});
  for (const entry of [
    ride(first, arul, '12:00:00'), ride(second, amine, '12:11:00', 'Lyft · Copacabana'),
    ride('ride-different', arul, '12:15:00', 'Uber to Ipanema'), ride('ride-late', arul, '16:00:00'),
    ride('ride-generic', arul, '12:00:00', 'Uber'), ride('ride-generic-2', amine, '12:01:00', 'Uber'),
  ]) await call('arul', '/v1/entries', entry);
  const matches = await operate('expenses_suggestions', {group}, env, 'amine', handle);
  expect(matches).toEqual({suggestions:[{title:'Uber to Copacabana',entryIDs:[first,second]}]});
  const request = {entryIDs:[first,second], splitMode:'percent', parts:[{memberID:arul,amount:7500},{memberID:amine,amount:2500}]};
  const results = await Promise.allSettled([
    call('arul', groupPath+'/combine', request),
    call('amine', groupPath+'/combine', request),
  ]);
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled','rejected']);
  const combined = (await snapshot()).filter(e => e.combinedCount);
  expect(combined).toHaveLength(1);
  expect(combined[0].splits).toEqual([{memberID:arul,amount:1502},{memberID:amine,amount:500}]);
  await operate('expenses_uncombine', {group,expense:combined[0].id}, env, 'amine', handle);
  const result = await operate('expenses_combine', {
    group, expenses:[first,second], mode:'exact', participants:[arul,amine], values:['10.00','10.02'],
  }, env, 'amine', handle);
  expect((await snapshot()).find(e => e.id === (result as {entryID:string}).entryID)?.splits)
    .toEqual([{memberID:arul,amount:1000},{memberID:amine,amount:1002}]);
});


it('keeps original participants eligible for restoration and cleans up when the group is deleted', async () => {
  await call('arul', '/v1/entries', {...make(first, arul, 5000, {splits:[{memberID:harris,amount:5000}]}),
    photos:[{id:'photo-delete',data:jpeg(7)}]});
  await call('amine', '/v1/entries', make(second, amine, 4001));
  await call('arul', groupPath+'/combine', {entryIDs:[first,second], parts:[{memberID:arul},{memberID:amine}]});
  await expect(call('arul', groupPath+'/members/'+harris+'/remove', {mode:'delete'})).rejects.toMatchObject({status:409});
  const preview = await operate('groups_delete', {group}, env, 'arul', handle) as {receipts:number; revision:string};
  expect(preview.receipts).toBe(1);
  await operate('groups_delete', {group,yes:true,revision:preview.revision}, env, 'arul', handle);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM expense_combinations').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT bytes FROM receipt_usage WHERE id=1').first('bytes')).toBe(0);
});
