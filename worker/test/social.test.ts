import {env} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {handle} from '../src/index';
import {balances,simplify,validateEntry,type Entry} from '../src/ledger';

let group: string;
const userA='user-alex',userB='user-maya',outsider='user-outsider';
const seatA='seat-alex',seatB='seat-maya';
const baseEntry:Entry={id:'entry-social',groupID:'',title:'Dinner',amount:1000,currency:'USD',paidBy:seatA,
  splits:[{memberID:seatA,amount:500},{memberID:seatB,amount:500}],kind:'expense',splitMode:'equal',
  createdAt:'2026-11-17T00:00:00Z'};
const path=(suffix:string)=>'/v1/entries/'+baseEntry.id+suffix;

async function call(user:string,url:string,value?:unknown,method?:string) {
  const init:RequestInit={method:method??(value===undefined?'GET':'POST')};
  if(value!==undefined) {init.headers={'Content-Type':'application/json'};init.body=JSON.stringify(value);}
  const response=await handle(new Request('https://split.test'+url,init),env,user);
  return {status:response.status,data:await response.json<any>()};
}
async function addEntry(overrides:Record<string,unknown>={}):Promise<Entry> {
  const entry={...baseEntry,...overrides} as Entry;
  await call(userA,'/v1/entries',entry);
  return entry;
}
async function snapshot(user:string) {
  return (await call(user,'/v1/snapshot')).data as {groups:any[];entries:any[]};
}

beforeEach(async()=>{
  group = crypto.randomUUID();
  baseEntry.groupID = group;
  await env.DB.prepare('INSERT INTO split_profiles VALUES (?,?,?,?,?)').bind(userB,'Maya','maya',null,Date.now()).run();
  await env.DB.prepare('INSERT INTO friendships VALUES (?,?,?,?,?)').bind('social-friends',userA,userB,1,Date.now()).run();
  await call(userA,'/v1/groups',{id:group,name:'Trip',kind:'trip',currency:'USD',
    members:[{id:seatA,userID:userA,name:'Alex'},{id:seatB,userID:userB,name:'Maya'}]});
});

describe('entry comments',()=>{
  it('creates, lists and deletes comments with author and membership checks',async()=>{
    await addEntry();
    const first=await call(userB,path('/comments'),{body:'  First comment  '});
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({entryID:baseEntry.id,authorUserID:userB,authorName:'Maya',
      body:'First comment',mine:true});
    expect(first.data.id).toEqual(expect.any(String));
    expect(first.data.createdAt).toEqual(expect.any(String));

    const second=await call(userA,path('/comments'),{body:'Second comment'});
    expect(second.status).toBe(201);

    const fromB=await call(userB,path('/comments'));
    expect(fromB.data.comments.map((c:any)=>c.body)).toEqual(['First comment','Second comment']);
    expect(fromB.data.comments.map((c:any)=>c.mine)).toEqual([true,false]);
    const fromA=await call(userA,path('/comments'));
    expect(fromA.data.comments.map((c:any)=>c.mine)).toEqual([false,true]);

    await expect(call(userB,path('/comments/'+second.data.id),undefined,'DELETE')).rejects.toMatchObject({status:403});
    expect(await call(userA,path('/comments/'+second.data.id),undefined,'DELETE')).toEqual({status:200,data:{ok:true}});
    expect((await call(userA,path('/comments'))).data.comments).toHaveLength(1);

    await expect(call(userA,path('/comments/missing-comment'),undefined,'DELETE')).rejects.toMatchObject({status:404});
    await expect(call(outsider,path('/comments'))).rejects.toMatchObject({status:403});
    await expect(call(outsider,path('/comments'),{body:'Hello'})).rejects.toMatchObject({status:403});
    await expect(call(userA,path('/comments'),{body:'   '})).rejects.toThrow('2,000');
    await expect(call(userA,path('/comments'),{body:'x'.repeat(2001)})).rejects.toThrow('2,000');
    await expect(call(userA,path('/comments'),{body:42})).rejects.toThrow('2,000');
  });

  it('prefers the group display name for new and existing comments',async()=>{
    await addEntry();
    await env.DB.prepare('UPDATE split_profiles SET name=? WHERE user_id=?').bind('Maya Chen',userB).run();
    const saved=await call(userB,path('/comments'),{body:'Hello'});
    expect(saved.data.authorName).toBe('Maya');

    await env.DB.prepare('UPDATE entry_comments SET author_name=? WHERE id=?').bind('Maya Chen',saved.data.id).run();
    await env.DB.prepare('UPDATE members SET name=? WHERE id=?').bind('Maya C.',seatB).run();
    expect((await call(userA,path('/comments'))).data.comments[0].authorName).toBe('Maya C.');
    await call(userB,path('/comments'),{body:'Second comment'});

    await env.DB.prepare('UPDATE members SET user_id=NULL WHERE id=?').bind(seatB).run();
    expect((await call(userA,path('/comments'))).data.comments.map((c:any)=>c.authorName)).toEqual(['Maya Chen','Maya C.']);
  });

  it('stops comments for deleted entries',async()=>{
    await addEntry();
    await call(userA,path('/comments'),{body:'Before delete'});
    await call(userA,'/v1/entries/'+baseEntry.id+'/delete',{});
    await expect(call(userA,path('/comments'))).rejects.toMatchObject({status:404});
    await expect(call(userA,path('/comments'),{body:'After delete'})).rejects.toMatchObject({status:404});
    await expect(call(userA,'/v1/entries/'+baseEntry.id+'/like',{})).rejects.toMatchObject({status:404});
  });
});

