import { describe,it,expect } from 'vitest';
import { allocate,balances,simplify,validateEntry } from '../src/ledger';
import { env } from 'cloudflare:test';
import worker,{ handle } from '../src/index';
const group={id:'group-12345',name:'Buenos Aires',kind:'trip',currency:'ARS',members:[{id:'person-alex',userID:'user-alex',name:'Alex'},{id:'person-maya',userID:null,name:'Maya'}]};
const entry={id:'entry-12345',groupID:group.id,title:'Dinner',amount:10001,currency:'ARS',paidBy:'person-alex',splits:[{memberID:'person-alex',amount:5001},{memberID:'person-maya',amount:5000}],kind:'expense' as const,splitMode:'equal' as const,createdAt:'2026-11-17T00:00:00Z'};
const req=(path:string,value?:unknown)=>new Request('https://split-api.yoinklabs.dev'+path,value ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:undefined);
describe('ledger',()=>{
 it('preserves all cents across equal and weighted splits',()=>{for(let total=1;total<=1000;total++)for(let n=1;n<=12;n++)expect(allocate(total,Array(n).fill(1)).reduce((a,b)=>a+b,0)).toBe(total);expect(allocate(10001,[2,1,1])).toEqual([5001,2500,2500]);expect(allocate(100_000_000_000,[100_000_000_000,1])).toEqual([99999999999,1]);});
 it('rejects malformed and unbalanced amounts',()=>{expect(()=>validateEntry({...entry,amount:10},['person-alex','person-maya'])).toThrow();expect(()=>validateEntry({...entry,amount:NaN},['person-alex','person-maya'])).toThrow();expect(()=>validateEntry({...entry,paidBy:'stranger'},['person-alex','person-maya'])).toThrow();expect(()=>allocate(100,[0,0])).toThrow();});
 it('keeps currencies separate and payments cancel debt',()=>{const usd={...entry,currency:'USD'};expect(simplify(balances([entry,usd],'ARS'))).toEqual([{from:'person-maya',to:'person-alex',amount:5000}]);const settlement={...entry,amount:5000,paidBy:'person-maya',splits:[{memberID:'person-alex',amount:5000}],kind:'settlement' as const};expect(simplify(balances([entry,settlement],'ARS'))).toEqual([]);});
});
describe('D1 authorization and retry semantics',()=>{
 it('requires a valid session at the public handler',async()=>{expect((await worker.fetch(req('/v1/snapshot'),env)).status).toBe(401);expect((await worker.fetch(new Request('https://test/v1/snapshot',{headers:{Authorization:'Bearer test:user-alex'}}),env)).status).toBe(401);});
 it('creates atomically, denies outsiders, and deduplicates retries',async()=>{
  await handle(req('/v1/groups',group),env,'user-alex');
  await expect(handle(req('/v1/entries',entry),env,'stranger')).rejects.toThrow('not a member');
  await handle(req('/v1/entries',entry),env,'user-alex');await handle(req('/v1/entries',entry),env,'user-alex');
  await expect(handle(req('/v1/entries',{...entry,title:'Different'}),env,'user-alex')).rejects.toThrow('already uses');
  const snapshot=await (await handle(req('/v1/snapshot'),env,'user-alex')).json() as {entries:unknown[]};expect(snapshot.entries).toHaveLength(1);
  const outsider=await (await handle(req('/v1/snapshot'),env,'stranger')).json() as {groups:unknown[]};expect(outsider.groups).toEqual([]);
 });
 it('invites claim exactly one placeholder and preserve existing expenses',async()=>{
  await handle(req('/v1/groups',group),env,'user-alex');await handle(req('/v1/entries',entry),env,'user-alex');
  const link=await (await handle(req('/v1/groups/'+group.id+'/invites',{memberID:'person-maya'}),env,'user-alex')).json() as {url:string};
  const token=link.url.split('/').pop();await handle(req('/v1/join',{token}),env,'user-maya');
  const snap=await (await handle(req('/v1/snapshot'),env,'user-maya')).json() as {entries:unknown[],groups:{members:{id:string,userID:string}[]}[]};expect(snap.entries).toHaveLength(1);expect(snap.groups[0].members.find(m=>m.userID==='user-maya')?.id).toBe('person-maya');
  await handle(req('/v1/join',{token}),env,'user-maya');await expect(handle(req('/v1/join',{token}),env,'user-intruder')).rejects.toThrow('already been claimed');
 });
 it('rejects assigning someone else to a new group',async()=>{await expect(handle(req('/v1/groups',{...group,members:[...group.members,{id:'person-fake',userID:'someone-else',name:'Fake'}]}),env,'user-alex')).rejects.toThrow();});
});
