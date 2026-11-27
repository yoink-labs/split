import { allocate, currencies, Entry, InputError } from './ledger';
import { convert, impliedRate, type Exchange } from './fx';
export type { Exchange } from './fx';
export function readExchange(e:Entry):Exchange {
  const x=e.exchange!;
  const published=['BCRA','Frankfurter','Frankfurter blended'].includes(x.source);
  const chargeDay=e.createdAt.slice(0,10);
  const today=new Date().toISOString().slice(0,10);
  if(!currencies.includes(x.target) || x.target===e.currency || !Number.isSafeInteger(x.rateE8) || x.rateE8<1 || x.rateE8>1e15 ||
    !['Manual','BCRA','Frankfurter','Frankfurter blended','Trip','Statement'].includes(x.source) ||
    typeof x.date!=='string' || !/^\d{4}-\d\d-\d\d$/.test(x.date) || !Number.isFinite(Date.parse(x.date)) ||
    new Date(x.date).toISOString().slice(0,10)!==x.date || (x.date>chargeDay && (!published || x.date>today)))
    throw new InputError('Check the exchange rate, currency and date.');
  if(x.source==='Statement') {
    const charged=x.statementAmount;
    if(typeof charged!=='number' || charged>100_000_000_000) throw new InputError('Check the amount charged on your statement.');
    const rate=impliedRate(e.amount,charged);
    if(!rate) throw new InputError('Check the amount charged on your statement.');
    return {target:x.target,rateE8:rate,date:x.date,source:x.source,statementAmount:charged};
  }
  let value: number;
  try { value=convert(e.amount,x.rateE8); } catch { throw new InputError('Converted amount is outside the supported range.'); }
  if(value<1 || value>100_000_000_000) throw new InputError('Converted amount is outside the supported range.');
  return {target:x.target,rateE8:x.rateE8,date:x.date,source:x.source};
}
/** Older iOS clients omit the posted amount when echoing an existing exchange back. */
export function preserveStatementAmount(value:unknown,saved:Entry):unknown {
  const current=saved.exchange;
  if(!value || typeof value!=='object' || current?.source!=='Statement' || current.statementAmount===undefined) return value;
  const entry=value as Partial<Entry>, exchange=entry.exchange;
  if(entry.currency!==saved.currency || exchange?.source!=='Statement' || exchange.statementAmount!==undefined ||
    exchange.target!==current.target || exchange.date!==current.date || exchange.rateE8!==current.rateE8) return value;
  return {...entry,exchange:{...exchange,statementAmount:current.statementAmount}};
}
export function settlementEntry(e:Entry):Entry {
  if(!e.exchange) return e;
  const amount=e.exchange.statementAmount ?? convert(e.amount,e.exchange.rateE8);
  const shares=allocate(amount,e.splits.map(s=>s.amount));
  const payers=e.payers?.length ? allocate(amount,e.payers.map(p=>p.amount)) : undefined;
  return {...e,exchange:undefined,amount,currency:e.exchange.target,splits:e.splits.map((s,i)=>({...s,amount:shares[i]})),
    ...(payers?{payers:e.payers!.map((p,i)=>({memberID:p.memberID,amount:payers[i]}))}:{})};
}
