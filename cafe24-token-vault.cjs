'use strict';
// The existing 71 bridge stores only the existing AES-GCM envelope, never plaintext.
// A new process reads this durable record before consulting Firestore. A missing
// record is seeded once from Firestore; an unavailable vault fails closed.
const URL='https://pm.cnffurdl.com/api/internal/cafe24-token-vault';
module.exports=function createVault({transport=fetch,key=()=>process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY}={}){
 return async body=>{
  const secret=key();if(!secret)throw Object.assign(Error('CAFE24_TOKEN_VAULT_CONFIGURATION'),{code:'CAFE24_TOKEN_VAULT_CONFIGURATION',httpStatus:503});
  let response,data;try{response=await transport(URL,{method:'POST',redirect:'error',headers:{'x-internal-key':secret,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});data=await response.json();}catch{throw Object.assign(Error('CAFE24_TOKEN_VAULT_UNAVAILABLE'),{code:'CAFE24_TOKEN_VAULT_UNAVAILABLE',httpStatus:503,stage:'token_store'});}
  if(!response.ok||!data.ok)throw Object.assign(Error('CAFE24_'+(data.code||'TOKEN_VAULT_FAILED')),{code:'CAFE24_'+(data.code||'TOKEN_VAULT_FAILED'),httpStatus:response.status===409?409:503,stage:'token_store'});
  return data;
 };
};
