import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openIndex,SOURCE_FIELDS,storedDay} from '../read-index-model.mjs';
const dir=mkdtempSync(join(tmpdir(),'firestore-isolated-')),path=join(dir,'isolated.sqlite');
let db=await openIndex(path);const states={};
function begin(kind){states[kind]={owner:'fixture-'+kind,sequence:0};db.mutate(kind,{action:'lease',owner:states[kind].owner,generation:'fixture-generation',bootstrap:true});}
function apply(kind,changes,extra={}){const s=states[kind];return db.mutate(kind,{action:'apply',owner:s.owner,sequence:++s.sequence,changes,documentsRead:changes.length,token:'fixture-token',readTime:'2026-11-05T01:00:00Z',current:true,...extra});}
try{
 assert.throws(()=>db.query('naverOrders',{}),/INDEX_BOOTSTRAP_REQUIRED/);
 begin('naverOrders');begin('estimates');
 let orders=[];for(let i=0;i<3860;i++){
  orders.push({id:String(2026110400000000n+BigInt(i)),data:{productOrderId:String(2026110400000000n+BigInt(i)),orderNo:String(2026110300000000n+BigInt(Math.floor(i/2))),buyerName:i===3859?'한글이름'.normalize('NFD'):'격리테스트'+i,productName:i===3859?'오래된 아크릴 마그넷':'격리 상품',paymentDate:i%2?'2026-11-04T15:01:00Z':'2026-11-04T14:59:00Z',amount:100,optionInfo:i===3859?'견적번호 261102-000002':'' ,quantity:1,claimStatus:i===7?'CANCEL_DONE':'',matchedEstimateNo:i===8?'261103-000001':'',receiverName:i%2?'나':'가',receiverTel1:'TEST',baseAddress:'ISOLATED',pdfBase64:'DO_NOT_COPY'}});
 }
 for(let n=0;n<orders.length;n+=50)apply('naverOrders',orders.slice(n,n+50));
 const seen=new Set();let cursor=null,pages=0;do{const r=db.query('naverOrders',{pageSize:'50',cursor,sort:'paymentDesc'},'a');assert.equal(r.metrics.firestoreDocumentsRead,0);assert.ok(r.orders.length<=50);assert.equal(r.total,3859);for(const row of r.orders){assert.ok(!seen.has(row.id));seen.add(row.id);assert.ok(!JSON.stringify(row).includes('DO_NOT_COPY'));assert.equal(row.receiverTel1,undefined);}pages++;cursor=r.nextCursor;}while(cursor);assert.equal(seen.size,3859);
 for(const keyword of ['한','글이','한글이름'.normalize('NFD'),'아크릴 마그','261102-000002',orders.at(-1).id,orders.at(-1).data.orderNo]){const r=db.query('naverOrders',{keyword},'a');assert.ok(r.orders.some(v=>v.id===orders.at(-1).id),keyword);assert.equal(r.metrics.documentsRead,0);}
 for(const sort of ['paymentDesc','paymentAsc','productOrderAsc','productOrderDesc','receiverGroup','matchedOnly']){const r=db.query('naverOrders',{sort},'a');assert.ok(r.orders.length>0);const next=r.nextCursor;if(next){const r2=db.query('naverOrders',{sort,cursor:next},'a');assert.ok(!r2.orders.some(v=>r.orders.some(x=>x.id===v.id)));assert.throws(()=>db.query('naverOrders',{sort,cursor:next},'other'),/CURSOR_CONDITION_CHANGED/);}}
 assert.throws(()=>db.query('naverOrders',{startDate:'2026-02-31'}),/INVALID_QUERY/);
 assert.equal(db.query('naverOrders',{startDate:'2026-11-04',endDate:'2026-11-04'}).total,1930);
 assert.equal(storedDay({paymentDate:'2026-11-04T15:00:00Z'}),'2026-11-05');
 assert.equal(storedDay({paymentDateYmd:'2020-01-02'}),'2020-01-02');
 assert.equal(storedDay({createdAtIso:'2020-01-02T00:00:00+09:00'}),'2020-01-02');
 let estimates=Array.from({length:107},(_,i)=>({id:'fixture-'+String(i).padStart(4,'0'),data:{estimateNo:'261105-'+String(i).padStart(6,'0'),customerName:i%2?'김가':'홍나',createdAt:'2026-11-05T01:00:00Z',totalPrice:i,orderStatus:i%3===0?'PAID':'UNPAID',paperName:'테스트',designOptions:[{designName:'D',options:{circlePunch:true,circlePunchCount:2,pdfBase64:'DO_NOT_COPY'},pdfBase64:'DO_NOT_COPY'}]}}));
 for(let n=0;n<estimates.length;n+=50)apply('estimates',estimates.slice(n,n+50));
 const counts=db.query('estimates',{countsOnly:'1'});assert.deepEqual(counts.estimates,[]);assert.deepEqual(counts.counts,{all:107,paidConfirmed:36});assert.equal(counts.totalAmount,5671);
 for(const sort of ['dateDesc','dateAsc','amountAsc','amountDesc','customerAsc','statusAsc']){const a=db.query('estimates',{sort,page:'1'}),b=db.query('estimates',{sort,page:'2'}),c=db.query('estimates',{sort,page:'3'});assert.equal(new Set([...a.estimates,...b.estimates,...c.estimates].map(x=>x.id)).size,107);assert.ok(!JSON.stringify(a).includes('DO_NOT_COPY'));}
 assert.equal(db.query('estimates',{keyword:'261105-000106'}).total,1);
 const before=db.query('estimates',{}).totalAmount;apply('estimates',[{...estimates[0],data:{...estimates[0].data,totalPrice:42,orderStatus:'SHIPPED'}}]);assert.equal(db.query('estimates',{}).totalAmount,before+42);assert.equal(db.query('estimates',{}).counts.paidConfirmed,36);
 const seq=states.estimates.sequence;assert.equal(db.mutate('estimates',{action:'apply',owner:states.estimates.owner,sequence:seq,changes:[{id:estimates[0].id,deleted:true}]}).duplicate,true);assert.equal(db.query('estimates',{}).total,107);
 apply('estimates',[{id:estimates[0].id,deleted:true}]);assert.equal(db.query('estimates',{}).total,106);assert.equal(db.query('estimates',{keyword:'261105-000000'}).total,0);
 db.mutate('naverOrders',{action:'error',owner:states.naverOrders.owner,error:'FIRESTORE_QUOTA'});const stale=db.query('naverOrders',{});assert.equal(stale.stale,true);assert.equal(stale.refreshError,'FIRESTORE_QUOTA');assert.equal(stale.total,3859);
 const metric=[];for(const name of ['first','search','next','revisit','concurrent-1','concurrent-2','concurrent-3']){const r=db.query('naverOrders',name==='search'?{keyword:'아크릴'}:{} ,name.startsWith('concurrent')?name:'one');metric.push({scenario:name,...r.metrics,total:r.total});}
 db.close();db=await openIndex(path);assert.equal(db.query('naverOrders',{}).total,3859);assert.equal(db.state('naverOrders').token,'fixture-token');
 console.log(JSON.stringify({pass:true,fixtureDocuments:3967,pages,scenarios:metric,queryPlan:db.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM search_grams WHERE kind=? AND gram=?").all('naverOrders','아크릴')},null,2));
}finally{db.close();rmSync(dir,{recursive:true,force:true});}
