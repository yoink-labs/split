import { isSpend } from './refundMath';
import { allocate, Entry, InputError, validID, balances, entryPayers, entrySign, simplify } from './ledger';

export interface Item { id:string; title:string; amount:number; memberIDs:string[]; shares?:Record<string,number>; roundingSeats?:string[]; roundingWeights?:number[] }
export interface Bill { items:Item[]; tax:number; tip:number; closed:boolean }
const cents=(n:number)=>Number.isSafeInteger(n) && n>=0 && n<=100_000_000_000;
const validWeight=(n:unknown)=>typeof n==='number' && Number.isSafeInteger(n) && n>=1 && n<=100_000;
export function readBill(b:Bill, members:string[], total:number, previous?:Bill, reconcile=false):Bill {
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length>50 || !cents(b.tax) || !cents(b.tip) || typeof b.closed!=='boolean') throw new InputError('Check items, tax and tip.');
  const items=b.items.map(i=>{
    if(!i || !validID(i.id) || typeof i.title!=='string' || !i.title.trim() || i.title.length>100 || !cents(i.amount) || !i.amount ||
       !Array.isArray(i.memberIDs) || i.memberIDs.length>50 || new Set(i.memberIDs).size!==i.memberIDs.length || i.memberIDs.some(id=>!members.includes(id)) || (!reconcile && b.closed && !i.memberIDs.length))
      throw new InputError('Check the item price, name and claimants.');
    let shares:Record<string,number>|undefined;
    if(i.shares!==undefined) {
      if(!i.shares || typeof i.shares!=='object' || Array.isArray(i.shares)) throw new InputError('Check the item share weights.');
      const entries=Object.entries(i.shares);
      if(entries.some(([id,w])=>!i.memberIDs.includes(id) || !validWeight(w))) throw new InputError('Use positive share weights for claimed members.');
      if(entries.length) shares=Object.fromEntries(entries);
    }
    // An account can inherit two historical seats. Keep their cent rounding until this item is reassigned.
    const prior=previous?.items.find(old=>old.id===i.id);
    const inherited=prior?.roundingSeats;
    if(i.roundingSeats && (!inherited || JSON.stringify(inherited)!==JSON.stringify(i.roundingSeats) ||
       JSON.stringify([...new Set(inherited)])!==JSON.stringify(i.memberIDs))) throw new InputError('Refresh the historical item claims.');
    if(i.roundingWeights!==undefined && (!i.roundingSeats || JSON.stringify(i.roundingWeights)!==JSON.stringify(prior?.roundingWeights))) throw new InputError('Refresh the historical item claims.');
    return {id:i.id,title:i.title.trim(),amount:i.amount,memberIDs:i.memberIDs,...(shares?{shares}:{}),...(i.roundingSeats?{roundingSeats:i.roundingSeats}:{}),...(i.roundingWeights?{roundingWeights:i.roundingWeights}:{})};
  });
  if(new Set(items.map(i=>i.id)).size!==items.length || items.reduce((s,i)=>s+i.amount,b.tax+b.tip)!==total) throw new InputError('Items, tax and tip must match the expense total.');
  return {items,tax:b.tax,tip:b.tip,closed:b.closed};
}
export function grossItems(b:Bill) {
  const extra=b.tax+b.tip;
  const amounts=extra ? allocate(extra,b.items.map(i=>i.amount)) : b.items.map(()=>0);
  return b.items.map((i,index)=>({...i,gross:i.amount+amounts[index]}));
}
export function itemPortions(i: Item & {gross:number},payer:string) {
  const ids=i.roundingSeats ?? (i.memberIDs.length ? i.memberIDs : [payer]);
  const weights=i.roundingSeats
    ? i.roundingWeights ?? ids.map(()=>1)
    : ids.map(id=>Object.hasOwn(i.shares??{},id) ? i.shares![id] : 100);
  const amounts=allocate(i.gross,weights);
  return ids.map((memberID,index)=>({memberID,amount:amounts[index]}));
}
export function itemSplit(b:Bill,payer:string) {
  const totals=new Map<string,number>();
  for (const i of grossItems(b)) {
    for(const {memberID,amount} of itemPortions(i,payer)) totals.set(memberID,(totals.get(memberID)??0)+amount);
  }
  return Array.from(totals,([memberID,amount])=>({memberID,amount}));
}
/** An open item's provisional payer share does not count as an assignment. */
export function reconcileBill(entry: Entry) {
  const bill=entry.bill;
  if (!bill) return;
  bill.closed=bill.items.length>0 && bill.items.every(i=>i.memberIDs.length>0) &&
    bill.items.reduce((sum,i)=>sum+i.amount,bill.tax+bill.tip)===entry.amount &&
    entry.splits.reduce((sum,split)=>sum+split.amount,0)===entry.amount;
}
export function breakdown(entries:Entry[],members:{id:string;name:string}[],currency:string) {
  // Refunds count against spending: they lower the total, the receiver's paid and each credited share.
  const expenses=entries.filter(e=>e.currency===currency && isSpend(e));
  const net=balances(entries,currency,{includeHandled:true});
  const categories:Record<string,number>=Object.create(null), months:Record<string,number>=Object.create(null);
  for (const e of expenses) {
    const category=e.category??'Uncategorized', month=new Date(e.createdAt).toISOString().slice(0,7), amount=entrySign(e)*e.amount;
    categories[category]=(categories[category]??0)+amount;
    months[month]=(months[month]??0)+amount;
  }
  const pending=expenses.filter(e=>e.pending);
  return {currency,total:expenses.reduce((sum,e)=>sum+entrySign(e)*e.amount,0),categories,months,settlements:simplify(balances(entries,currency)),
    ...(pending.length?{pending:{count:pending.length,confirmedSettlements:simplify(balances(entries,currency,{includePending:false}))}}:{}),
    members:members.map(m=>({...m,paid:expenses.reduce((s,e)=>s+entrySign(e)*entryPayers(e).filter(p=>p.memberID===m.id).reduce((n,p)=>n+p.amount,0),0),
      share:expenses.reduce((s,e)=>s+entrySign(e)*(e.splits.find(p=>p.memberID===m.id)?.amount??0),0),net:net[m.id]??0,
      expenses:expenses.filter(e=>entryPayers(e).some(p=>p.memberID===m.id) || e.splits.some(p=>p.memberID===m.id)).map(e=>e.id)}))};
}

