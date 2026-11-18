import { body, HTTPError, json } from './http';
import { Entry, InputError, validID } from './ledger';
import { itemSplit } from './items';
import { resolveEntry } from './people';

export function attachments(db:D1Database,entry:Entry,user:string,payload:string,photos:unknown) {
  if(photos===undefined) return [];
  if(entry.kind!=='expense' || !Array.isArray(photos) || photos.length>4) throw new InputError('Choose up to four receipt photos.');
  return photos.map(photo=>{
    if(!photo || !validID(photo.id) || typeof photo.data!=='string' || photo.data.length>327680) throw new InputError('Choose a JPEG up to 240 KiB.');
    let binary:string;
    try {binary=atob(photo.data);} catch {throw new InputError('Invalid receipt image.');}
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    if(bytes.length<4 || bytes[0]!==255 || bytes[1]!==216 || bytes[2]!==255 || bytes.at(-2)!==255 || bytes.at(-1)!==217) throw new InputError('Choose a JPEG receipt.');
    return db.prepare(`INSERT INTO receipts(entry_id,id,image) SELECT id,?,? FROM entries
      WHERE id=? AND author=? AND payload=? AND id NOT IN (SELECT entry_id FROM deleted_entries)
      ON CONFLICT(entry_id,id) DO NOTHING`).bind(photo.id,bytes.buffer,entry.id,user,payload);
  });
}
export async function purchaseRoute(req:Request,env:Env,user:string):Promise<Response|undefined> {
  const match=new URL(req.url).pathname.match(/^\/v1\/entries\/([\w-]+)\/(claim|close|receipts)(?:\/([\w-]+))?$/);
  if(!match) return;
  const [,id,action,photo]=match;
  const row=await env.DB.prepare(`SELECT e.payload,m.id AS viewer,e.author FROM entries e JOIN members m ON m.group_id=e.group_id
    WHERE e.id=? AND m.user_id=? AND e.id NOT IN (SELECT entry_id FROM deleted_entries)`).bind(id,user).first<{payload:string;viewer:string;author:string}>();
  if(!row) throw new HTTPError(404,'Expense not found.');
  if(action==='receipts' && req.method==='GET' && photo) {
    const result=await env.DB.prepare('SELECT image FROM receipts WHERE entry_id=? AND id=?').bind(id,photo).first<number[] | ArrayBuffer>('image');
    if(!result) throw new HTTPError(404,'Receipt not found.');
    return new Response(new Uint8Array(result),{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(req.method!=='POST' || photo || action==='receipts') throw new HTTPError(404,'Unknown receipt action.');
  const raw:Entry=JSON.parse(row.payload);
  const seats=(await env.DB.prepare('SELECT m.id,m.user_id,a.canonical_id FROM members m LEFT JOIN member_aliases a ON a.member_id=m.id WHERE m.group_id=? ORDER BY m.rowid').bind(raw.groupID).all<{id:string;user_id:string|null;canonical_id:string|null}>()).results;
  const entry=resolveEntry(raw,new Map(seats.filter(s=>s.canonical_id).map(s=>[s.id,s.canonical_id!])));
  const bill=entry.bill;
  if(!bill || bill.closed) throw new HTTPError(409,'This receipt is closed or has no items.');
  const b=await body(req);
  const ids=b.memberIDs;
  if(!Array.isArray(ids) || ids.length>50 || new Set(ids).size!==ids.length || ids.some(id=>!seats.some(s=>s.id===id && !s.canonical_id))) throw new InputError('Choose group members.');
  if(action==='close') {
    const payer=seats.find(s=>s.id===entry.paidBy);
    if(row.viewer!==entry.paidBy && !(payer?.user_id===null && row.author===user)) throw new HTTPError(403,'Only the payer can close this receipt.');
    if(!ids.length) throw new InputError('Choose who will cover the open items.');
    for(const i of bill.items) if(!i.memberIDs.length) i.memberIDs=ids;
    bill.closed=true;
  } else {
    const item=bill.items.find(i=>i.id===b.itemID);
    if(!item) throw new HTTPError(404,'Item not found.');
    if(!Array.isArray(b.original)) throw new InputError('Include the original claimants.');
    let next=ids;
    if(b.mergeEdits===true) {
      const original=b.original;
      if(original.length>50 || original.some(id=>typeof id!=='string' || !seats.some(s=>s.id===id && !s.canonical_id))) throw new InputError('Refresh the group members.');
      const removed=new Set(original.filter(id=>!ids.includes(id)));
      next=[...new Set([...item.memberIDs.filter(id=>!removed.has(id)),...ids.filter(id=>!original.includes(id))])];
    } else if(JSON.stringify(item.memberIDs)!==JSON.stringify(b.original)) throw new HTTPError(409,'The claims changed. Refresh and try again.');
    if(JSON.stringify(item.memberIDs)!==JSON.stringify(next)) delete item.roundingSeats;
    item.memberIDs=next;
  }
  entry.splits=itemSplit(bill,entry.paidBy);
  const saved=await env.DB.prepare('UPDATE entries SET payload=? WHERE id=? AND payload=? AND id NOT IN (SELECT entry_id FROM deleted_entries)').bind(JSON.stringify(entry),id,row.payload).run();
  if(!saved.meta.changes) throw new HTTPError(409,'This receipt changed. Refresh and try again.');
  return json({ok:true});
}
