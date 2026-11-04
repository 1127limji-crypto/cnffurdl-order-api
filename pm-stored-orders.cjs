'use strict';
const {createHash,randomUUID}=require('node:crypto');
const VERSION='stored-nav-orders-20261104-v1';
const DISPLAY=['productOrderId','orderNo','orderId','matchedEstimateNo','estimateNo','matchType','buyerName','orderName','productName','optionInfo','optionCode','quantity','amount','productOrderStatus','productOrderStatusLabel','status','statusLabel','placeOrderLabel','claimStatus','claimStatusLabel','claimType','shippingMemo','paymentDate','orderDate'];
const FIELDS=[...DISPLAY,'paymentDateYmd','orderDateYmd','localDate','dateYmd','createdAtLocal','createdAtIso','lastSyncedAt','createdAt','updatedAt','receiverName','receiverTel1','baseAddress'];
const INDEX_FIELDS=FIELDS.filter(k=>!['buyerName','orderName','productName','optionInfo','optionCode','shippingMemo','receiverName','receiverTel1','baseAddress','placeOrderLabel','productOrderStatusLabel','statusLabel'].includes(k));
const normalize=v=>String(v||'').normalize('NFKC').toLowerCase().trim();
const koreanCollator=new Intl.Collator('ko');
const rowTimes=new WeakMap();
const rowGroups=new WeakMap();
const koreanDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
const day=v=>{const t=v?.toDate?.()||new Date(v);return Number.isFinite(+t)?koreanDate.format(t):'';};
const shift=(d,n)=>day(new Date(Date.parse(d+'T12:00:00+09:00')+n*86400000));
function storedDay(r){
 for(const k of ['paymentDate','orderDate'])if(r[k]){const d=day(r[k]);if(d)return d;}
 for(const k of ['paymentDateYmd','orderDateYmd','localDate','dateYmd'])if(/^\d{4}-\d{2}-\d{2}$/.test(r[k]||''))return r[k];
 for(const k of ['createdAtLocal','createdAtIso','lastSyncedAt','createdAt','updatedAt'])if(r[k]){const d=day(r[k]);if(d)return d;}
 return '';
}
function excluded(r){return ['CANCEL_DONE','RETURN_DONE'].includes(String(r.claimStatus||'').toUpperCase())||/취소완료|반품완료/.test(String(r.claimStatusLabel||r.claimType||''));}
function compare(sort){
 const text=(a,b)=>koreanCollator.compare(String(a||''),String(b||'')),time=r=>{if(!rowTimes.has(r))rowTimes.set(r,Date.parse(r.paymentDate||r.orderDate||'')||0);return rowTimes.get(r);},group=r=>{if(!rowGroups.has(r))rowGroups.set(r,[r.receiverName,r.receiverTel1,r.baseAddress].join(' '));return rowGroups.get(r);};
 const f={paymentDesc:(a,b)=>time(b)-time(a),matchedOnly:(a,b)=>time(b)-time(a),paymentAsc:(a,b)=>time(a)-time(b),productOrderAsc:(a,b)=>text(a.productOrderId,b.productOrderId),productOrderDesc:(a,b)=>text(b.productOrderId,a.productOrderId),receiverGroup:(a,b)=>text(group(a),group(b))||time(b)-time(a)}[sort];
 if(!f)throw Object.assign(Error('INVALID_SORT'),{status:400});return (a,b)=>f(a,b)||text(a.id,b.id);
}
function filtered(rows,q){const keyword=normalize(q.keyword);return rows.filter(r=>{const d=storedDay(r);return !excluded(r)&&(!q.startDate||d>=q.startDate)&&(!q.endDate||d&&d<=q.endDate)&&(q.sort!=='matchedOnly'||r.matchedEstimateNo||r.estimateNo)&&(!keyword||DISPLAY.map(k=>normalize(r[k])).join(' ').includes(keyword));}).sort(compare(q.sort));}
function project(doc,fields=FIELDS){const data=doc.data(),row={id:doc.id};for(const k of fields)if(data[k]!==undefined)row[k]=data[k];return row;}
module.exports=function register(app,{requireFirebaseAdmin,admin,initFirebaseAdmin,settleMs=300}){
 const cache=new Map(),listFlights=new Map(),failures=[],jobs=new Map(),pendingJobs=new Map();let revision=0,quotaBlockedUntil=0;
 const db=()=>{initFirebaseAdmin();return admin.firestore();};
 const invalidate=()=>{revision++;cache.clear();};
 async function catalog(q,actor){
  if(quotaBlockedUntil>Date.now())throw Object.assign(Error('STORED_READ_QUOTA'),{code:8,status:503});
  const fullFields=!!q.keyword||q.sort==='receiverGroup',fields=fullFields?FIELDS:INDEX_FIELDS;
  const key=JSON.stringify([actor,fullFields?'display':'index',q.startDate,q.endDate,/^\d{10,25}$/.test(normalize(q.keyword))?normalize(q.keyword):'']);
  const old=cache.get(key);if(old&&(old.pending||old.expires>Date.now()&&!q.fresh))return {...await old.promise,cacheHit:true};
  const generation=revision,progress={stage:'starting',queries:0,documents:0,startedAt:Date.now(),projection:fullFields?'display':'index'};
  const promise=(async()=>{
   const collection=db().collection('naverOrders'),rows=new Map(),metrics={queryCount:0,documentsRead:0},started=Date.now();
   const add=doc=>{if(doc?.exists!==false){const row=project(doc);rows.set(row.id,row);}};
   async function read(query,{byId=false}={}){let after=null;for(;;){const next=after?(byId?query.where(admin.firestore.FieldPath.documentId(),'>',after.id):query.startAfter(after)):query;progress.stage='database-query';const snap=await next.select(...fields).limit(5000).get();metrics.queryCount++;metrics.documentsRead+=snap.docs.length;progress.queries=metrics.queryCount;progress.documents=metrics.documentsRead;progress.stage='projecting';for(const doc of snap.docs)add(doc);if(snap.docs.length<5000)break;const last=snap.docs.at(-1);if(after&&last.id===after.id)throw Error('STORED_CURSOR_DID_NOT_ADVANCE');after=last;}}
   const keyword=normalize(q.keyword);
   if(/^\d{10,25}$/.test(keyword)){
    const doc=await collection.doc(keyword).get();metrics.queryCount++;if(doc.exists){metrics.documentsRead++;add(doc);}
    await Promise.all(['orderNo','orderId'].map(k=>read(collection.where(k,'==',keyword))));
   }else if(q.startDate||q.endDate){
    // Each branch uses one indexed date field, before reading metadata. Union preserves old date representations.
    const plans=[['paymentDate','raw'],['orderDate','raw'],['paymentDateYmd','day'],['orderDateYmd','day'],['createdAtLocal','raw'],['createdAtIso','raw'],['lastSyncedAt','timestamp'],['createdAt','timestamp'],['updatedAt','timestamp']];
    let next=0;await Promise.all(Array.from({length:2},async()=>{while(next<plans.length){const [field,type]=plans[next++];let query=collection;
     if(q.startDate)query=query.where(field,'>=',type==='timestamp'?new Date(q.startDate+'T00:00:00+09:00'):type==='raw'?shift(q.startDate,-1):q.startDate);
     if(q.endDate)query=query.where(field,'<',type==='timestamp'?new Date(shift(q.endDate,1)+'T00:00:00+09:00'):type==='raw'?shift(q.endDate,2):shift(q.endDate,1));
     await read(query.orderBy(field));
    }}));
   }else await read(collection,{byId:true});
   const measured={...metrics,uniqueDocuments:rows.size,databaseMs:Date.now()-started};console.info('[stored-orders-db]',JSON.stringify(measured));progress.stage='catalog-ready';progress.databaseMs=measured.databaseMs;return {rows:[...rows.values()],metrics:measured,generatedAt:new Date().toISOString(),generation,fullFields,progress};
  })();
  cache.set(key,{promise,pending:true,progress,expires:Date.now()+60000});if(cache.size>6)cache.delete(cache.keys().next().value);
  try{const value=await promise;const entry=cache.get(key);if(entry?.promise===promise){entry.pending=false;entry.expires=Date.now()+60000;}return {...value,cacheHit:false};}catch(e){if(e.code===8)quotaBlockedUntil=Date.now()+60000;progress.stage='failed';progress.errorCode=e.code||'QUERY_FAILED';failures.push({at:new Date().toISOString(),stage:progress.stage,projection:progress.projection,queries:progress.queries,documents:progress.documents,code:e.code||null,type:e.name,message:String(e.message||'').replace(/https?:\/\/\S+/g,'[link]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/\d{10,}/g,'[id]').slice(0,250)});if(failures.length>5)failures.shift();if(cache.get(key)?.promise===promise)cache.delete(key);throw e;}
 }
 async function listOnce(input,actor){
  const q={startDate:String(input.startDate||''),endDate:String(input.endDate||''),keyword:String(input.keyword||''),sort:String(input.sort||'paymentDesc'),fresh:input.fresh==='1'};
  if([q.startDate,q.endDate].some(d=>d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||day(d+'T12:00:00+09:00')!==d))||q.startDate&&q.endDate&&q.startDate>q.endDate||q.keyword.length>200)throw Object.assign(Error('INVALID_QUERY'),{status:400});compare(q.sort);
  const scope=createHash('sha256').update(JSON.stringify([actor,q.startDate,q.endDate,normalize(q.keyword),q.sort])).digest('hex').slice(0,24),pageSize=Math.max(1,Math.min(50,Number.parseInt(input.pageSize)||30));
  let cursor=null;if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==scope||!cursor.id)throw Error();}catch{throw Object.assign(Error('CURSOR_CONDITION_CHANGED'),{status:409});}}
  const result=await catalog(q,actor);result.progress.stage='filter-sort';const sortStarted=Date.now(),rows=filtered(result.rows,q),filterSortMs=Date.now()-sortStarted;result.progress.filterSortMs=filterSortMs;const metrics={...result.metrics,queryCount:result.cacheHit?0:result.metrics.queryCount,documentsRead:result.cacheHit?0:result.metrics.documentsRead,catalogCacheHit:result.cacheHit};let offset=0;
  if(cursor){const i=rows.findIndex(r=>r.id===cursor.id);if(i<0)throw Object.assign(Error('CURSOR_ITEM_CHANGED'),{status:409});offset=i+1;}
  let pageRows=rows.slice(offset,offset+pageSize);const last=pageRows.at(-1),hasMore=offset+pageRows.length<rows.length;
  if(!result.fullFields&&pageRows.length){result.progress.stage='page-details';const detail=new Map(),batches=[];for(let n=0;n<pageRows.length;n+=10)batches.push(pageRows.slice(n,n+10));let next=0;await Promise.all(Array.from({length:Math.min(2,batches.length)},async()=>{while(next<batches.length){const batch=batches[next++],snapshot=await db().collection('naverOrders').where(admin.firestore.FieldPath.documentId(),'in',batch.map(r=>r.id)).select(...DISPLAY).get();metrics.queryCount++;metrics.documentsRead+=snapshot.docs.length;for(const doc of snapshot.docs)detail.set(doc.id,project(doc,DISPLAY));}}));if(detail.size!==pageRows.length)throw Object.assign(Error('STORED_PAGE_CHANGED'),{status:409});pageRows=pageRows.map(r=>detail.get(r.id));}result.progress.stage='done';
  return {ok:true,version:VERSION,orders:pageRows.map(r=>Object.fromEntries(['id',...DISPLAY].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))),total:rows.length,totalAmount:rows.reduce((n,r)=>n+(Number(r.amount)||0),0),pageSize,offset,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({scope,id:last.id})).toString('base64url'):null,generatedAt:result.generatedAt,metrics:{...metrics,filterSortMs,returnedDocuments:pageRows.length},source:'stored-firestore-readonly',dateBasis:'paymentDate/orderDate; Asia/Seoul; end inclusive'};
 }
 async function list(input,actor){const key=JSON.stringify([revision,actor,input.startDate||'',input.endDate||'',normalize(input.keyword),input.sort||'paymentDesc',String(input.pageSize||30),input.cursor||'',input.fresh==='1']);if(listFlights.has(key))return listFlights.get(key);const promise=listOnce(input,actor);listFlights.set(key,promise);try{return await promise;}finally{if(listFlights.get(key)===promise)listFlights.delete(key);}}
 function scope(input,actor){return createHash('sha256').update(JSON.stringify([actor,String(input.startDate||''),String(input.endDate||''),normalize(input.keyword),input.sort||'paymentDesc',String(input.pageSize||30),input.cursor||''])).digest('hex');}
 async function preview(input){
  if(input.cursor||/^\d{10,25}$|^\d{6}-\d{6}$/.test(normalize(input.keyword)))return [];
  const collection=db().collection('naverOrders'),keyword=String(input.keyword||'').trim(),map=new Map();
  const add=doc=>map.set(doc.id,project(doc,DISPLAY));
  if(keyword){
   const variants=[...new Set([keyword.normalize('NFC'),keyword.normalize('NFD'),keyword.normalize('NFKC')])],plans=[];
   for(const term of variants)for(const field of ['buyerName','orderName','productName'])plans.push([field,term]);
   let next=0;await Promise.all(Array.from({length:2},async()=>{while(next<plans.length){const [field,value]=plans[next++],snap=await collection.where(field,'==',value).select(...DISPLAY).limit(50).get();for(const doc of snap.docs)add(doc);}}));
  }else{
   const sort=String(input.sort||'paymentDesc'),field=sort.startsWith('productOrder')?'productOrderId':'paymentDate',direction=sort.endsWith('Asc')?'asc':'desc';
   const snap=await collection.orderBy(field,direction).select(...DISPLAY).limit(50).get();for(const doc of snap.docs)add(doc);
  }
  return filtered([...map.values()],{...input,sort:input.sort||'paymentDesc'}).slice(0,Math.min(50,Number(input.pageSize)||30));
 }
 async function asyncList(input,actor){
  const key=scope(input,actor),now=Date.now();for(const [id,j] of jobs)if(j.expires<now){jobs.delete(id);if(pendingJobs.get(j.key)===j)pendingJobs.delete(j.key);}
  let job;
  if(input.jobId){job=jobs.get(String(input.jobId));if(!job)throw Object.assign(Error('READ_JOB_EXPIRED'),{status:404});if(job.actor!==actor)throw Object.assign(Error('READ_JOB_OWNER'),{status:403});if(job.key!==key||job.revision!==revision)throw Object.assign(Error('READ_JOB_CHANGED'),{status:409});}
  else{
   job=pendingJobs.get(key);if(job&&(job.revision!==revision||job.expires<now)){pendingJobs.delete(key);job=null;}
   if(!job){
    if(jobs.size>=64){for(const [id,j] of jobs)if(j.state!=='pending')jobs.delete(id);if(jobs.size>=64)throw Object.assign(Error('READ_BUSY'),{status:429});}
    job={id:randomUUID(),key,actor,revision,state:'pending',startedAt:new Date().toISOString(),expires:now+120000,preview:[]};jobs.set(job.id,job);pendingJobs.set(key,job);
    job.promise=list(input,actor).then(result=>{job.state='done';job.result=result;return job;},error=>{job.state='failed';job.error=error;return job;}).finally(()=>{if(pendingJobs.get(key)===job)pendingJobs.delete(key);});
    if(!input.startDate&&!input.endDate&&quotaBlockedUntil<Date.now())job.previewPromise=preview(input).then(rows=>{job.preview=rows;},()=>{});
   }
  }
  if(job.state==='pending'&& !input.jobId){let timer;await Promise.race([job.promise,new Promise(resolve=>{timer=setTimeout(resolve,settleMs);})]);clearTimeout(timer);}
  if(job.state==='failed')throw job.error;
  if(job.state==='done')return {status:200,body:job.result};
  return {status:202,body:{ok:true,pending:true,version:VERSION,jobId:job.id,preview:job.preview,startedAt:job.startedAt,retryAfterMs:1000}};
 }
 app.get('/stored/admin/naver-orders',requireFirebaseAdmin,async(req,res)=>{res.set('Cache-Control','private, no-store');try{
  if(req.query.async==='1'){const value=await asyncList(req.query,req.adminUser.email);return res.status(value.status).json(value.body);}
  return res.json(await list(req.query,req.adminUser.email));
 }catch(e){return res.status(e.code===8?503:e.status||500).json({ok:false,message:e.code===8?'원본 저장DB의 읽기 할당량을 초과했습니다. 할당량 복구 후 다시 조회해주세요.':e.status===400?'조회 조건을 확인해주세요.':e.status===409?'조회 조건이나 데이터가 바뀌었습니다. 처음 페이지부터 다시 조회해주세요.':e.status===403?'조회 권한을 확인해주세요.':'저장 주문 조회에 실패했습니다. 다시 조회해주세요.',code:e.status?e.message:'STORED_QUERY_FAILED',databaseCode:typeof e.code==='number'?e.code:null});}});
 app.get('/stored/admin/naver-orders/diagnostic',requireFirebaseAdmin,async(req,res)=>{try{if(req.query.runtime==='1')return res.set('Cache-Control','private, no-store').json({ok:true,version:VERSION,quotaRetryAfterSeconds:Math.max(0,Math.ceil((quotaBlockedUntil-Date.now())/1000)),lastFailures:failures,readProgress:[...cache.values()].map(e=>({...e.progress,pending:e.pending,elapsedMs:Date.now()-e.progress.startedAt}))});const id=String(req.query.productOrderId||'');if(!/^\d{10,25}$/.test(id))return res.status(400).json({ok:false});if(quotaBlockedUntil>Date.now())return res.status(503).set('Cache-Control','private, no-store').json({ok:false,message:'원본 저장DB의 읽기 할당량을 초과했습니다. 할당량 복구 후 다시 조회해주세요.',code:'STORED_READ_QUOTA'});const collection=db().collection('naverOrders');const [doc,count,total]=await Promise.all([collection.doc(id).get(),collection.where(admin.firestore.FieldPath.documentId(),'<',id).count().get(),collection.count().get()]);const probeQuery=collection.select('paymentDate').limit(2),probeA=await probeQuery.get(),probeB=probeA.docs.length?await probeQuery.startAfter(probeA.docs.at(-1)).get():{docs:[]};const cursorProbe={first:probeA.docs.length,next:probeB.docs.length,repeated:probeB.docs.some(d=>probeA.docs.some(a=>a.id===d.id))};const before=count.data().count;res.set('Cache-Control','private, no-store').json({ok:true,version:VERSION,exists:doc.exists,cursorProbe,quotaRetryAfterSeconds:Math.max(0,Math.ceil((quotaBlockedUntil-Date.now())/1000)),lastFailures:failures,readProgress:[...cache.values()].map(e=>({...e.progress,pending:e.pending,elapsedMs:Date.now()-e.progress.startedAt})),totalStoredDocuments:total.data().count,earlierDocumentIds:before,oldLimit:2000,excludedByOldLimit:doc.exists&&before>=2000,order:doc.exists?project(doc,['productOrderId','orderNo','paymentDate','matchedEstimateNo','quantity','amount']):null});}catch{res.status(502).json({ok:false,message:'저장 주문 진단 조회 실패'});}});
 return {list,invalidate,version:VERSION};
};
module.exports.storedDay=storedDay;module.exports.filtered=filtered;module.exports.compare=compare;