/** Spread total over weights by largest remainder; all zeros when there is nothing to spread. */
function spread(total:number,weights:number[]) {
  return total>0 && weights.some(w=>w>0) ? allocate(total,weights,Number.MAX_SAFE_INTEGER) : weights.map(()=>0);
}
export interface ConsumptionPart { memberID:string; amount:number; items:number; tax:number; tip:number }
export interface ItemConsumption { id:string; title:string; amount:number; gross:number; tax:number; tip:number; open:boolean; portions:ConsumptionPart[] }
/**
 * Who consumed what on an itemized bill, exact to the cent. Each portion is the same amount
 * `itemSplit` charges, broken into its item price, tax and tip. Item price, tax and tip are each
 * spread by largest remainder, so every column adds up to the receipt and every person's three
 * parts add up to their share. No part is ever negative.
 */
export function billConsumption(b:Bill,payer:string) {
  const gross=grossItems(b);
  const extras=gross.map(i=>i.gross-i.amount);
  const taxes=spread(b.tax,extras);
  const items:ItemConsumption[]=gross.map((i,index)=>{
    const raw=itemPortions(i,payer);
    const ids=[...new Set(raw.map(p=>p.memberID))];
    const amounts=ids.map(id=>raw.filter(p=>p.memberID===id).reduce((s,p)=>s+p.amount,0));
    const base=spread(i.amount,amounts);
    const rest=amounts.map((a,k)=>a-base[k]);
    const tax=spread(taxes[index],rest);
    return {id:i.id,title:i.title,amount:i.amount,gross:i.gross,tax:taxes[index],tip:extras[index]-taxes[index],open:!i.memberIDs.length,
      portions:ids.map((memberID,k)=>({memberID,amount:amounts[k],items:base[k],tax:tax[k],tip:rest[k]-tax[k]}))};
  });
  const people=new Map<string,ConsumptionPart>();
  for(const p of items.flatMap(i=>i.portions)) {
    const sum=people.get(p.memberID)??{memberID:p.memberID,amount:0,items:0,tax:0,tip:0};
    sum.amount+=p.amount; sum.items+=p.items; sum.tax+=p.tax; sum.tip+=p.tip;
    people.set(p.memberID,sum);
  }
  return {items,people:[...people.values()]};
}
/** Read-only item projection. Preserve recorded splits for entries without a receipt bill. */
export function entryItems(entry: Entry): ItemConsumption[] {
  if (entry.bill) return billConsumption(entry.bill, entry.paidBy).items;
  return [{
    id: entry.id, title: entry.title, amount: entry.amount, gross: entry.amount,
    tax: 0, tip: 0, open: false,
    portions: entry.splits.map(p => ({ ...p, items: p.amount, tax: 0, tip: 0 })),
  }];
}