describe('entry reactions',()=>{
  it('toggles a like and reports the full count',async()=>{
    await addEntry();
    expect((await call(userB,path('/like'),{})).data).toEqual({liked:true,count:1});
    expect((await call(userB,path('/like'),{})).data).toEqual({liked:false,count:0});
    expect((await call(userA,path('/like'),{})).data).toEqual({liked:true,count:1});
    expect((await call(userB,path('/like'),{})).data).toEqual({liked:true,count:2});

    expect((await snapshot(userA)).entries[0]).toMatchObject({likeCount:2,likedByMe:true});
    expect((await snapshot(userB)).entries[0]).toMatchObject({likeCount:2,likedByMe:true});
    await expect(call(outsider,path('/like'),{})).rejects.toMatchObject({status:403});
    await expect(call(userA,'/v1/entries/missing-entry/like',{})).rejects.toMatchObject({status:404});
  });
});

describe('snapshot counters',()=>{
  it('reports comment and like counts for the authenticated viewer',async()=>{
    await addEntry();
    await call(userA,path('/comments'),{body:'One'});
    await call(userB,path('/comments'),{body:'Two'});
    await call(userA,path('/like'),{});
    await call(userB,path('/like'),{});

    for(const user of [userA,userB]) {
      expect((await snapshot(user)).entries[0]).toMatchObject({commentCount:2,likeCount:2,likedByMe:true});
    }
    await env.DB.prepare('DELETE FROM entry_reactions WHERE user_id=?').bind(userB).run();
    expect((await snapshot(userA)).entries[0]).toMatchObject({commentCount:2,likeCount:1,likedByMe:true});
  });
});

