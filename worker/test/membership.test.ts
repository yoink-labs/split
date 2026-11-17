import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handle } from '../src/index';
import { saveProfile, verifiedProfile } from '../src/people';
import { balances, type Entry } from '../src/ledger';

const owner='user-owner', guest='user-guest', groupID='group-audit';
const ownerSeat='seat-owner', placeholder='seat-guest';
function call(user:string,path:string,body?:unknown) {
  return handle(new Request('https://split.test'+path,body===undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  }),env,user);
}
const profile={userID:guest,name:'Casey Green',username:'caseyg',email:'casey@example.test'};
async function group() {
  await call(owner,'/v1/groups',{id:groupID,name:'Weekend',kind:'trip',currency:'USD',
    members:[{id:ownerSeat,userID:owner,name:'Owner'}]});
}
async function invitation(memberID?:string) {
  return (await call(owner,`/v1/groups/${groupID}/invites`,{memberID})).json<{code:string}>();
}
async function snapshot(user:string) {
  return (await call(user,'/v1/snapshot')).json<{entries:Entry[];groups:{members:{id:string;userID:string}[]}[]}>();
}
const expense={id:'entry-audit',groupID,title:'Dinner',currency:'USD',kind:'expense',splitMode:'exact',
  createdAt:'2026-11-17T00:00:00Z',amount:1200,paidBy:ownerSeat,splits:[{memberID:placeholder,amount:1200}]};

it('allows multiple late joiners and retrying a reusable code',async()=>{
  await group();
  const {code}=await invitation();
  for (const user of [guest,guest,'user-third']) await call(user,'/v1/join',{token:code.toLowerCase()});
  expect((await snapshot(guest)).groups[0].members).toHaveLength(3);
  await env.DB.prepare('UPDATE group_invites SET expires_at=0').run();
  await expect(call('user-late','/v1/join',{token:code})).rejects.toThrow('expired');
});
it('limits discovery to exact handles, verified email, or names of shared contacts',async()=>{
  await group(); await saveProfile(env.DB,profile);
  const search=async(query:string)=>(await call(owner,'/v1/people/search',{query})).json<unknown[]>();
  for (const query of ['Casey','casey@','case','%']) expect(await search(query)).toEqual([]);
  for (const query of ['CASEY@example.test','@CaseyG']) expect(await search(query)).toEqual([{userID:guest,name:profile.name,username:profile.username}]);
  await expect(call('outsider',`/v1/groups/${groupID}/members`,{id:placeholder,name:'Casey'})).rejects.toThrow('not a member');
  await call(owner,`/v1/groups/${groupID}/members`,{id:placeholder,name:'Casey',userID:guest});
  expect(await search('Green')).toHaveLength(1);
});
it('claims a verified address and merges both sides of historical expenses and settlements',async()=>{
  await group();
  await call(owner,`/v1/groups/${groupID}/members`,{id:placeholder,name:'Casey',email:'CASEY@example.test',phone:'+1 555 010 1020'});
  await call(owner,'/v1/entries',expense);
  await call(guest,'/v1/join',{token:(await invitation()).code});
  const existing=(await snapshot(guest)).groups[0].members.find(m=>m.userID===guest)!.id;
  await call(guest,'/v1/entries',{...expense,id:'entry-shared',paidBy:placeholder,splits:[{memberID:existing,amount:700},{memberID:placeholder,amount:500}]});
  await call(owner,'/v1/entries',{...expense,id:'entry-payment',kind:'settlement',amount:200,paidBy:placeholder,splits:[{memberID:ownerSeat,amount:200}]});
  const raw={id:guest,first_name:'Casey',last_name:'Green',username:'caseyg',primary_email_address_id:'address',
    email_addresses:[{id:'address',email_address:'CASEY@example.test',verification:{status:'unverified'}}]};
  await saveProfile(env.DB,verifiedProfile(raw));
  expect((await snapshot(guest)).groups[0].members).toHaveLength(3);
  raw.email_addresses[0].verification.status='verified';
  await saveProfile(env.DB,verifiedProfile(raw)); await saveProfile(env.DB,verifiedProfile(raw));
  const snap=await snapshot(guest);
  expect(snap.groups[0].members).toHaveLength(2);
  expect(snap.entries).toHaveLength(3);
  expect(snap.entries.find(e=>e.id==='entry-shared')?.splits).toEqual([{memberID:existing,amount:1200}]);
  expect(balances(snap.entries,'USD')).toEqual({[ownerSeat]:1000,[existing]:-1000});
  await call(owner,'/v1/entries',expense); // receipt survives the merge
});
it('allows the author to correct or delete an entry and prevents resurrection',async()=>{
  await group(); await call(owner,`/v1/groups/${groupID}/members`,{id:placeholder,name:'Guest'});
  await call(owner,'/v1/entries',expense);
  const edit='/v1/entries/'+expense.id+'/edit', remove='/v1/entries/'+expense.id+'/delete';
  const update={original:expense,entry:{...expense,title:'Lunch'}};
  await expect(call(guest,edit,update)).rejects.toThrow('Only the person');
  await call(owner,edit,update); await call(owner,edit,update);
  await expect(call(owner,edit,{original:expense,entry:{...expense,title:'Taxi'}})).rejects.toThrow('changed');
  await expect(call(owner,remove,{original:expense})).rejects.toThrow('changed');
  expect((await snapshot(owner)).entries[0].title).toBe('Lunch');
  await call(owner,remove,{original:update.entry}); await call(owner,remove,{});
  expect((await snapshot(owner)).entries).toEqual([]);
});