/**
 * One consumption line per person: receipt items for itemized expenses, otherwise the expense itself.
 * Refunds give consumption back as negative lines: an item refund returns exactly those items'
 * portions (item, tax and tip), any other refund one line per credited person.
 */
export function entryConsumption(e:Entry,all:Entry[]=[]) {
  if(e.kind==='refund') {
    const original=e.refundItems && all.find(o=>o.id===e.refundOf && o.kind==='expense');
    if(original && original.bill) {
      const items=billConsumption(original.bill,original.paidBy).items.filter(i=>e.refundItems!.includes(i.id));
      const lines=items.flatMap(i=>i.portions.filter(p=>p.amount).map(p=>({memberID:p.memberID,amount:-p.amount,items:-p.items,tax:-p.tax,tip:-p.tip,
        entryID:e.id,itemID:i.id as string|null,title:'Refund: '+i.title})));
      const exact=e.splits.every(s=>lines.filter(l=>l.memberID===s.memberID).reduce((n,l)=>n-l.amount,0)===s.amount) &&
        lines.every(l=>e.splits.some(s=>s.memberID===l.memberID));
      if(exact) return lines;
    }
    return e.splits.filter(s=>s.amount).map(s=>({memberID:s.memberID,amount:-s.amount,items:-s.amount,tax:0,tip:0,entryID:e.id,itemID:null as string|null,title:e.title}));
  }
  return entryItems(e).flatMap(i=>i.portions.filter(p=>e.bill || p.amount).map(p=>({...p,entryID:e.id,itemID:e.bill ? i.id : null,title:i.title})));
}
/** Consumption by person across expenses and refunds in one currency: their lines and item, tax and tip totals. */
export function consumptionReport(entries:Entry[],currency:string) {
  const expenses=entries.filter(e=>(e.kind==='expense' || e.kind==='refund') && e.currency===currency)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const people=new Map<string,{memberID:string;amount:number;items:number;tax:number;tip:number;lines:ReturnType<typeof entryConsumption>}>();
  for(const line of expenses.flatMap(e=>entryConsumption(e,entries))) {
    const p=people.get(line.memberID)??{memberID:line.memberID,amount:0,items:0,tax:0,tip:0,lines:[]};
    p.amount+=line.amount; p.items+=line.items; p.tax+=line.tax; p.tip+=line.tip; p.lines.push(line);
    people.set(line.memberID,p);
  }
  return {currency,people:[...people.values()]};
}
/**
 * Refunding specific receipt items gives each person back exactly what those items cost them,
 * tax and tip included, using the same portions the expense charged.
 */
export function itemRefund(original:Entry,itemIDs:string[]) {
  if(!original.bill) throw new InputError('Only an itemized expense can refund specific items.');
  if(!itemIDs.length || new Set(itemIDs).size!==itemIDs.length) throw new InputError('Choose the items to refund.');
  const {items}=billConsumption(original.bill,original.paidBy);
  const chosen=itemIDs.map(id=>{
    const item=items.find(i=>i.id===id);
    if(!item) throw new InputError('Choose items from the original receipt.');
    return item;
  });
  const totals=new Map<string,number>();
  for(const p of chosen.flatMap(i=>i.portions)) totals.set(p.memberID,(totals.get(p.memberID)??0)+p.amount);
  const splits=[...totals].map(([memberID,amount])=>({memberID,amount})).filter(s=>s.amount);
  return {amount:splits.reduce((s,p)=>s+p.amount,0),splits};
}
