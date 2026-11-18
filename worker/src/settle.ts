// Maximize disjoint zero-sum groups. Each such component needs n-1 transfers.
export function transferPlan(balance:Record<string,number>) {
  const seats=Object.keys(balance).filter(id=>balance[id]).sort();
  const parts:string[][]=[];
  const rest:string[]=[];
  for(const id of seats) {
    const opposite=rest.findIndex(other=>balance[other]===-balance[id]);
    if(opposite<0) rest.push(id);
    else parts.push([rest.splice(opposite,1)[0],id]);
  }
  if(rest.length && rest.length<=16) {
    const size=1<<rest.length, sums=new Float64Array(size), groups=new Uint8Array(size), last=new Uint8Array(size);
    for(let mask=1;mask<size;mask++) {
      const bit=mask&-mask;
      sums[mask]=sums[mask^bit]+balance[rest[31-Math.clz32(bit)]];
      let best=-1;
      for(let bits=mask;bits;bits&=bits-1) {
        const b=bits&-bits, count=groups[mask^b];
        if(count>best) {best=count;last[mask]=31-Math.clz32(b);}
      }
      groups[mask]=best+Number(sums[mask]===0);
    }
    let part:string[]=[];
    for(let mask=size-1;mask;) {
      const i=last[mask];part.push(rest[i]);mask^=1<<i;
      if(sums[mask]===0){parts.push(part);part=[];}
    }
  } else if(rest.length) parts.push(rest);
  const result:{from:string;to:string;amount:number}[]=[];
  for(const part of parts) {
    const sorted=part.slice().sort((a,b)=>Math.abs(balance[b])-Math.abs(balance[a]) || (a<b?-1:1));
    const debts=sorted.filter(id=>balance[id]<0).map(id=>({id,left:-balance[id]}));
    const credits=sorted.filter(id=>balance[id]>0).map(id=>({id,left:balance[id]}));
    for(const d of debts) for(const c of credits) {
      const amount=Math.min(d.left,c.left);
      if(amount){result.push({from:d.id,to:c.id,amount});d.left-=amount;c.left-=amount;}
    }
  }
  return result;
}
