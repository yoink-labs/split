// Run via ADE secrets exec. Creates only explicitly marked Split QA users.
// Ticket is short lived, saved owner-only, and never printed.
import { writeFileSync, mkdirSync } from 'node:fs';
const alias=process.argv[2];
if(!['alex','maya'].includes(alias))throw new Error('Choose alex or maya');
const email=`yoink-split-e2e-${alias}@example.com`;
async function api(path,method='GET',data){
 const r=await fetch('https://api.clerk.com/v1'+path,{method,headers:{Authorization:`Bearer ${process.env.CLERK_SECRET_KEY}`,'Content-Type':'application/json','User-Agent':'Split-QA/0.1'},body:data?JSON.stringify(data):undefined});
 if(!r.ok){let codes=[];try{codes=(await r.json()).errors?.map(e=>e.code)}catch{};throw new Error(`Clerk ${r.status}: ${codes}`)}
 return r.json();
}
const matches=await api('/users?email_address='+encodeURIComponent(email));
let user=matches[0];
if(user && user.private_metadata?.splitE2ETestUser!==true)throw new Error('Refusing an unmarked user');
if(!user)user=await api('/users','POST',{email_address:[email],first_name:alias==='alex'?'Alex':'Maya',last_name:'Split QA',skip_password_requirement:true,private_metadata:{splitE2ETestUser:true}});
const token=await api('/sign_in_tokens','POST',{user_id:user.id,expires_in_seconds:300});
mkdirSync('.ade/tmp/qa',{recursive:true});
writeFileSync(`.ade/tmp/qa/${alias}.ticket`,token.token,{mode:0o600});
writeFileSync(`.ade/tmp/qa/${alias}.json`,JSON.stringify({id:user.id,email}),{mode:0o600});
console.log(`Prepared ${alias} QA account; one-use ticket saved privately (5 minute expiry).`);