describe('group settings',()=>{
  it('updates the name and simplify preference for any member',async()=>{
    expect((await snapshot(userA)).groups[0]).toMatchObject({simplify:true,archived:false});
    expect((await call(userB,'/v1/groups/'+group+'/update',{name:'  Patagonia  ',simplify:false})).data).toEqual({ok:true});
    let saved=(await snapshot(userA)).groups[0];
    expect(saved).toMatchObject({name:'Patagonia',simplify:false,archived:false,currency:'USD'});

    await call(userA,'/v1/groups/'+group+'/update',{simplify:true});
    saved=(await snapshot(userB)).groups[0];
    expect(saved.simplify).toBe(true);

    await expect(call(userA,'/v1/groups/'+group+'/update',{name:'   '})).rejects.toThrow('80');
    await expect(call(userA,'/v1/groups/'+group+'/update',{name:'x'.repeat(81)})).rejects.toThrow('80');
    await expect(call(userA,'/v1/groups/'+group+'/update',{simplify:'yes'})).rejects.toThrow('simplify');
    await expect(call(userA,'/v1/groups/'+group+'/update',{currency:'XYZ'})).rejects.toThrow('currency');
    await expect(call(outsider,'/v1/groups/'+group+'/update',{name:'Hijack'})).rejects.toMatchObject({status:403});
  });

  it('only changes currency before the group has entries',async()=>{
    expect((await call(userA,'/v1/groups/'+group+'/update',{currency:'EUR'})).data).toEqual({ok:true});
    expect((await snapshot(userA)).groups[0].currency).toBe('EUR');

    await addEntry({currency:'EUR'});
    await expect(call(userB,'/v1/groups/'+group+'/update',{currency:'USD'})).rejects.toThrow("Delete this group's expenses");
    expect((await snapshot(userA)).groups[0].currency).toBe('EUR');
    expect(await call(userA,'/v1/groups/'+group+'/update',{currency:'EUR'})).toEqual({status:200,data:{ok:true}});
  });

  it('archives and restores a group for members only',async()=>{
    expect((await call(userA,'/v1/groups/'+group+'/archive',{archived:true})).data).toEqual({ok:true});
    expect((await snapshot(userB)).groups[0].archived).toBe(true);
    await call(userB,'/v1/groups/'+group+'/archive',{archived:false});
    expect((await snapshot(userA)).groups[0].archived).toBe(false);
    await expect(call(userA,'/v1/groups/'+group+'/archive',{archived:'yes'})).rejects.toThrow('archive');
    await expect(call(outsider,'/v1/groups/'+group+'/archive',{archived:true})).rejects.toMatchObject({status:403});
  });
});

describe('leaving a group',()=>{
  it('removes only the caller and deletes the group with its social rows when the last member leaves',async()=>{
    await addEntry();
    await call(userA,path('/comments'),{body:'See you'});
    await call(userB,path('/like'),{});
    await expect(call(outsider,'/v1/groups/'+group+'/leave',undefined,'POST')).rejects.toMatchObject({status:403});

    expect((await call(userA,'/v1/groups/'+group+'/leave',undefined,'POST')).data).toEqual({ok:true});
    const remaining=await snapshot(userB);
    expect(remaining.groups).toHaveLength(1);
    expect(remaining.groups[0].members.map((m:any)=>m.id)).toEqual([seatB]);
    expect(remaining.entries).toHaveLength(1);
    expect((await snapshot(userA)).groups).toEqual([]);

    expect((await call(userB,'/v1/groups/'+group+'/leave',undefined,'POST')).data).toEqual({ok:true});
    const count=async(table:string,column:string,value:string)=>((await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).bind(value).first<{n:number}>())?.n??0);
    expect(await count('groups','id',group)).toBe(0);
    expect(await count('members','group_id',group)).toBe(0);
    expect(await count('entries','group_id',group)).toBe(0);
    expect(await count('entry_comments','group_id',group)).toBe(0);
    expect(await count('entry_reactions','entry_id',baseEntry.id)).toBe(0);
    expect((await snapshot(userB)).groups).toEqual([]);
  });
});

