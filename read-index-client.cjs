'use strict';
const ORIGIN='https://pm.cnffurdl.com/api/internal/firestore-index';
module.exports=async function request(body,{transport=fetch}={}){
 const key=process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY;if(!key)throw Object.assign(Error('INDEX_CONFIGURATION_REQUIRED'),{status:503});
 let response;try{response=await transport(ORIGIN,{method:'POST',redirect:'error',headers:{'x-internal-key':key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw Object.assign(Error('INDEX_UNAVAILABLE'),{status:503});}
 let value;try{value=await response.json();}catch{throw Object.assign(Error('INDEX_RESPONSE_INVALID'),{status:502});}
 if(!response.ok||!value.ok)throw Object.assign(Error(value.code||'INDEX_REQUEST_FAILED'),{status:response.status===401?502:response.status});
 return value;
};
