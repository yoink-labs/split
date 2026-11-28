import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {handle} from '../src/index';
import {operate} from '../src/cli/operations';
import {Entry} from '../src/ledger';
import {Bill,billConsumption,consumptionReport,entryConsumption,itemSplit} from '../src/items';

const group='inbox-group',other='other-group';
const alex='seat-alex',maya='seat-maya',jules='seat-jules',sam='seat-sam';
function call(user:string,path:string,b?:unknown) {
  return handle(new Request(env.APP_URL+path,b===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env,user);
}
const jpeg=(n:number)=>btoa(String.fromCharCode(255,216,255,224,n,8,255,217));
const expense=(id:string,groupID=group,paidBy=alex,members=[alex,maya]):Entry=>({id,groupID,title:'Dinner '+id,amount:1000,currency:'USD',paidBy,
  splits:[{memberID:members[0],amount:500},{memberID:members[1],amount:500}],kind:'expense',splitMode:'exact',createdAt:'2026-11-20T12:00:00Z'});
const inbox=async(user='alex',g=group)=>(await (await call(user,`/v1/groups/${g}/receipts`)).json<{receipts:{id:string;uploadedBy:string;note?:string;bytes:number}[]}>()).receipts;
const attached=async(id:string,user='alex')=>(await (await call(user,'/v1/snapshot')).json<{entries:Entry[]}>()).entries.find(e=>e.id===id)?.receiptIDs;
const usage=async()=>env.DB.prepare('SELECT bytes FROM receipt_usage WHERE id=1').first<number>('bytes');

beforeEach(async()=>{
  await env.DB.prepare('UPDATE receipt_usage SET bytes=0 WHERE id=1').run();
  await call('alex','/v1/groups',{id:group,name:'Trip',kind:'trip',currency:'USD',members:[{id:alex,name:'Alex',userID:'alex'},{id:maya,name:'Maya'},{id:jules,name:'Jules'}]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('maya',maya).run();
  await call('sam','/v1/groups',{id:other,name:'Elsewhere',kind:'home',currency:'USD',members:[{id:sam,name:'Sam',userID:'sam'},{id:'seat-sam-2',name:'Pat'}]});
  for(const id of ['expense-one','expense-two']) await call('alex','/v1/entries',expense(id));
  await call('sam','/v1/entries',expense('expense-far',other,sam,[sam,'seat-sam-2']));
});

it('uploads to the inbox, pairs to an expense and frees the inbox row',async()=>{
  expect((await call('maya',`/v1/groups/${group}/receipts`,{id:'receipt-aaa',data:jpeg(1),note:'  Taxi  '})).status).toBe(201);
  expect((await call('maya',`/v1/groups/${group}/receipts`,{id:'receipt-aaa',data:jpeg(1)})).status).toBe(200);
  expect(await inbox()).toEqual([expect.objectContaining({id:'receipt-aaa',uploadedBy:maya,note:'Taxi',bytes:8})]);
  expect(await usage()).toBe(8);
  const image=await call('alex',`/v1/groups/${group}/receipts/receipt-aaa`);
  expect(image.headers.get('content-type')).toBe('image/jpeg');
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([255,216,255,224,1,8,255,217]);

  expect(await (await call('alex',`/v1/groups/${group}/receipts/receipt-aaa/pair`,{entryID:'expense-one'})).json()).toEqual({ok:true,entryID:'expense-one',receiptID:'receipt-aaa'});
  expect(await inbox()).toEqual([]);
  expect(await attached('expense-one','maya')).toEqual(['receipt-aaa']);
  expect(await usage()).toBe(8);
  // Retrying a pair that already happened succeeds without duplicating anything.
  expect((await call('alex',`/v1/groups/${group}/receipts/receipt-aaa/pair`,{entryID:'expense-one'})).status).toBe(200);
  expect((await call('maya','/v1/entries/expense-one/receipts/receipt-aaa')).status).toBe(200);
  await expect(call('alex',`/v1/groups/${group}/receipts`,{id:'receipt-bad',data:btoa('%PDF-1.4')})).rejects.toThrow('PDF');
});

it('re-pairs a receipt to another expense, back to the inbox, and honours the four-receipt limit',async()=>{
  await call('alex',`/v1/groups/${group}/receipts`,{id:'receipt-move',data:jpeg(2)});
  await call('alex',`/v1/groups/${group}/receipts/receipt-move/pair`,{entryID:'expense-one'});
  await call('maya','/v1/entries/expense-one/receipts/receipt-move/move',{entryID:'expense-two'});
  expect(await attached('expense-one')).toEqual([]);
  expect(await attached('expense-two')).toEqual(['receipt-move']);
  await call('maya','/v1/entries/expense-two/receipts/receipt-move/move',{entryID:null});
  expect(await attached('expense-two')).toEqual([]);
  expect(await inbox()).toEqual([expect.objectContaining({id:'receipt-move',uploadedBy:maya})]);
  expect(await usage()).toBe(8);

  await call('alex','/v1/entries/expense-two/edit',{original:expense('expense-two'),entry:expense('expense-two'),photos:[1,2,3,4].map(n=>({id:'photo-full-'+n,data:jpeg(n)}))});
  expect(await attached('expense-two')).toHaveLength(4);
  await expect(call('alex',`/v1/groups/${group}/receipts/receipt-move/pair`,{entryID:'expense-two'})).rejects.toThrow('up to four');
  await call('alex',`/v1/groups/${group}/receipts/receipt-move/pair`,{entryID:'expense-one'});
  await expect(call('alex','/v1/entries/expense-one/receipts/receipt-move/move',{entryID:'expense-two'})).rejects.toThrow('up to four');
  expect(await attached('expense-one')).toEqual(['receipt-move']);
  // Deleting the expense removes its receipts and their storage.
  await call('alex','/v1/entries/expense-two/delete',{});
  expect(await usage()).toBe(8);
});

it('keeps every receipt route inside the viewer’s group',async()=>{
  await call('alex',`/v1/groups/${group}/receipts`,{id:'receipt-mine',data:jpeg(3)});
  await call('sam',`/v1/groups/${other}/receipts`,{id:'receipt-sams',data:jpeg(4)});
  // Outsiders cannot list, read, upload, pair or delete.
  await expect(call('sam',`/v1/groups/${group}/receipts`)).rejects.toThrow('not a member');
  await expect(call('sam',`/v1/groups/${group}/receipts/receipt-mine`)).rejects.toThrow('not a member');
  await expect(call('sam',`/v1/groups/${group}/receipts`,{id:'receipt-sneak',data:jpeg(5)})).rejects.toThrow('not a member');
  await expect(call('sam',`/v1/groups/${group}/receipts/receipt-mine/pair`,{entryID:'expense-far'})).rejects.toThrow('not a member');
  await expect(call('sam',`/v1/groups/${group}/receipts/receipt-mine/delete`,{})).rejects.toThrow('not a member');
  // A member cannot reach another group's receipt through their own group's path.
  await expect(call('alex',`/v1/groups/${group}/receipts/receipt-sams`)).rejects.toThrow('not found');
  await expect(call('alex',`/v1/groups/${group}/receipts/receipt-sams/pair`,{entryID:'expense-one'})).rejects.toThrow('not found');
  // Nor pair or move a receipt onto another group's expense.
  await expect(call('alex',`/v1/groups/${group}/receipts/receipt-mine/pair`,{entryID:'expense-far'})).rejects.toThrow('not found');
  await call('alex',`/v1/groups/${group}/receipts/receipt-mine/pair`,{entryID:'expense-one'});
  await expect(call('alex','/v1/entries/expense-one/receipts/receipt-mine/move',{entryID:'expense-far'})).rejects.toThrow('not found');
  await expect(call('sam','/v1/entries/expense-one/receipts/receipt-mine/move',{entryID:'expense-far'})).rejects.toThrow('not found');
  await expect(call('sam','/v1/entries/expense-one/receipts/receipt-mine/move',{entryID:null})).rejects.toThrow('not found');
  // Downloading another group's attached receipt is refused.
  await expect(call('sam','/v1/entries/expense-one/receipts/receipt-mine')).rejects.toThrow('not found');
  expect(await attached('expense-one')).toEqual(['receipt-mine']);
  expect(await inbox('sam',other)).toEqual([expect.objectContaining({id:'receipt-sams'})]);
});

it('limits deleting to the uploader and archived members to reading',async()=>{
  await call('maya',`/v1/groups/${group}/receipts`,{id:'receipt-maya',data:jpeg(6)});
  await expect(call('alex',`/v1/groups/${group}/receipts/receipt-maya/delete`,{})).rejects.toThrow('uploaded');
  await env.DB.prepare('UPDATE members SET removed_at=? WHERE id=?').bind('2026-11-21T00:00:00Z',maya).run();
  await expect(call('maya',`/v1/groups/${group}/receipts/receipt-maya/delete`,{})).rejects.toThrow('archived');
  await expect(call('maya',`/v1/groups/${group}/receipts/receipt-maya/pair`,{entryID:'expense-one'})).rejects.toThrow('archived');
  expect(await inbox('maya')).toHaveLength(1);
  await env.DB.prepare('UPDATE members SET removed_at=NULL WHERE id=?').bind(maya).run();
  await call('maya',`/v1/groups/${group}/receipts/receipt-maya/delete`,{});
  expect(await inbox()).toEqual([]);
  expect(await usage()).toBe(0);
});

it('lets CLI and MCP manage the inbox',async()=>{
  const cmd=(name:string,args:object,user='alex')=>operate(name,{group,...args},env,user,handle);
  const big=btoa(String.fromCharCode(255,216,255,224,...new Array(20).fill(7),255,217));
  const added=await cmd('receipts_upload',{photos:[big],note:'Lunch'}) as {uploaded:string[]};
  expect(await cmd('receipts_inbox',{})).toEqual([expect.objectContaining({id:added.uploaded[0],note:'Lunch',uploadedByName:'Alex'})]);
  expect(await cmd('receipts_get',{photo:added.uploaded[0]})).toEqual({mimeType:'image/jpeg',data:big});
  await expect(cmd('receipts_inbox',{},'sam')).rejects.toThrow('Group not found');
  await cmd('receipts_pair',{photo:added.uploaded[0],expense:'expense-one'});
  expect(await cmd('receipts_list',{expense:'expense-one'})).toEqual(added.uploaded);
  await cmd('receipts_move',{photo:added.uploaded[0],expense:'expense-one',to:'expense-two'});
  expect(await cmd('receipts_list',{expense:'expense-two'})).toEqual(added.uploaded);
  await cmd('receipts_move',{photo:added.uploaded[0],expense:'expense-two',to:'inbox'});
  expect(await cmd('receipts_inbox',{})).toHaveLength(1);
  await cmd('receipts_delete',{photo:added.uploaded[0]});
  expect(await cmd('receipts_inbox',{})).toEqual([]);
  const report=await cmd('items_report',{member:maya}) as {currency:string;people:{name:string;amount:number;lines:{expenseTitle:string}[]}[]}[];
  expect(report).toMatchObject([{currency:'USD',people:[{name:'Maya',amount:1000,lines:[{expenseTitle:'Dinner expense-one'},{expenseTitle:'Dinner expense-two'}]}]}]);
});

const bill:Bill={items:[
  {id:'item-wine',title:'Wine',amount:3333,memberIDs:[alex,maya,jules]},
  {id:'item-pasta',title:'Pasta',amount:1999,memberIDs:[maya],},
  {id:'item-salad',title:'Salad',amount:1001,memberIDs:[alex,jules],shares:{[alex]:200,[jules]:100}},
  {id:'item-bread',title:'Bread',amount:7,memberIDs:[]}],tax:523,tip:1111,closed:false};

it('allocates item claims, tax and tip exactly to the cent',()=>{
  const {items,people}=billConsumption(bill,alex);
  const split=itemSplit(bill,alex);
  const total=bill.items.reduce((s,i)=>s+i.amount,bill.tax+bill.tip);
  expect(people.reduce((s,p)=>s+p.amount,0)).toBe(total);
  for(const p of people) {
    expect(p.items+p.tax+p.tip).toBe(p.amount);
    expect(p.amount).toBe(split.find(s=>s.memberID===p.memberID)!.amount);
  }
  expect(people.reduce((s,p)=>s+p.tax,0)).toBe(bill.tax);
  expect(people.reduce((s,p)=>s+p.tip,0)).toBe(bill.tip);
  expect(people.reduce((s,p)=>s+p.items,0)).toBe(total-bill.tax-bill.tip);
  for(const i of items) {
    expect(i.portions.reduce((s,p)=>s+p.items,0)).toBe(i.amount);
    expect(i.portions.reduce((s,p)=>s+p.tax,0)).toBe(i.tax);
    expect(i.portions.reduce((s,p)=>s+p.tip,0)).toBe(i.tip);
    expect(i.portions.reduce((s,p)=>s+p.amount,0)).toBe(i.gross);
  }
  expect(items.reduce((s,i)=>s+i.tax,0)).toBe(bill.tax);
  // Unclaimed items stay with the payer; the salad splits two to one.
  expect(items[3]).toMatchObject({open:true,portions:[{memberID:alex,items:7}]});
  expect(items[2].portions.map(p=>p.items)).toEqual([667,334]);
});

it('keeps every part exact and non-negative for many random receipts',()=>{
  let seed=7;
  const rand=(n:number)=>(seed=(seed*1103515245+12345)%2147483648)%n;
  const seats=[alex,maya,jules,sam,'seat-five'];
  for(let run=0;run<400;run++) {
    const items=Array.from({length:1+rand(6)},(_,k)=>{
      const memberIDs=seats.filter(()=>rand(3)===0);
      const shares=memberIDs.length && rand(2) ? Object.fromEntries(memberIDs.map(id=>[id,1+rand(400)])) : undefined;
      return {id:'item-random-'+k,title:'Item',amount:1+rand(rand(2) ? 20 : 50000),memberIDs,...(shares?{shares}:{})};
    });
    const b:Bill={items,tax:rand(3) ? rand(900) : 0,tip:rand(2) ? rand(3000) : 0,closed:false};
    const payer=seats[rand(5)];
    const {items:rows,people}=billConsumption(b,payer);
    const split=itemSplit(b,payer);
    for(const p of people) expect(p.amount).toBe(split.find(s=>s.memberID===p.memberID)!.amount);
    expect(people.reduce((s,p)=>s+p.tax,0)).toBe(b.tax);
    expect(people.reduce((s,p)=>s+p.tip,0)).toBe(b.tip);
    for(const r of rows) for(const p of r.portions) {
      expect(Math.min(p.items,p.tax,p.tip)).toBeGreaterThanOrEqual(0);
      expect(p.items+p.tax+p.tip).toBe(p.amount);
    }
    expect(people.reduce((s,p)=>s+p.amount,0)).toBe(split.reduce((s,p)=>s+p.amount,0));
  }
});

it('reports claimed items through the ledger exactly as stored splits',async()=>{
  const total=bill.items.reduce((s,i)=>s+i.amount,bill.tax+bill.tip);
  const e:Entry={id:'expense-itemized',groupID:group,title:'Trattoria',amount:total,currency:'USD',paidBy:alex,
    splits:itemSplit(bill,alex),kind:'expense',splitMode:'exact',createdAt:'2026-11-22T20:00:00Z',bill};
  await call('alex','/v1/entries',e);
  await call('maya','/v1/entries/expense-itemized/claim',{itemID:'item-bread',original:[],memberIDs:[maya,jules]});
  const saved=(await (await call('alex','/v1/snapshot')).json<{entries:Entry[]}>()).entries.find(x=>x.id===e.id)!;
  const lines=entryConsumption(saved);
  for(const s of saved.splits) expect(lines.filter(l=>l.memberID===s.memberID).reduce((n,l)=>n+l.amount,0)).toBe(s.amount);
  expect(lines.filter(l=>l.itemID==='item-bread').map(l=>l.memberID)).toEqual([maya,jules]);
  const report=consumptionReport([saved,expense('expense-plain')],'USD');
  const mayaRow=report.people.find(p=>p.memberID===maya)!;
  expect(mayaRow.lines.find(l=>l.entryID==='expense-plain')).toMatchObject({itemID:null,title:'Dinner expense-plain',amount:500,tax:0,tip:0});
  expect(report.people.reduce((s,p)=>s+p.amount,0)).toBe(total+1000);
  expect(report.people.reduce((s,p)=>s+p.tax,0)).toBe(bill.tax);
});

it('refunds specific items back to exactly the people who had them',async()=>{
  const {itemRefund}=await import('../src/items');
  const total=bill.items.reduce((s,i)=>s+i.amount,bill.tax+bill.tip);
  const e:Entry={id:'expense-refund',groupID:group,title:'Trattoria',amount:total,currency:'USD',paidBy:alex,
    splits:itemSplit(bill,alex),kind:'expense',splitMode:'exact',createdAt:'2026-11-22T20:00:00Z',bill};
  const {items}=billConsumption(bill,alex);
  const refund=itemRefund(e,['item-wine','item-pasta']);
  expect(refund.amount).toBe(items[0].gross+items[1].gross);
  expect(refund.splits.reduce((s,p)=>s+p.amount,0)).toBe(refund.amount);
  expect(refund.splits.find(s=>s.memberID===maya)!.amount).toBe(items[0].portions.find(p=>p.memberID===maya)!.amount+items[1].gross);
  expect(itemRefund(e,bill.items.map(i=>i.id)).amount).toBe(total);
  expect(()=>itemRefund(e,['item-missing'])).toThrow('original receipt');
  expect(()=>itemRefund(expense('expense-plain'),['item-wine'])).toThrow('itemized');
});

it('refunds specific receipt items through the Worker, CLI and MCP',async()=>{
  const total=bill.items.reduce((s,i)=>s+i.amount,bill.tax+bill.tip);
  const e:Entry={id:'expense-items',groupID:group,title:'Trattoria',amount:total,currency:'USD',paidBy:alex,
    splits:itemSplit(bill,alex),kind:'expense',splitMode:'exact',createdAt:'2026-11-22T20:00:00Z',bill};
  await call('alex','/v1/entries',e);
  const {itemRefund}=await import('../src/items');
  const exact=itemRefund(e,['item-wine']);
  const refund={id:'refund-wine',groupID:group,title:'Refund: Wine',amount:exact.amount,currency:'USD',paidBy:alex,splits:exact.splits,
    kind:'refund',splitMode:'exact',createdAt:'2026-11-23T12:00:00Z',refundOf:e.id,refundItems:['item-wine']};
  // Credits that do not match what each person paid for the items are refused.
  const wrong=exact.splits.map((p,i)=>({...p,amount:p.amount+(i===0?1:i===1?-1:0)}));
  await expect(call('alex','/v1/entries',{...refund,splits:wrong})).rejects.toThrow('Refresh the item refund');
  await call('alex','/v1/entries',refund);
  await expect(call('alex','/v1/entries',{...refund,id:'refund-wine-2'})).rejects.toThrow('already been refunded');
  await expect(call('maya','/v1/entries/expense-items/claim',{itemID:'item-wine',original:[alex,maya,jules],memberIDs:[maya]})).rejects.toThrow('refunded');
  const cmd=(name:string,args:object,user='alex')=>operate(name,{group,...args},env,user,handle);
  const pasta=await cmd('refunds_add',{expense:e.id,items:['item-pasta']}) as Entry;
  expect(pasta).toMatchObject({refundItems:['item-pasta'],title:'Refund: Pasta',splits:[{memberID:maya,amount:itemRefund(e,['item-pasta']).amount}]});
  await expect(cmd('refunds_add',{expense:e.id,items:['item-salad'],amount:'1.00'})).rejects.toThrow('Omit amount');
  await expect(cmd('refunds_add',{expense:e.id})).rejects.toThrow('choose items');
  const entries=(await (await call('maya','/v1/snapshot')).json<{entries:Entry[]}>()).entries;
  expect(entries.filter(x=>x.refundOf===e.id).map(x=>x.refundItems)).toEqual(expect.arrayContaining([['item-wine'],['item-pasta']]));
});

it('gives refunded items back in the consumption report',()=>{
  const total=bill.items.reduce((s,i)=>s+i.amount,bill.tax+bill.tip);
  const e:Entry={id:'expense-net',groupID:group,title:'Trattoria',amount:total,currency:'USD',paidBy:alex,
    splits:itemSplit(bill,alex),kind:'expense',splitMode:'exact',createdAt:'2026-11-22T20:00:00Z',bill};
  const wine=billConsumption(bill,alex).items[0];
  const refund:Entry={id:'refund-net',groupID:group,title:'Refund: Wine',amount:wine.gross,currency:'USD',paidBy:alex,
    splits:wine.portions.map(p=>({memberID:p.memberID,amount:p.amount})),kind:'refund',splitMode:'exact',createdAt:'2026-11-23T12:00:00Z',refundOf:e.id,refundItems:['item-wine']};
  const credit:Entry={...refund,id:'credit-net',title:'Credit',amount:100,splits:[{memberID:maya,amount:100}],refundOf:undefined,refundItems:undefined};
  const report=consumptionReport([e,refund,credit],'USD');
  expect(report.people.reduce((s,p)=>s+p.amount,0)).toBe(total-wine.gross-100);
  expect(report.people.reduce((s,p)=>s+p.tax,0)).toBe(bill.tax-wine.tax);
  const mayaRow=report.people.find(p=>p.memberID===maya)!;
  expect(mayaRow.lines.filter(l=>l.itemID==='item-wine').reduce((s,l)=>s+l.amount,0)).toBe(0);
  expect(mayaRow.lines.find(l=>l.entryID==='credit-net')).toMatchObject({title:'Credit',amount:-100});
});
