import {HTTPError, body, json} from './http';
import {currencies, Entry, InputError} from './ledger';
import {saveGroupPayments} from './paymentProfiles';

export function nextDate(day:string,cadence:string,anchor:number) {
  const date=new Date(day+'T12:00:00Z');
  if(cadence==='monthly' || cadence==='yearly') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth()+(cadence==='yearly'?12:1));
    const end=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    date.setUTCDate(Math.min(end,anchor));
  } else date.setUTCDate(date.getUTCDate()+(cadence==='weekly'?7:1));
  return date.toISOString().slice(0,10);
}
export async function generateRecurring(db:D1Database,today:string) {
  const rows=(await db.prepare(`SELECT r.*,e.payload,e.group_id,e.author FROM recurring r JOIN entries e ON e.id=r.entry_id
    WHERE due<=? ORDER BY due,entry_id LIMIT 20`).bind(today).all<{entry_id:string;cadence:string;due:string;anchor:number;payload:string;group_id:string;author:string}>()).results;
  for(const row of rows) {
    const original:Entry=JSON.parse(row.payload);
    if(original.bill || original.exchange) continue;
    const id='repeat-'+row.due+'-'+row.entry_id;
    // Hash long client IDs to keep generated entries within the regular ID contract.
    const key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id))),b=>b.toString(16).padStart(2,'0')).join('');
    const {handled: _handled,pending: _pending,pendingNote: _note,...futureExpense}=original;
    const e={...futureExpense,id:key,createdAt:row.due+'T12:00:00Z'};
    const where='entry_id=? AND due=? AND cadence=? AND EXISTS(SELECT 1 FROM entries WHERE id=entry_id AND payload=?)';
    const guard=[row.entry_id,row.due,row.cadence,row.payload];
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO entries SELECT ?,?,?,?,? FROM recurring WHERE '+where).bind(key,row.group_id,row.author,JSON.stringify(e),e.createdAt,...guard),
      db.prepare('UPDATE recurring SET due=? WHERE '+where).bind(nextDate(row.due,row.cadence,row.anchor),...guard)
    ]);
  }
}
export async function groupTools(req:Request,env:Env,user:string) {
  const match=new URL(req.url).pathname.match(/^\/v1\/groups\/([\w-]+)\/(default-split|payment-profile|repeat|import|trip-rate)$/);
  if(!match || req.method!=='POST') return;
  const [,group,action]=match;
  const seat=await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND user_id=?').bind(group,user).first<{id:string}>();
  if(!seat) throw new HTTPError(403,'Join the group first.');
  const b=await body(req,action==='import'?512000:65536);
  if(action==='import') return importRows(env.DB,group,user,b);
  if(action==='trip-rate') {
    const trip=await env.DB.prepare(`SELECT g.currency FROM groups g JOIN members m ON m.group_id=g.id
      WHERE g.id=? AND g.kind='trip' AND m.user_id=? AND m.removed_at IS NULL`).bind(group,user).first<{currency:string}>();
    if(!trip) throw new HTTPError(403,'Only active trip members can change the rate.');
    const {currency,target,rateE8}=b;
    if(target!==trip.currency) throw new HTTPError(409,'The trip currency changed. Refresh and try again.');
    if(typeof currency!=='string' || !currencies.includes(currency) || currency===trip.currency ||
       (rateE8!==null && (typeof rateE8!=='number' || !Number.isSafeInteger(rateE8) || rateE8<1 || rateE8>1e15)))
      throw new InputError('Choose a foreign currency and enter a valid rate.');
    const activeTrip=`SELECT 1 FROM groups g JOIN members m ON m.group_id=g.id
      WHERE g.id=? AND g.currency=? AND g.kind='trip' AND m.user_id=? AND m.removed_at IS NULL`;
    if(rateE8===null) await env.DB.prepare(`DELETE FROM trip_exchange_rates WHERE group_id=? AND currency=?
      AND EXISTS(${activeTrip})`).bind(group,currency,group,target,user).run();
    else {
      const result=await env.DB.prepare(`INSERT INTO trip_exchange_rates SELECT ?,?,? WHERE EXISTS(${activeTrip})
        ON CONFLICT(group_id,currency) DO UPDATE SET rate_e8=excluded.rate_e8`).bind(group,currency,rateE8,group,target,user).run();
      if(!result.meta.changes) throw new HTTPError(409,'The trip changed. Refresh and try again.');
    }
  } else if(action==='payment-profile') {
    return saveGroupPayments(env.DB,group,user,b);
  } else if(action==='default-split') {
    const ids=(await env.DB.prepare('SELECT id FROM members WHERE group_id=? AND id NOT IN (SELECT member_id FROM member_aliases)').bind(group).all<{id:string}>()).results.map(m=>m.id);
    if(!b.weights || Array.isArray(b.weights) || typeof b.weights!=='object') throw new InputError('Choose default weights.');
    const weights=Object.entries(b.weights);
    if(weights.some(([id,w])=>!ids.includes(id)||!Number.isInteger(w)||w<1||w>1000)) throw new InputError('Use whole weights from 1 through 1000.');
    await env.DB.prepare('INSERT INTO group_splits VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET weights=excluded.weights').bind(group,JSON.stringify(b.weights)).run();
  } else {
    const e=await env.DB.prepare('SELECT payload FROM entries WHERE id=? AND group_id=? AND author=? AND id NOT IN (SELECT entry_id FROM deleted_entries)').bind(String(b.entryID),group,user).first<{payload:string}>();
    if(!e) throw new HTTPError(403,'Only the author can schedule this expense.');
    const entry:Entry=JSON.parse(e.payload), cadence=String(b.cadence);
    if(cadence==='off') await env.DB.prepare('DELETE FROM recurring WHERE entry_id=?').bind(entry.id).run();
    else {
      if(!['daily','weekly','monthly','yearly'].includes(cadence) || entry.kind!=='expense' || entry.bill || entry.exchange) throw new InputError('Choose an ordinary fixed-currency expense to repeat.');
      const today=new Date().toISOString().slice(0,10), start=entry.createdAt.slice(0,10), anchor=Number(start.slice(-2));
      let day=start;
      if(start<today) {
        if(cadence==='daily') day=today;
        else if(cadence==='weekly') {
          const weeks=Math.floor((Date.parse(today)-Date.parse(start))/604800000);
          day=new Date(Date.parse(start)+weeks*604800000).toISOString().slice(0,10);
        } else {
          const year=today.slice(0,4), month=cadence==='yearly'?start.slice(5,7):today.slice(5,7);
          const end=new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
          day=year+'-'+month+'-'+String(Math.min(anchor,end)).padStart(2,'0');
        }
      }
      const due=day>today && day!==start ? day : nextDate(day,cadence,anchor);
      await env.DB.prepare('INSERT INTO recurring VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET cadence=excluded.cadence,due=excluded.due,anchor=excluded.anchor WHERE cadence<>excluded.cadence')
        .bind(entry.id,cadence,due,anchor).run();
    }
  }
  return json({ok:true});
}
import {importRows} from './importRows';
