import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {handle} from '../src/index';
import {operate} from '../src/cli/operations';
import {Entry} from '../src/ledger';
import {Bill,breakdown,grossItems,itemSplit} from '../src/items';

const group='receipt-group',payer='seat-alex',other='seat-maya',guest='seat-jules';
function call(user:string,path:string,b?:unknown) {
  return handle(new Request(env.APP_URL+path,b===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env,user);
}
const bill:Bill={items:[{id:'line-coffee',title:'Coffee',amount:501,memberIDs:[payer,other]},
  {id:'line-toast',title:'Toast',amount:999,memberIDs:[]}],tax:101,tip:200,closed:false};
const e:Entry={id:'receipt-entry',groupID:group,title:'Brunch',amount:1801,currency:'USD',paidBy:payer,
  splits:itemSplit(bill,payer),kind:'expense',splitMode:'exact',createdAt:'2026-11-17T12:00:00Z',category:'Dining',bill};
const base='/v1/entries/'+e.id;
const photo={id:'photo-test',data:btoa(String.fromCharCode(255,216,255,224,0,8,255,217))};
async function snapshot(user='alex') {return (await (await call(user,'/v1/snapshot')).json<{entries:Entry[]}>()).entries[0];}
beforeEach(async()=>{
  await call('alex','/v1/groups',{id:group,name:'Weekend',kind:'trip',currency:'USD',members:[{id:payer,name:'Alex',userID:'alex'},{id:other,name:'Maya'},{id:guest,name:'Jules'}]});
  await env.DB.prepare('UPDATE members SET user_id=? WHERE id=?').bind('maya',other).run();
});
it('conserves cents including open items and excludes settlements from spending',()=>{
  expect(grossItems(bill).map(i=>i.gross)).toEqual([602,1199]);
  expect(e.splits).toEqual([{memberID:payer,amount:1500},{memberID:other,amount:301}]);
  const report=breakdown([e,{...e,kind:'settlement',amount:100,paidBy:other,splits:[{memberID:payer,amount:100}]}],[{id:payer,name:'Alex'},{id:other,name:'Maya'}],'USD');
  expect(report).toMatchObject({total:1801,months:{'2026-11':1801},categories:{Dining:1801},members:[{paid:1801,share:1500,net:201},{paid:0,share:301,net:-201}]});
});
it('shares, reopens and closes remaining purchases, rejecting stale and outsider claims',async()=>{
  await call('alex','/v1/entries',e);
  const claim={itemID:'line-toast',memberIDs:[other,guest],original:[]};
  await expect(call('outsider',base+'/claim',claim)).rejects.toThrow('not found');
  await call('maya',base+'/claim',claim);
  await expect(call('alex',base+'/claim',{...claim,memberIDs:[payer]})).rejects.toThrow('claims changed');
  expect((await snapshot()).splits).toEqual([{memberID:payer,amount:301},{memberID:other,amount:901},{memberID:guest,amount:599}]);
  await call('maya',base+'/claim',{...claim,original:[other,guest],memberIDs:[]});
  const cmd=(name:string,args:object,user='alex')=>operate(name,{group,...args},env,user,handle);
  expect(await cmd('items_open',{})).toMatchObject([{gross:1199}]);
  await cmd('items_claim',{expense:e.id,item:'line-toast'},'maya');
  expect(await cmd('items_open',{})).toEqual([]);
  await cmd('items_claim',{expense:e.id,item:'line-toast',action:'remove'},'maya');
  await expect(call('maya',base+'/close',{memberIDs:[other]})).rejects.toThrow('Only the payer');
  await cmd('items_close',{expense:e.id,participants:[guest]});
  expect((await snapshot('maya')).bill).toMatchObject({closed:true,items:[{memberIDs:[payer,other]},{memberIDs:[guest]}]});
  await expect(call('alex',base+'/claim',claim)).rejects.toThrow('closed');
});
it('stores photos atomically and privately, handles retries, caps attachments and frees bytes on delete',async()=>{
  await expect(call('alex','/v1/entries',{...e,photos:[{...photo,data:'invalid'}]})).rejects.toThrow();
  expect(await snapshot()).toBeUndefined();
  const data={...e,photos:[photo]};
  await call('alex','/v1/entries',data); await call('alex','/v1/entries',data);
  expect((await snapshot('maya')).receiptIDs).toEqual([photo.id]);
  const path=base+'/receipts/'+photo.id;
  await expect(call('outsider',path)).rejects.toThrow('not found');
  const image=await call('maya',path);
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([255,216,255,224,0,8,255,217]);
  expect(image.headers.get('cache-control')).toContain('no-store');
  const extras=[1,2,3,4].map(i=>({...photo,id:'another-photo-'+i}));
  await expect(call('alex',base+'/edit',{original:e,entry:{...e,title:'Updated'},photos:extras})).rejects.toThrow();
  expect((await snapshot()).title).toBe(e.title);
  await call('alex',base+'/delete',{});
  await expect(call('maya',path)).rejects.toThrow('not found');
  expect(await env.DB.prepare('SELECT bytes FROM receipt_usage').first('bytes')).toBe(0);
});
it('retains both historical shares and rounding order when a placeholder merges into another claimant',async()=>{
  const shared={...bill,items:[{...bill.items[0],memberIDs:[other,payer,guest]},bill.items[1]]};
  const before={...e,bill:shared,splits:itemSplit(shared,payer)};
  await call('alex','/v1/entries',before);
  await env.DB.prepare('INSERT INTO member_aliases VALUES (?,?)').bind(guest,other).run();
  const after=await snapshot();
  expect(after.bill?.items[0].memberIDs).toEqual([other,payer]);
  const paidShare=before.splits.find(p=>p.memberID===payer)!.amount;
  expect(after.splits.find(p=>p.memberID===payer)?.amount).toBe(paidShare);
  await call('alex',base+'/edit',{original:after,entry:{...after,title:'Updated receipt'}});
  await call('maya',base+'/claim',{original:[other,payer],itemID:shared.items[0].id,memberIDs:[other]});
  expect((await snapshot()).bill?.items[0].roundingSeats).toBeUndefined();
});
it('merges a claimant draft onto a different member’s saved edit',async()=>{
  await call('alex','/v1/entries',e);
  await call('maya',base+'/claim',{itemID:'line-toast',original:[],memberIDs:[other],mergeEdits:true});
  await call('alex',base+'/claim',{itemID:'line-toast',original:[],memberIDs:[guest],mergeEdits:true});
  expect((await snapshot()).bill?.items[1].memberIDs).toEqual([other,guest]);
});
