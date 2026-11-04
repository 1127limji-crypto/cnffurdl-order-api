'use strict';
const assert=require('node:assert/strict'),register=require('../pm-stored-orders.cjs');
let rows,reads=0,queries=[],fail=false,readGate=null;
const copy=v=>structuredClone(v),snapshot=(id,data)=>({id,exists:!!data,data:()=>copy(data)});
class Query{
 constructor(filters=[],mask=null,order='__name__',after=null,n=Infinity,direction='asc'){Object.assign(this,{filters,mask,order,after,n,direction});}
 where(k,op,v){return new Query([...this.filters,[k,op,v]],this.mask,this.order,this.after,this.n,this.direction);}
 select(...mask){return new Query(this.filters,mask,this.order,this.after,this.n,this.direction);}
 orderBy(k,direction='asc'){assert(!(k==='__name__'&&direction==='desc'),'production has no descending document-ID index');return new Query(this.filters,this.mask,k,this.after,this.n,direction);}
 startAfter(doc){return new Query(this.filters,this.mask,this.order,doc.id,this.n,this.direction);}
 limit(n){return new Query(this.filters,this.mask,this.order,this.after,n,this.direction);}
 values(){return Object.entries(rows).filter(([id,r])=>this.filters.every(([k,op,v])=>{const value=k==='__name__'?id:r[k];if(value===undefined)return false;if(op==='in')return v.includes(value);if((v instanceof Date)!==(value instanceof Date))return false;return op==='=='?value===v:op==='>='?value>=v:op==='>'?value>v:value<v;})).filter(([id,r])=>this.order==='__name__'||r[this.order]!==undefined).sort(([a,ar],[b,br])=>{const av=this.order==='__name__'?a:ar[this.order],bv=this.order==='__name__'?b:br[this.order];return ((av>bv?1:av<bv?-1:0)||a.localeCompare(b))*(this.direction==='desc'?-1:1);});}
 async get(){if(readGate)await readGate;if(fail)throw Object.assign(Error('isolated DB failure'),{code:fail===8?8:undefined});queries.push({filters:this.filters,mask:this.mask});let out=this.values();if(this.after)out=out.slice(out.findIndex(([id])=>id===this.after)+1);out=out.slice(0,this.n);reads+=out.length;return {docs:out.map(([id,r])=>snapshot(id,this.mask?Object.fromEntries(this.mask.filter(k=>r[k]!==undefined).map(k=>[k,r[k]])):r))};}
 doc(id){return {get:async()=>{if(fail)throw Object.assign(Error('isolated DB failure'),{code:fail===8?8:undefined});reads+=rows[id]?1:0;return snapshot(id,rows[id]);}};}
 count(){return {get:async()=>({data:()=>({count:this.values().length})})};}
}
const routes=new Map(),guard=()=>{},app={get:(p,...handlers)=>{assert.equal(handlers[0],guard);routes.set(p,handlers.at(-1));}};
const firestore=()=>({collection:n=>{assert.equal(n,'naverOrders');return new Query();}});firestore.FieldPath={documentId:()=>'__name__'};
const service=register(app,{requireFirebaseAdmin:guard,admin:{firestore},initFirebaseAdmin:()=>{}});
const no='991102-000001',id='9000000093584231',parent='9000000073490761';
function reset(){rows={};for(let n=0;n<2500;n++)rows['20260101'+String(n).padStart(8,'0')]={productOrderId:'20260101'+String(n).padStart(8,'0'),paymentDate:'2026-01-01T10:00:00+09:00',paymentDateYmd:'2026-01-01',amount:10,raw:{doNotReturn:'large'}};
 for(let n=0;n<65;n++){const pid='900000009999'+String(n).padStart(4,'0');rows[pid]={productOrderId:pid,orderNo:'9000000099000000',paymentDate:'2026-11-04T12:00:00+09:00',amount:100,quantity:1,buyerName:'테스트',raw:{doNotReturn:'large'}};}
 rows[id]={productOrderId:id,orderNo:parent,paymentDate:'2026-11-04T08:26:13.964+09:00',amount:230400,quantity:2304,buyerName:'격리테스트'.normalize('NFD'),matchedEstimateNo:no,estimateNo:no,matchType:'manual',raw:{neverChange:true}};
 for(let n=0;n<10;n++)rows['90000000935841'+String(n).padStart(2,'0')]={productOrderId:'90000000935841'+String(n).padStart(2,'0'),orderNo:parent,paymentDate:'2026-11-04T08:26:13.964+09:00',amount:100,quantity:2};
 service.invalidate();reads=0;queries=[];fail=false;}
