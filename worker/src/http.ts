import { InputError } from './ledger';
export class HTTPError extends Error { constructor(public status: number, message: string) { super(message); } }
export const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function body(request:Request):Promise<Record<string,unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HTTPError(415,'Send JSON.');
  const reader=request.body?.getReader(); if(!reader) throw new InputError('Missing body.');
  let size=0; const chunks:Uint8Array[]=[];
  while(true){ const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>32_768){await reader.cancel();throw new HTTPError(413,'Request too large.');} chunks.push(value); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try { const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value; } catch {throw new InputError('Invalid JSON.');}
}
