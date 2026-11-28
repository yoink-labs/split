import { InputError } from './ledger';
export class HTTPError extends Error { constructor(public status: number, message: string) { super(message); } }
export const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function optionalDay(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const day = typeof value === 'string' ? value.trim() : '';
  const date = new Date(day + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new InputError(`Use a valid YYYY-MM-DD date for the ${label}.`);
  }
  return day;
}
export async function body(request:Request,limit=32_768):Promise<Record<string,unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HTTPError(415,'Send JSON.');
  const reader=request.body?.getReader(); if(!reader) throw new InputError('Missing body.');
  let size=0; const chunks:Uint8Array[]=[];
  while(true){ const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>limit){await reader.cancel();throw new HTTPError(413,'Request too large.');} chunks.push(value); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try { const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value; } catch {throw new InputError('Invalid JSON.');}
}

export async function fingerprint(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