async function route(path,query,actor='qa@example.test'){let status=200,body,headers={};const res={set:(k,v)=>{headers[k]=v;return res;},status:n=>{status=n;return res;},json:b=>{body=b;return res;}};await routes.get(path)({query,adminUser:{email:actor}},res);return {status,body,headers};}
(async()=>{
 reset();const cold=register(app,{requireFirebaseAdmin:guard,admin:{firestore},initFirebaseAdmin:()=>{}});assert.equal((await cold.list({pageSize:50},'coldAdmin')).total,2576);reset();const before=copy(rows),base={startDate:'2026-11-04',endDate:'2026-11-04',pageSize:'50'};
 const first=await service.list(base,'adminA');assert.equal(first.orders.length,50);assert.equal(first.total,76);assert.equal(first.orders.some(r=>r.productOrderId===id),false);assert(first.metrics.documentsRead<2500);assert(queries.every(q=>q.mask&&q.filters.length));assert(!JSON.stringify(first).includes('doNotReturn'));
 const second=await service.list({...base,cursor:first.nextCursor},'adminA');assert.equal(second.orders.length,26);assert.equal(new Set([...first.orders,...second.orders].map(r=>r.id)).size,76);assert.equal(second.hasMore,false);
 await assert.rejects(service.list({...base,keyword:'격리테스트',cursor:first.nextCursor},'adminA'),e=>e.status===409);await assert.rejects(service.list({...base,cursor:first.nextCursor},'adminB'),e=>e.status===409);
 service.invalidate();reads=0;const direct=await service.list({...base,keyword:id},'adminA');assert.equal(direct.total,1);assert.equal(direct.orders[0].matchedEstimateNo,no);assert.equal(direct.orders[0].quantity,2304);assert.equal(reads,1);
 assert.equal((await service.list({...base,keyword:parent},'adminA')).total,11);assert.equal((await service.list({...base,keyword:no},'adminA')).total,1);assert.equal((await service.list({...base,keyword:'격리테스트'},'adminA')).total,1);
 const diagnostic=await route('/stored/admin/naver-orders/diagnostic',{productOrderId:id});assert.equal(diagnostic.status,200);assert(diagnostic.body.earlierDocumentIds>=2500);assert.equal(diagnostic.body.excludedByOldLimit,true);assert.equal(diagnostic.headers['Cache-Control'],'private, no-store');
 rows[id].paymentDate='2026-11-03T23:26:00Z';rows[id].paymentDateYmd='2026-11-03';service.invalidate();assert.equal((await service.list({...base,keyword:id},'adminA')).total,1);
 rows[id].claimStatus='CANCEL_DONE';service.invalidate();assert.equal((await service.list({...base,keyword:id},'adminA')).total,0);rows=copy(before);service.invalidate();
 const matches=await service.list({...base,sort:'matchedOnly'},'adminA');assert.equal(matches.total,1);assert.equal(matches.orders[0].productOrderId,id);
 const old=await service.list({startDate:'2026-01-01',endDate:'2026-01-01',pageSize:50},'adminA');assert.equal(old.total,2500);assert.equal(old.orders.length,50);assert(old.nextCursor);assert(!JSON.stringify(old).includes('doNotReturn'));
 const full=await service.list({pageSize:50},'adminA');assert.equal(full.total,2576);assert(full.metrics.queryCount<=6);assert.equal(full.orders.length,50);const fullNext=await service.list({pageSize:50,cursor:full.nextCursor},'adminA');assert.equal(new Set([...full.orders,...fullNext.orders].map(r=>r.id)).size,100);
 const all=await service.list({keyword:id},'adminA');assert.equal(all.total,1);assert.equal(all.metrics.documentsRead,1);assert.equal((await service.list({...base,keyword:'없는 이름'},'adminA')).total,0);
 const bad=await route('/stored/admin/naver-orders',{startDate:'2026-02-30'});assert.equal(bad.status,400);assert.equal((await route('/stored/admin/naver-orders',{sort:'unsupported'})).status,400);
 const countBefore=queries.length;service.invalidate();await Promise.all([service.list({...base,fresh:'1'},'adminA'),service.list({...base,fresh:'1'},'adminA')]);const count=queries.length-countBefore;assert.equal(count,14);const afterCached=queries.length;await service.list(base,'adminA');assert.equal(queries.length,afterCached+5);await service.list(base,'adminB');assert(queries.length>afterCached);
 fail=true;const failed=await route('/stored/admin/naver-orders',{keyword:id,fresh:'1'});assert.equal(failed.status,500);assert.equal(failed.body.ok,false);fail=false;assert.equal((await route('/stored/admin/naver-orders',{keyword:id,fresh:'1'})).body.total,1);
 assert.deepEqual(rows,before);
 const deferred=register(app,{requireFirebaseAdmin:guard,admin:{firestore},initFirebaseAdmin:()=>{},settleMs:0});let release;readGate=new Promise(resolve=>{release=resolve;});
 const pending=await route('/stored/admin/naver-orders',{...base,async:'1',fresh:'1'});assert.equal(pending.status,202);assert.equal(pending.body.pending,true);const jobId=pending.body.jobId;
 assert.equal((await route('/stored/admin/naver-orders',{...base,async:'1',fresh:'1'})).body.jobId,jobId);
 assert.equal((await route('/stored/admin/naver-orders',{...base,async:'1',jobId},'other@example.test')).status,403);
 assert.equal((await route('/stored/admin/naver-orders',{...base,keyword:'changed',async:'1',jobId})).status,409);
 readGate=null;release();await new Promise(resolve=>setImmediate(resolve));
 const ready=await route('/stored/admin/naver-orders',{...base,async:'1',jobId});assert.equal(ready.status,200);assert.equal(ready.body.total,76);const afterReady=reads;
 assert.equal((await route('/stored/admin/naver-orders',{...base,async:'1',jobId})).status,200);assert.equal(reads,afterReady);deferred.invalidate();assert.equal((await route('/stored/admin/naver-orders',{...base,async:'1',jobId})).status,409);
 fail=8;deferred.invalidate();const quota=await route('/stored/admin/naver-orders',{keyword:id,fresh:'1'});assert.equal(quota.status,503);assert(quota.body.message.includes('할당량'));const readsAfterQuota=reads;fail=false;assert.equal((await route('/stored/admin/naver-orders',{keyword:id,fresh:'1'})).status,503);assert.equal(reads,readsAfterQuota);const runtime=await route('/stored/admin/naver-orders/diagnostic',{runtime:'1'});assert.equal(runtime.status,200);assert(runtime.body.quotaRetryAfterSeconds>0);assert.equal(reads,readsAfterQuota);
 assert.deepEqual(rows,before);console.log('PASS quota handling: explicit503, bounded circuit prevents repeated DB reads, authenticated diagnostics require no DB read');
 assert.deepEqual(rows,before);console.log('PASS async read job: immediate pending, shared job/no repeated scans, owner/condition/revision guards, exact ready result, zero business writes');
 console.log('PASS actual stored-order read module: beyond2000 exact item/parent/estimate, NFC/NFD, KST boundaries, date-before-read, all-period exact lookup, stable50-page boundary, matched/claim filters, no raw payload, exact counts, auth gate/no-store, invalid cursors, single-flight/user cache isolation, DB failure/retry; zero writes and existing matching/payment units preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
