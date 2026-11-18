import { allocate, Entry, InputError, validID, balances, entryPayers, simplify } from './ledger';

export interface Item { id:string; title:string; amount:number; memberIDs:string[]; roundingSeats?:string[] }
export interface Bill { items:Item[]; tax:number; tip:number; closed:boolean }
const cents=(n:number)=>Number.isSafeInteger(n) && n>=0 && n<=100_000_000_000;
export function readBill(b:Bill, members:string[], total:number, previous?:Bill):Bill {
  if (!b || !Array.isArray(b.items) || !b.items.length || b.items.length>50 || !cents(b.tax) || !cents(b.tip) || typeof b.closed!=='boolean') throw new InputError('Check items, tax and tip.');
  const items=b.items.map(i=>{
    if(!i || !validID(i.id) || typeof i.title!=='string' || !i.title.trim() || i.title.length>100 || !cents(i.amount) || !i.amount ||
       !Array.isArray(i.memberIDs) || i.memberIDs.length>50 || new Set(i.memberIDs).size!==i.memberIDs.length || i.memberIDs.some(id=>!members.includes(id)) || (b.closed && !i.memberIDs.length))
      throw new InputError('Check the item price, name and claimants.');
    // An account can inherit two historical seats. Keep their cent rounding until this item is reassigned.
    const inherited=previous?.items.find(old=>old.id===i.id)?.roundingSeats;
    if(i.roundingSeats && (!inherited || JSON.stringify(inherited)!==JSON.stringify(i.roundingSeats) ||
       JSON.stringify([...new Set(inherited)])!==JSON.stringify(i.memberIDs))) throw new InputError('Refresh the historical item claims.');
    return {id:i.id,title:i.title.trim(),amount:i.amount,memberIDs:i.memberIDs,...(i.roundingSeats?{roundingSeats:i.roundingSeats}:{})};
  });
  if(new Set(items.map(i=>i.id)).size!==items.length || items.reduce((s,i)=>s+i.amount,b.tax+b.tip)!==total) throw new InputError('Items, tax and tip must match the expense total.');
  return {items,tax:b.tax,tip:b.tip,closed:b.closed};
}
export function grossItems(b:Bill) {
  const extra=b.tax+b.tip;
  const amounts=extra ? allocate(extra,b.items.map(i=>i.amount)) : b.items.map(()=>0);
  return b.items.map((i,index)=>({...i,gross:i.amount+amounts[index]}));
}
export function itemSplit(b:Bill,payer:string) {
  const totals=new Map<string,number>();
  for (const i of grossItems(b)) {
    const ids=i.roundingSeats ?? (i.memberIDs.length ? i.memberIDs : [payer]);
    const amounts=allocate(i.gross,ids.map(()=>1));
    ids.forEach((id,index)=>totals.set(id,(totals.get(id)??0)+amounts[index]));
  }
  return Array.from(totals,([memberID,amount])=>({memberID,amount}));
}
export function breakdown(entries:Entry[],members:{id:string;name:string}[],currency:string) {
  const expenses=entries.filter(e=>e.currency===currency && e.kind==='expense');
  const net=balances(entries,currency);
  const categories:Record<string,number>=Object.create(null), months:Record<string,number>=Object.create(null);
  for (const e of expenses) {
    const category=e.category??'Uncategorized', month=new Date(e.createdAt).toISOString().slice(0,7);
    categories[category]=(categories[category]??0)+e.amount;
    months[month]=(months[month]??0)+e.amount;
  }
  return {currency,total:expenses.reduce((sum,e)=>sum+e.amount,0),categories,months,settlements:simplify(net),
    members:members.map(m=>({...m,paid:expenses.reduce((s,e)=>s+entryPayers(e).filter(p=>p.memberID===m.id).reduce((n,p)=>n+p.amount,0),0),
      share:expenses.reduce((s,e)=>s+(e.splits.find(p=>p.memberID===m.id)?.amount??0),0),net:net[m.id]??0,
      expenses:expenses.filter(e=>entryPayers(e).some(p=>p.memberID===m.id) || e.splits.some(p=>p.memberID===m.id)).map(e=>e.id)}))};
}