describe('payers, notes and adjustment mode',()=>{
  it('credits every payer in balances and keeps settlements single-payer',()=>{
    const payers=[{memberID:seatA,amount:600},{memberID:seatB,amount:400}];
    const entry=validateEntry({...baseEntry,payers,splits:[{memberID:seatA,amount:100},{memberID:seatB,amount:900}]},[seatA,seatB]);
    expect(entry.payers).toEqual(payers);
    expect(balances([entry],'USD')).toEqual({[seatA]:500,[seatB]:-500});
    expect(simplify(balances([entry],'USD'))).toEqual([{from:seatB,to:seatA,amount:500}]);
    expect(validateEntry(baseEntry,[seatA,seatB]).payers).toBeUndefined();

    expect(()=>validateEntry({...baseEntry,payers:[{memberID:seatA,amount:900},{memberID:seatB,amount:200}]},[seatA,seatB])).toThrow('match the total');
    expect(()=>validateEntry({...baseEntry,payers:[{memberID:seatA,amount:700},{memberID:seatA,amount:300}]},[seatA,seatB])).toThrow('Check who paid');
    expect(()=>validateEntry({...baseEntry,payers:[{memberID:'stranger-seat',amount:1000}]},[seatA,seatB])).toThrow('Check who paid');
    expect(()=>validateEntry({...baseEntry,payers:[{memberID:seatB,amount:1000}]},[seatA,seatB])).toThrow('recorded this expense');

    const settlement={...baseEntry,kind:'settlement' as const,amount:500,paidBy:seatA,
      splits:[{memberID:seatB,amount:500}],payers:[{memberID:seatA,amount:500}]};
    expect(validateEntry(settlement,[seatA,seatB]).payers).toEqual([{memberID:seatA,amount:500}]);
    expect(validateEntry({...settlement,payers:undefined},[seatA,seatB]).payers).toBeUndefined();
    expect(()=>validateEntry({...settlement,payers:[{memberID:seatA,amount:250},{memberID:seatB,amount:250}]},[seatA,seatB])).toThrow('two different');
  });

  it('round-trips payers, notes and adjustment mode while whitelisting the wire model',async()=>{
    const payers=[{memberID:seatA,amount:700},{memberID:seatB,amount:300}];
    await addEntry({payers,notes:'  Split taxi  ',splitMode:'adjustment',splits:[{memberID:seatA,amount:100},{memberID:seatB,amount:900}],hacked:true});
    const saved=(await snapshot(userA)).entries[0];
    expect(saved).toMatchObject({payers,notes:'Split taxi',splitMode:'adjustment',amount:1000});
    expect(saved.hacked).toBeUndefined();
  });

  it('validates note text',()=>{
    expect(validateEntry({...baseEntry,notes:'  hello  '},[seatA,seatB]).notes).toBe('hello');
    expect(validateEntry({...baseEntry,notes:'x'.repeat(2000)},[seatA,seatB]).notes).toHaveLength(2000);
    for(const notes of ['   ','x'.repeat(2001),42]) {
      expect(()=>validateEntry({...baseEntry,notes} as Entry,[seatA,seatB])).toThrow('2,000');
    }
  });
});

