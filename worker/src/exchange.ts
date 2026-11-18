import { allocate, currencies, Entry, InputError } from './ledger';
export interface Exchange { target:string; rateE8:number; date:string; source:string }
export function readExchange(e:Entry):Exchange {
  const x=e.exchange!;
  if(!x || !currencies.some(c=>c===x.target) || x.target===e.currency || !Number.isSafeInteger(x.rateE8) || x.rateE8<1 || x.rateE8>1e15 ||
    !['Manual','BCRA','Frankfurter'].includes(x.source) || !/^\d{4}-\d\d-\d\d$/.test(x.date) || !Number.isFinite(Date.parse(x.date)) || x.date>e.createdAt.slice(0,10)) throw new InputError('Check the exchange rate, currency and date.');
  const value=convertedAmount(e.amount,x);
  if(value<1 || value>100_000_000_000) throw new InputError('Converted amount is outside the supported range.');
  return {target:x.target,rateE8:x.rateE8,date:x.date,source:x.source};
}
function convertedAmount(amount:number,x:Exchange) { return Number((BigInt(amount)*BigInt(x.rateE8)+50000000n)/100000000n); }
export function settlementEntry(e:Entry):Entry {
  if(!e.exchange) return e;
  const amount=convertedAmount(e.amount,e.exchange), shares=allocate(amount,e.splits.map(s=>s.amount));
  return {...e,exchange:undefined,amount,currency:e.exchange.target,splits:e.splits.map((s,i)=>({...s,amount:shares[i]}))};
}
