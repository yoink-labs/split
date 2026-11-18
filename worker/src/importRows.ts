import {Entry, InputError, validID, validateEntry} from './ledger';
import {json} from './http';
async function digest(value:unknown) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function importRows(db:D1Database,group:string,user:string,b:Record<string,unknown>) {
  const rows=b.rows;
  if(!Array.isArray(rows) || !rows.length || rows.length>80) throw new InputError('Import 1–80 rows at a time.');
  const settle=await db.prepare('SELECT currency FROM groups WHERE id=?').bind(group).first('currency');
  const sourceIDs=rows.filter(r=>r?.sourceGroup===group && validID(r.sourceID)).map(r=>r.sourceID);
  const existing=new Set((await db.prepare('SELECT id FROM entries WHERE group_id=? AND id IN (SELECT value FROM json_each(?))')
    .bind(group,JSON.stringify(sourceIDs)).all<{id:string}>()).results.map(e=>e.id));
  const roster=(await db.prepare('SELECT id,name FROM members WHERE group_id=? AND id NOT IN (SELECT member_id FROM member_aliases)').bind(group).all<{id:string;name:string}>()).results;
  const names=new Map<string,string>(), ambiguous=new Set<string>();
  for(const m of roster) {const key=m.name.toLowerCase().trim();if(names.has(key)) ambiguous.add(key);names.set(key,m.id);}
  const members:D1PreparedStatement[]=[],entries:D1PreparedStatement[]=[],copies=new Map<string,number>();
  async function resolve(name:unknown) {
    if(typeof name!=='string' || !name.trim() || name.length>60) throw new InputError('Invalid CSV member name.');
    const key=name.trim().toLowerCase();
    if(ambiguous.has(key)) throw new InputError('Multiple members match '+name+'. Rename the CSV column to identify one member.');
    if(!names.has(key)) {
      const id=await digest(['csv-person',group,key]);
      members.push(db.prepare('INSERT INTO members VALUES (?,?,NULL,?) ON CONFLICT(id) DO NOTHING').bind(id,group,name.trim()));
      names.set(key,id);
    }
    return names.get(key)!;
  }
  for(const row of rows) {
    if(!row || typeof row!=='object' || !Array.isArray(row.splits) || row.splits.length>50 || !/^\d{4}-\d\d-\d\d$/.test(row.day)) throw new InputError('Invalid CSV row.');
    if(row.exchange && row.exchange.target!==settle) throw new InputError('CSV rate must target the group settlement currency.');
    if(row.sourceGroup===group && existing.has(row.sourceID)) continue;
    const paidBy=await resolve(row.payer), splits=[];
    for(const s of row.splits) splits.push({memberID:await resolve(s.name),amount:s.amount});
    splits.sort((a,b)=>a.memberID<b.memberID?-1:1);
    const e:Entry=validateEntry({id:'csv-entry',groupID:group,title:row.title,paidBy,amount:row.amount,currency:row.currency,kind:row.payment?'settlement':'expense',
      exchange:row.exchange,category:row.payment?undefined:row.category,splitMode:'exact',createdAt:row.day+'T12:00:00Z',splits},[...names.values()]);
    const fingerprint=await digest(e), ordinal=copies.get(fingerprint)??0;copies.set(fingerprint,ordinal+1);
    e.id=await digest([group,fingerprint,ordinal]);
    entries.push(db.prepare('INSERT INTO entries VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(e.id,group,user,JSON.stringify(e),e.createdAt));
  }
  if(!entries.length) return json({inserted:0});
  const result=await db.batch([...members,...entries]);
  return json({inserted:result.slice(members.length).reduce((n,r)=>n+r.meta.changes,0)});
}
