'use strict';
const {AsyncLocalStorage}=require('node:async_hooks'),{createHash}=require('node:crypto');
const context=new AsyncLocalStorage(),recent=[];
const quota=e=>[8,'8','RESOURCE_EXHAUSTED','resource-exhausted'].includes(e?.code)||/quota exceeded|resource.?exhausted/i.test(e?.message||'');
// Pin the SDK in package-lock.json. Both GAPIC and QueryUtil consult this shared generated retry table.
// RESOURCE_EXHAUSTED must fail immediately, before SDK retries hide quota failures from the circuit.
const retryConfig=require('@google-cloud/firestore/build/src/v1/firestore_client_config.json').interfaces['google.firestore.v1.Firestore'];
for(const [key,codes] of Object.entries(retryConfig.retry_codes))retryConfig.retry_codes[key]=codes.filter(code=>code!=='RESOURCE_EXHAUSTED');
let blockedUntil=0;
function block(error){if(quota(error))blockedUntil=Math.max(blockedUntil,Date.now()+60*60*1000);}
function check(){if(blockedUntil>Date.now()&&!context.getStore()?.manualQuotaProbe)throw Object.assign(Error('FIRESTORE_QUOTA'),{code:8,status:503});}
function install(sdk){
 for(const [name,method] of [['Query','get'],['DocumentReference','get'],['AggregateQuery','get'],['Transaction','get']]){
  const proto=(name==='AggregateQuery'?require('@google-cloud/firestore/build/src/reference/aggregate-query').AggregateQuery:sdk[name])?.prototype,original=proto?.[method];if(!original||original.__readMeter)continue;
  const wrapped=async function(...args){check();const c=context.getStore();if(c)c.databaseCalls++;try{const result=await original.apply(this,args);if(c){if(name==='AggregateQuery'){c.aggregationQueries++;c.minimumBillableReads++;const n=result.data?.().count;if(Number.isFinite(n))c.estimatedAggregationReadUnits=(c.estimatedAggregationReadUnits||0)+Math.max(1,Math.ceil(n/1000));}else {const docs=Array.isArray(result.docs)?result.docs.length:result.exists?1:0;c.documentsRead+=docs;c.minimumBillableReads+=Math.max(1,docs);}}return result;}catch(e){block(e);if(c)c.databaseError=quota(e)?'FIRESTORE_QUOTA':String(e.code||'DATABASE_FAILED');throw e;}};wrapped.__readMeter=true;proto[method]=wrapped;
 }
}
function middleware(req,res,next){const started=Date.now(),c={databaseCalls:0,documentsRead:0,minimumBillableReads:0,aggregationQueries:0};context.run(c,()=>{res.once('finish',()=>{const event={at:new Date().toISOString(),path:req.route?.path||String(req.path||'').replace(/\d{6,}/g,':id'),method:req.method,actorHash:createHash('sha256').update(String(req.adminUser?.email||'anonymous')).digest('hex').slice(0,12),status:res.statusCode,elapsedMs:Date.now()-started,...c};recent.push(event);if(recent.length>200)recent.shift();console.info('[firestore-read]',JSON.stringify(event));});next();});}
async function manualQuotaProbe(fn){const parent=context.getStore(),probe={...(parent||{}),manualQuotaProbe:true};try{const value=await context.run(probe,fn);blockedUntil=0;return value;}finally{if(parent)for(const key of ['databaseCalls','documentsRead','minimumBillableReads','aggregationQueries','estimatedAggregationReadUnits','databaseError'])if(probe[key]!==undefined)parent[key]=probe[key];}}
module.exports={manualQuotaProbe,install,middleware,quota,check,block,diagnostic:()=>({blockedUntil:blockedUntil?new Date(blockedUntil).toISOString():null,recent})};