describe('expense disputes', () => {
  async function prepare() {
    const entry = await addEntry();
    await env.DB.prepare('INSERT INTO members(id,group_id,user_id,name) VALUES (?,?,?,?)')
      .bind('seat-nonparticipant',group,'user-nonparticipant','Nonparticipant').run();
    return entry;
  }

  it('requires membership, a share and a reason, and creates a pending expense, reply thread and notification', async () => {
    await prepare();
    for (const suffix of ['/dispute']) {
      await expect(call(outsider,path(suffix))).rejects.toMatchObject({status:404});
      await expect(call(outsider,path(suffix),{comment:'wrong group'})).rejects.toMatchObject({status:404});
    }
    await expect(call('user-nonparticipant',path('/dispute'),{comment:'No share'})).rejects.toMatchObject({status:403});
    await expect(call(userB,path('/dispute'),{comment:'   '})).rejects.toThrow('2,000');
    expect((await call(userB,path('/dispute'),{comment:'I was not there'})).status).toBe(201);
    await expect(call(userB,path('/dispute'),{comment:'again'})).rejects.toMatchObject({status:409});
    expect((await snapshot(userB)).entries[0]).toMatchObject({pending:true});
    expect((await call(userA,'/v1/disputes')).data.disputes).toEqual([
      expect.objectContaining({entryID:baseEntry.id,canResolve:true,canWithdraw:false,comment:'I was not there'}),
    ]);
    expect((await call(outsider,'/v1/disputes')).data.disputes).toEqual([]);
    expect((await call(outsider,'/v1/disputes/activity')).data.events).toEqual([]);
    const { comments } = (await call(userA,path('/comments'))).data;
    expect(comments[0].body).toContain('I was not there');
    await expect(call(userB,path('/comments/'+comments[0].id),undefined,'DELETE')).rejects.toMatchObject({status:409});
    expect(await env.DB.prepare("SELECT user_id FROM email_activity WHERE kind='disputes'").first('user_id')).toBe(userA);
  });

  it('requires the payer or recorder to dismiss with a reply, and protects pending from other routes', async () => {
    const entry = await prepare();
    await call(userB,path('/dispute'),{comment:'Wrong amount'});
    await expect(call(userB,path('/dispute'),{action:'dismiss',comment:'Looks fine'})).rejects.toMatchObject({status:403});
    await expect(call(outsider,path('/dispute'),{action:'dismiss',comment:'Looks fine'})).rejects.toMatchObject({status:404});
    await expect(call(userA,path('/dispute'),{action:'dismiss'})).rejects.toThrow('2,000');
    await expect(call(userA,path('/resolve'),{action:'confirm'})).rejects.toMatchObject({status:409});
    await expect(call(userA,path('/pending'),{pending:false})).rejects.toMatchObject({status:409});
    await expect(call(userA,path('/delete'),{})).rejects.toMatchObject({status:409});
    await call(userA,path('/dispute'),{action:'dismiss',comment:'The posted amount matches the receipt.'});
    expect((await snapshot(userB)).entries[0].pending).toBeUndefined();
    expect((await snapshot(userB)).entries[0].amount).toBe(entry.amount);
    expect((await call(userB,path('/dispute'))).data.history.map((e:any) => e.action)).toEqual(['opened','dismissed']);
    expect((await call(userB,'/v1/disputes/activity')).data.events.map((e:any) => e.action)).toEqual(['dismissed','opened']);
    const { events } = (await call(userB,'/v1/groups/'+group+'/history?expense='+baseEntry.id)).data;
    expect(events.filter((event:any) => event.action.startsWith('dispute'))).toEqual([
      expect.objectContaining({action:'dispute-dismiss',actor:userA,reason:'The posted amount matches the receipt.'}),
      expect.objectContaining({action:'dispute',actor:userB,reason:'Wrong amount'}),
    ]);
  });

  it('lets only the disputer withdraw', async () => {
    await prepare();
    await call(userB,path('/dispute'),{comment:'Wrong person'});
    await expect(call(userA,path('/dispute'),{action:'withdraw'})).rejects.toMatchObject({status:403});
    await expect(call(outsider,path('/dispute'),{action:'withdraw'})).rejects.toMatchObject({status:404});
    await call(userB,path('/dispute'),{action:'withdraw'});
    expect((await call(userA,'/v1/disputes')).data.disputes).toEqual([]);
    expect((await snapshot(userA)).entries[0].pending).toBeUndefined();
    expect((await call(userA,path('/comments'))).data.comments.at(-1).body).toBe('Withdrew dispute');
    const { events } = (await call(userA,'/v1/groups/'+group+'/history?expense='+baseEntry.id)).data;
    expect(events[0]).toMatchObject({action:'dispute-withdraw',actor:userB});
  });

  it('lets a payer who did not record the expense edit with a reply and clears pending atomically', async () => {
    await prepare();
    const payerEntry = await addEntry({id:'payer-edit',paidBy:seatB,category:'Dining',notes:'Dinner for the group'});
    const editPath = '/v1/entries/payer-edit/edit';
    await call(userA,'/v1/entries/payer-edit/dispute',{comment:'Only $8'});
    const original = {...payerEntry,pending:true};
    const entry = {...original,amount:800,splits:[{memberID:seatA,amount:400},{memberID:seatB,amount:400}]};
    await expect(call('user-nonparticipant',editPath,{original,entry,disputeReply:'Updated'})).rejects.toMatchObject({status:403});
    await expect(call(outsider,editPath,{original,entry,disputeReply:'Updated'})).rejects.toMatchObject({status:403});
    await expect(call(userB,editPath,{original,entry})).rejects.toThrow('2,000');
    await expect(call(userB,editPath,{original,entry:{...original,title:'Rename'},disputeReply:'Updated'})).rejects.toThrow('amount, split or participants');
    await call(userB,editPath,{original,entry,disputeReply:'Updated'});
    expect((await snapshot(userB)).entries.find(e => e.id==='payer-edit')).toMatchObject({amount:800});
    expect((await snapshot(userB)).entries.find(e => e.id==='payer-edit').pending).toBeUndefined();
    expect((await call(userA,'/v1/disputes')).data.disputes).toEqual([]);
    expect((await call(userA,'/v1/entries/payer-edit/comments')).data.comments.at(-1).body).toBe('Resolved by editing: Updated');
    const { events } = (await call(userA,'/v1/groups/'+group+'/history?expense=payer-edit')).data;
    expect(events[0]).toMatchObject({action:'dispute-edit',actor:userB,reason:'Updated'});
    expect(events[1]).toMatchObject({action:'edit',actor:userB,changes:{amount:{before:1000,after:800}}});
    await expect(call(userB,editPath,{original,entry,disputeReply:'Updated'})).rejects.toMatchObject({status:403});
  });
});
