'use strict';
// One shared server stream per collection, persisted resume token. No client-driven scans.
const {randomUUID}=require('node:crypto');
const request=require('./read-index-client.cjs');
const readMetrics=require('./firestore-read-metrics.cjs');
const {Recovery,WINDOW_MS,grpcCode}=require('./firestore-reconnect.cjs');
const recoveries=new Map(),waiting=new Map(),history=new Map();
const KINDS=['naverOrders','estimates'];
const bootstrapFlights=new Map(),running=new Map();
function value(v){if(v.nullValue!==undefined)return null;if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return Number(v.integerValue);if(v.doubleValue!==undefined)return v.doubleValue;if(v.booleanValue!==undefined)return v.booleanValue;if(v.timestampValue){const t=v.timestampValue;return new Date(Number(t.seconds)*1000+Math.floor((t.nanos||0)/1e6)).toISOString();}if(v.arrayValue)return(v.arrayValue.values||[]).map(value);if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,v])=>[k,value(v)]));return undefined;}
const timestamp=t=>t?new Date(Number(t.seconds)*1000+Math.floor((t.nanos||0)/1e6)).toISOString():undefined;
function credentials(){if(process.env.FIRESTORE_EMULATOR_HOST){if(!String(process.env.FIREBASE_PROJECT_ID).startsWith('demo-'))throw Error('EMULATOR_DEMO_PROJECT_REQUIRED');return {projectId:process.env.FIREBASE_PROJECT_ID};}return {projectId:process.env.FIREBASE_PROJECT_ID,credentials:{client_email:process.env.FIREBASE_CLIENT_EMAIL,private_key:String(process.env.FIREBASE_PRIVATE_KEY||'').replace(/\\n/g, "\n")},fallback:false};}
async function run(kind,{bootstrap=false,maxReads=0,indexRequest=request,clientFactory,fields,recovery=recoveries.get(kind)||new Recovery(),leaseRetryDelayMs,manualResume}={}){
 if(running.has(kind))return running.get(kind).status;
 readMetrics.check();
 recoveries.set(kind,recovery);clearTimeout(waiting.get(kind));waiting.delete(kind);
 const stateStatus={kind,state:'connecting',bootstrap,documentsRead:0,retryAttempt:recovery.attempt,disconnectedAt:recovery.since?new Date(recovery.since).toISOString():null};history.set(kind,stateStatus);
 const options={indexRequest,clientFactory,fields,recovery,leaseRetryDelayMs};
 let caughtUp=false;
 function retry(error){
  if(error.message==='INDEX_MANUAL_STOP')return;
  const delay=manualResume&&!caughtUp?null:recovery.failed(error);
  if(!recovery.since)recovery.since=manualResume?.expectedDisconnectedAt||Date.now();
  Object.assign(stateStatus,{state:delay===null?'stopped':'retrying',error:recovery.expired()?'INDEX_RECONNECT_WINDOW_EXPIRED':readMetrics.quota(error)?'FIRESTORE_QUOTA':/^[A-Z_]{3,80}$/.test(error.message||'')?error.message:'INDEX_STREAM_FAILED',retryAttempt:recovery.attempt,disconnectedAt:new Date(recovery.since).toISOString(),manualRequired:delay===null,errorCode:grpcCode(error),retryable:delay!==null,nextRetryAt:delay===null?null:new Date(Date.now()+(leaseRetryDelayMs||delay)).toISOString()});
  if(delay!==null){const timer=setTimeout(()=>{waiting.delete(kind);run(kind,options).catch(()=>{});},leaseRetryDelayMs||delay);timer.unref?.();waiting.set(kind,timer);}
 }
 if(recovery.expired()){retry(Error('INDEX_RECONNECT_WINDOW_EXPIRED'));return stateStatus;}

 if(!KINDS.includes(kind))throw Error('INVALID_SOURCE');
 const {project:projectRecord}=await import('./read-index-model.mjs');
 const owner=randomUUID(),generation=randomUUID();
 let lease;try{lease=await indexRequest({action:'lease',kind,owner,generation,bootstrap,manualResume});}catch(e){retry(e);throw e;}
 if(manualResume&&!lease.reviewAccepted)throw Object.assign(Error('INDEX_RESUME_REVIEW_NOT_AVAILABLE'),{status:409});
 if(lease.bootstrapRequired){history.delete(kind);return {kind,bootstrapRequired:true};}
 const checkpoint=lease.state;
 if(checkpoint.ready){if(!bootstrap&&!manualResume)recovery.restore(checkpoint);if(recovery.begin()){const e=Error('INDEX_RECONNECT_WINDOW_EXPIRED');retry(e);await indexRequest({action:'error',kind,owner,error:e.message,disconnectedAt:recovery.since,retryAttempt:recovery.attempt}).catch(()=>{});return stateStatus;}recovery.budget ||= Math.min(Number(lease.recordCount||0)+100,maxReads||Infinity);}

 if(manualResume&&(!checkpoint.ready||!checkpoint.token))throw Object.assign(Error('INDEX_SAVED_CHECKPOINT_REQUIRED'),{status:409});
 if(!checkpoint.ready&&checkpoint.documents_read>0)throw Object.assign(Error('INDEX_PARTIAL_REBUILD_REQUIRED'),{status:409});
 if(!checkpoint.token&&!bootstrap)return {kind,bootstrapRequired:true};
 if(!checkpoint.token&&!checkpoint.ready&&!maxReads)throw Error('BOOTSTRAP_READ_BUDGET_REQUIRED');
 const {v1}=require('@google-cloud/firestore');
 const client=clientFactory?clientFactory():new v1.FirestoreClient(credentials());
 const database=`projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)`,parent=database+'/documents';
 let stream;const status=Object.assign(stateStatus,{startedAt:new Date().toISOString(),reconnectReadLimit:checkpoint.ready?recovery.budget:maxReads});
 let sequence=checkpoint.sequence||0,changes=[],readCount=0,current=!!checkpoint.ready,closed=false,processing=Promise.resolve(),heartbeat,deadline;let lastActivity=Date.now();
 const meta={owner,kind};
 const stop=async error=>{
  if(closed)return;closed=true;clearInterval(heartbeat);clearTimeout(deadline);status.state='stopped';status.error=readMetrics.quota(error)?'FIRESTORE_QUOTA':/^[A-Z_]{3,80}$/.test(error.message||'')?error.message:'INDEX_STREAM_FAILED';readMetrics.block(error);
  stream?.cancel?.();stream?.destroy?.();running.delete(kind);
  retry(error);await indexRequest({...meta,action:'error',error:status.error,errorCode:grpcCode(error),disconnectedAt:manualResume&&!caughtUp?manualResume.expectedDisconnectedAt:recovery.since,retryAttempt:recovery.attempt}).catch(()=>{});await client.close?.().catch(()=>{});
  console.warn('[firestore-index-stream]',JSON.stringify(status));

 };
 async function flush(extra={}){
  if(closed)throw Error('INDEX_STREAM_STOPPED');
  const payload={...meta,action:'apply',sequence:sequence+1,changes,documentsRead:readCount,bootstrap:!current,...extra};
  // Same batch and sequence may be delivered again if the HTTP response is lost.
  let result;try{result=await indexRequest(payload);}catch(e){if(e.status&&e.status<500)throw e;result=await indexRequest(payload);}
  sequence++;changes=[];readCount=0;return result;
 }
 stream=client.listen({retry:null,otherArgs:{headers:{'google-cloud-resource-prefix':database}}});
 const handle=async r=>{
  if(closed)return;
  if(r.filter){if(changes.length)await flush();await indexRequest({...meta,action:'verify',expectedCount:r.filter.count});return;}
  if(r.documentChange){
   if(!caughtUp&&checkpoint.ready&&recovery.reads>=recovery.budget)throw Error('INDEX_RECONNECT_READ_BUDGET_EXCEEDED');
   if(bootstrap&&!current&&status.documentsRead>=maxReads)throw Error('BOOTSTRAP_READ_BUDGET_EXCEEDED');
   const document=r.documentChange.document,id=document.name.split('/').at(-1);
   const data={};for(const [key,entry] of Object.entries(document.fields||{}))if(fields.includes(key))data[key]=value(entry);
   status.documentsRead++;if(!caughtUp&&checkpoint.ready)recovery.reads++;
   if(!caughtUp&&checkpoint.ready&&recovery.reads>=recovery.budget)throw Error('INDEX_RECONNECT_READ_BUDGET_EXCEEDED');
   if(bootstrap&&!current&&status.documentsRead>=maxReads)throw Error('BOOTSTRAP_READ_BUDGET_EXCEEDED');
   readCount++;changes.push({id,data:projectRecord(kind,id,data)});
  }
  if(r.documentDelete||r.documentRemove){const change=r.documentDelete||r.documentRemove;changes.push({id:change.document.split('/').at(-1),deleted:true});}
  if(changes.length>=50||Buffer.byteLength(JSON.stringify(changes))>=128*1024)await flush();
  if(r.targetChange){
   const t=r.targetChange,type=t.targetChangeType;
   if(type==='RESET'||type===4)throw Error('INDEX_RESET_REQUIRES_CONTROLLED_REBUILD');
   if(t.cause?.code)throw Object.assign(Error('FIRESTORE_STREAM_REJECTED'),{code:t.cause.code});
   const becameCurrent=type==='CURRENT'||type===3;
   if(t.resumeToken?.length||t.readTime||becameCurrent){await flush({token:t.resumeToken?.length?Buffer.from(t.resumeToken).toString('base64'):undefined,readTime:timestamp(t.readTime),current:becameCurrent});if(becameCurrent||current&&t.readTime){current=true;caughtUp=true;recovery.connected();clearTimeout(deadline);Object.assign(status,{state:'current',error:null,errorCode:null,retryable:false,retryAttempt:0,disconnectedAt:null,nextRetryAt:null,manualRequired:false});}}
  }
 };
 stream.on('data',r=>{lastActivity=Date.now();stream.pause();processing=processing.then(()=>handle(r)).then(()=>{if(!closed)stream.resume();}).catch(stop);});
 stream.on('error',e=>{e.firestoreTransportError=true;processing=processing.then(()=>stop(e));});
 stream.on('end',()=>{processing=processing.then(()=>stop(Error('INDEX_STREAM_ENDED')));});
 heartbeat=setInterval(()=>{processing=processing.then(()=>{if(Date.now()-lastActivity>90000)throw Object.assign(Error('INDEX_STREAM_IDLE'),{code:14});return flush();}).catch(stop);},20000);heartbeat.unref?.();
 running.set(kind,{status,stop});
 if(recovery.since){deadline=setTimeout(()=>stop(Error('INDEX_RECONNECT_WINDOW_EXPIRED')),Math.max(1,WINDOW_MS-(Date.now()-recovery.since)));deadline.unref?.();}
 const target={targetId:1,query:{parent,structuredQuery:{from:[{collectionId:kind}]}}};
 if(checkpoint.token)target.resumeToken=Buffer.from(checkpoint.token,'base64');

 stream.write({database,addTarget:target});
 return status;
}
async function startFromCheckpoint(options={}){
 const {SOURCE_FIELDS}=await import('./read-index-model.mjs');
 async function startKind(kind,attempt=0){
  try{await run(kind,{...options,fields:SOURCE_FIELDS[kind]});}
  catch(e){console.warn('[firestore-index-start]',JSON.stringify({kind,code:e.status||'UNAVAILABLE'}));
  }
 }
 for(const kind of KINDS)await startKind(kind);
}
async function bootstrap(kind,maxReads,options={}){
 if(!KINDS.includes(kind))throw Object.assign(Error('INVALID_SOURCE'),{status:400});
 if(running.has(kind))return running.get(kind).status;
 if(bootstrapFlights.has(kind))return bootstrapFlights.get(kind);
 const flight=(async()=>{
  const {SOURCE_FIELDS}=await import('./read-index-model.mjs');
  if(!Number.isInteger(maxReads)||maxReads<1||maxReads>12000)throw Object.assign(Error('INVALID_READ_BUDGET'),{status:400});
  // Count preflight does not read source documents. Billing is recorded separately as index reads.
  const {Firestore}=require('@google-cloud/firestore'),db=new Firestore({...credentials(),preferRest:!process.env.FIRESTORE_EMULATOR_HOST});
  let count;try{count=(await readMetrics.manualQuotaProbe(()=>db.collection(kind).count().get())).data().count;}catch(e){readMetrics.block(e);throw e;}finally{await db.terminate();}if(count+100>maxReads)throw Object.assign(Error('BOOTSTRAP_EXCEEDS_READ_BUDGET'),{status:409});
  return run(kind,{...options,bootstrap:true,maxReads,fields:SOURCE_FIELDS[kind],recovery:new Recovery()});
 })();bootstrapFlights.set(kind,flight);try{return await flight;}finally{bootstrapFlights.delete(kind);}
}
async function resume(kind,maxReads,expectedDisconnectedAt,options={}){
 if(!KINDS.includes(kind)||!Number.isInteger(maxReads)||maxReads<1||maxReads>199||!Number.isSafeInteger(expectedDisconnectedAt)||expectedDisconnectedAt<=0)throw Object.assign(Error('INVALID_RESUME_REVIEW'),{status:400});
 if(running.has(kind)||waiting.has(kind))throw Object.assign(Error('INDEX_ALREADY_ACTIVE'),{status:409});
 const {SOURCE_FIELDS}=await import('./read-index-model.mjs');
 return run(kind,{...options,maxReads,fields:SOURCE_FIELDS[kind],recovery:new Recovery(),manualResume:{expectedDisconnectedAt,maxReads}});
}
module.exports={run,bootstrap,resume,startFromCheckpoint,value,shutdown:async(kind)=>{const r=running.get(kind);clearTimeout(waiting.get(kind));waiting.delete(kind);if(r)await r.stop(Error('INDEX_MANUAL_STOP'));history.delete(kind);recoveries.delete(kind);},status:()=>[...history.values()].map(x=>({...x}))};
