'use strict';
const {createHash}=require('node:crypto');
const VERSION='stored-nav-orders-20261104-v1';
const DISPLAY=['productOrderId','orderNo','orderId','matchedEstimateNo','estimateNo','matchType','buyerName','orderName','productName','optionInfo','optionCode','quantity','amount','productOrderStatus','productOrderStatusLabel','status','statusLabel','placeOrderLabel','claimStatus','claimStatusLabel','claimType','shippingMemo','paymentDate','orderDate'];
const FIELDS=[...DISPLAY,'paymentDateYmd','orderDateYmd','localDate','dateYmd','createdAtLocal','createdAtIso','lastSyncedAt','createdAt','updatedAt','receiverName','receiverTel1','baseAddress'];
const normalize=v=>String(v||'').normalize('NFKC').toLowerCase().trim();
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
 const text=(a,b)=>String(a||'').localeCompare(String(b||''),'ko'),time=r=>Date.parse(r.paymentDate||r.orderDate||'')||0;
 const f={paymentDesc:(a,b)=>time(b)-time(a),matchedOnly:(a,b)=>time(b)-time(a),paymentAsc:(a,b)=>time(a)-time(b),productOrderAsc:(a,b)=>text(a.productOrderId,b.productOrderId),productOrderDesc:(a,b)=>text(b.productOrderId,a.productOrderId),receiverGroup:(a,b)=>text([a.receiverName,a.receiverTel1,a.baseAddress].join(' '),[b.receiverName,b.receiverTel1,b.baseAddress].join(' '))||time(b)-time(a)}[sort];
 if(!f)throw Object.assign(Error('INVALID_SORT'),{status:400});return (a,b)=>f(a,b)||text(a.id,b.id);
}
function filtered(rows,q){const keyword=normalize(q.keyword);return rows.filter(r=>{const d=storedDay(r);return !excluded(r)&&(!q.startDate||d>=q.startDate)&&(!q.endDate||d&&d<=q.endDate)&&(q.sort!=='matchedOnly'||r.matchedEstimateNo||r.estimateNo)&&(!keyword||DISPLAY.map(k=>normalize(r[k])).join(' ').includes(keyword));}).sort(compare(q.sort));}
function project(doc,fields=FIELDS){const data=doc.data(),row={id:doc.id};for(const k of fields)if(data[k]!==undefined)row[k]=data[k];return row;}
module.exports=function register(app,{requireFirebaseAdmin,admin,initFirebaseAdmin}){
 const cache=new Map();let revision=0;
 const db=()=>{initFirebaseAdmin();return admin.firestore();};
 const invalidate=()=>{revision++;cache.clear();};
 async function catalog(q,actor){
  const key=JSON.stringify([actor,q.startDate,q.endDate,/^\d{10,25}$|^\d{6}-\d{6}$/.test(normalize(q.keyword))?normalize(q.keyword):'']);
  const old=cache.get(key);if(old&&(old.pending||old.expires>Date.now()&&!q.fresh))return old.promise;
  const generation=revision;
  const promise=(async()=>{
   const collection=db().collection('naverOrders'),rows=new Map(),metrics={queryCount:0,documentsRead:0},started=Date.now();
   const add=doc=>{if(doc?.exists!==false){const row=project(doc);rows.set(row.id,row);}};
   async function read(query){let after=null;for(;;){const snap=await (after?query.startAfter(after):query).select(...FIELDS).limit(250).get();metrics.queryCount++;metrics.documentsRead+=snap.docs.length;for(const doc of snap.docs)add(doc);if(snap.docs.length<250)break;after=snap.docs.at(-1);}}
   const keyword=normalize(q.keyword);
   if(/^\d{10,25}$/.test(keyword)){
    const doc=await collection.doc(keyword).get();metrics.queryCount++;if(doc.exists){metrics.documentsRead++;add(doc);}
    await Promise.all(['orderNo','orderId'].map(k=>read(collection.where(k,'==',keyword))));
   }else if(/^\d{6}-\d{6}$/.test(keyword)){
    await Promise.all(['matchedEstimateNo','estimateNo'].map(k=>read(collection.where(k,'==',keyword))));
   }else if(q.startDate||q.endDate){
    // Each branch uses one indexed date field, before reading metadata. Union preserves old date representations.
    const plans=[['paymentDate','raw'],['orderDate','raw'],['paymentDateYmd','day'],['orderDateYmd','day'],['createdAtLocal','raw'],['createdAtIso','raw'],['lastSyncedAt','timestamp'],['createdAt','timestamp'],['updatedAt','timestamp']];
    let next=0;await Promise.all(Array.from({length:2},async()=>{while(next<plans.length){const [field,type]=plans[next++];let query=collection;
     if(q.startDate)query=query.where(field,'>=',type==='timestamp'?new Date(q.startDate+'T00:00:00+09:00'):type==='raw'?shift(q.startDate,-1):q.startDate);
     if(q.endDate)query=query.where(field,'<',type==='timestamp'?new Date(shift(q.endDate,1)+'T00:00:00+09:00'):type==='raw'?shift(q.endDate,2):shift(q.endDate,1));
     await read(query.orderBy(field));
    }}));
   }else await read(collection.orderBy(admin.firestore.FieldPath.documentId()));
   const measured={...metrics,uniqueDocuments:rows.size,databaseMs:Date.now()-started};console.info('[stored-orders-db]',JSON.stringify(measured));return {rows:[...rows.values()],metrics:measured,generatedAt:new Date().toISOString(),generation};
  })();
  cache.set(key,{promise,pending:true,expires:Date.now()+15000});if(cache.size>6)cache.delete(cache.keys().next().value);
  try{const value=await promise;const entry=cache.get(key);if(entry?.promise===promise){entry.pending=false;entry.expires=Date.now()+15000;}return value;}catch(e){if(cache.get(key)?.promise===promise)cache.delete(key);throw e;}
 }
 async function list(input,actor){
  const q={startDate:String(input.startDate||''),endDate:String(input.endDate||''),keyword:String(input.keyword||''),sort:String(input.sort||'paymentDesc'),fresh:input.fresh==='1'};
  if([q.startDate,q.endDate].some(d=>d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||day(d+'T12:00:00+09:00')!==d))||q.startDate&&q.endDate&&q.startDate>q.endDate||q.keyword.length>200)throw Object.assign(Error('INVALID_QUERY'),{status:400});compare(q.sort);
  const scope=createHash('sha256').update(JSON.stringify([actor,q.startDate,q.endDate,normalize(q.keyword),q.sort])).digest('hex').slice(0,24),pageSize=Math.max(1,Math.min(50,Number.parseInt(input.pageSize)||30));
  let cursor=null;if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.scope!==scope||!cursor.id)throw Error();}catch{throw Object.assign(Error('CURSOR_CONDITION_CHANGED'),{status:409});}}
  const result=await catalog(q,actor),rows=filtered(result.rows,q);let offset=0;
  if(cursor){const i=rows.findIndex(r=>r.id===cursor.id);if(i<0)throw Object.assign(Error('CURSOR_ITEM_CHANGED'),{status:409});offset=i+1;}
  const pageRows=rows.slice(offset,offset+pageSize),last=pageRows.at(-1),hasMore=offset+pageRows.length<rows.length;
  return {ok:true,version:VERSION,orders:pageRows.map(r=>Object.fromEntries(['id',...DISPLAY].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))),total:rows.length,totalAmount:rows.reduce((n,r)=>n+(Number(r.amount)||0),0),pageSize,offset,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({scope,id:last.id})).toString('base64url'):null,generatedAt:result.generatedAt,metrics:{...result.metrics,returnedDocuments:pageRows.length},source:'stored-firestore-readonly',dateBasis:'paymentDate/orderDate; Asia/Seoul; end inclusive'};
 }
 app.get('/stored/admin/naver-orders',requireFirebaseAdmin,async(req,res)=>{try{res.set('Cache-Control','private, no-store').json(await list(req.query,req.adminUser.email));}catch(e){res.status(e.status||502).json({ok:false,message:e.status===400?'조회 조건을 확인해주세요.':e.status===409?'조회 조건이나 목록이 바뀌었습니다. 처음 페이지부터 다시 조회해주세요.':'저장 주문 조회에 실패했습니다. 다시 조회해주세요.',code:e.status?e.message:'STORED_QUERY_FAILED'});}});
 app.get('/stored/admin/naver-orders/diagnostic',requireFirebaseAdmin,async(req,res)=>{try{const id=String(req.query.productOrderId||'');if(!/^\d{10,25}$/.test(id))return res.status(400).json({ok:false});const collection=db().collection('naverOrders');const [doc,count,total]=await Promise.all([collection.doc(id).get(),collection.where(admin.firestore.FieldPath.documentId(),'<',id).count().get(),collection.count().get()]);const before=count.data().count;res.set('Cache-Control','private, no-store').json({ok:true,version:VERSION,exists:doc.exists,totalStoredDocuments:total.data().count,earlierDocumentIds:before,oldLimit:2000,excludedByOldLimit:doc.exists&&before>=2000,order:doc.exists?project(doc,['productOrderId','orderNo','paymentDate','matchedEstimateNo','quantity','amount']):null});}catch{res.status(502).json({ok:false,message:'저장 주문 진단 조회 실패'});}});
 return {list,invalidate,version:VERSION};
};
module.exports.storedDay=storedDay;module.exports.filtered=filtered;module.exports.compare=compare;
