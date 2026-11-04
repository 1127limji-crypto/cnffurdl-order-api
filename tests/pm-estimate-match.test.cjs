const assert=require('node:assert/strict'),register=require('../pm-estimate-match.cjs');
let data,writeCount,failCommit=false,readFailure=false;const pid='9000000000000001',parent='9000000000000000',no='991104-000001';
const clone=x=>JSON.parse(JSON.stringify(x));const snap=(id,value)=>({id,exists:value!==undefined,data:()=>clone(value)});
class Query{constructor(name,filters=[],limit=Infinity){this.name=name;this.filters=filters;this.n=limit;}where(k,op,v){return new Query(this.name,[...this.filters,[k,v]],this.n);}limit(n){return new Query(this.name,this.filters,n);}select(){return this;}doc(id){return {name:this.name,id,get:async()=>snap(id,data[this.name]?.[id])};}async get(){const docs=Object.entries(data[this.name]||{}).filter(([id,v])=>this.filters.every(([k,value])=>v[k]===value)).slice(0,this.n).map(([id,v])=>snap(id,v));return {docs,empty:!docs.length};}}
const firestore=()=>({collection:name=>new Query(name),runTransaction:async fn=>{const pending=[];const tx={get:ref=>ref.get(),set:(ref,value)=>pending.push([ref,value])};const answer=await fn(tx);if(failCommit)throw Error('isolated commit failure');for(const [ref,v] of pending){data[ref.name]||={};data[ref.name][ref.id]={...data[ref.name][ref.id],...clone(v)};writeCount++;}return answer;}});firestore.FieldValue={serverTimestamp:()=> '2026-11-04T00:00:00Z'};
let order;function reset(){failCommit=false;readFailure=false;writeCount=0;data={estimates:{e:{estimateNo:no,customerName:'격리 QA',totalPrice:230400,orderStatus:'UNPAID',finalQty:320,needSheets:32,paperName:'preserve',coatingText:'preserve',custom:{immutable:true}}},naverOrders:Object.fromEntries(Array.from({length:10},(_,i)=>['other'+i,{id:'other'+i,keep:i}]))};order={productOrderId:pid,orderNo:parent,amount:230400,productOrderStatus:'PAYED',paymentDate:'2026-11-04T00:00:00Z',optionInfo:'견적번호 '+no,quantity:2304};}
const routes=new Map(),app={get:(p,...f)=>routes.set('GET '+p,f.at(-1)),post:(p,...f)=>routes.set('POST '+p,f.at(-1))};let invalidations=0;const service=register(app,{requireFirebaseAdmin:()=>{},admin:{firestore},initFirebaseAdmin:()=>{},readNaver:async ids=>{assert.deepEqual(ids,[pid]);if(readFailure)throw Error('isolated upstream failure');return [clone(order)];},invalidate:()=>invalidations++});
const input=()=>({estimateNo:no,productOrderId:pid,orderNo:parent,amount:230400,mode:'automatic',actor:'isolated QA'});
(async()=>{reset();const before=clone(data),result=await service.reconcile(input());assert.equal(result.orderStatus,'PAID');assert.equal(data.estimates.e.matchedNaverProductOrderId,pid);assert.equal(data.naverOrders[pid].matchedEstimateId,'e');assert.equal(data.estimates.e.finalQty,320);assert.equal(data.estimates.e.needSheets,32);assert.deepEqual(data.estimates.e.custom,before.estimates.e.custom);assert.equal(data.naverOrders[pid].quantity,2304);for(const [id,v] of Object.entries(before.naverOrders))assert.deepEqual(data.naverOrders[id],v);const writes=writeCount;assert.equal((await service.reconcile(input())).alreadyMatched,true);assert.equal(writeCount,writes);assert.equal(Object.keys(data.pmEstimateMatchReceipts).length,1);assert.equal(invalidations,2);
for(const [name,change,code] of [
 ['duplicate',()=>data.estimates.other={...data.estimates.e},'AMBIGUOUS_ESTIMATE_NUMBER'],
 ['existing estimate link',()=>data.estimates.e.matchedNaverProductOrderId='9000000000000002','MATCH_CONFLICT'],
 ['existing order link',()=>data.naverOrders[pid]={matchedEstimateId:'different'},'MATCH_CONFLICT'],
 ['quote amount',()=>data.estimates.e.totalPrice=1,'ESTIMATE_AMOUNT_MISMATCH'],
 ['order amount',()=>order.amount=1,'ORDER_AMOUNT_MISMATCH'],
 ['unpaid',()=>{order.productOrderStatus='PAYMENT_WAITING';order.paymentDate=null;},'ORDER_NOT_PAID'],
 ['cancelled',()=>order.productOrderStatus='CANCELED','ORDER_NOT_PAID'],
 ['claim',()=>order.claimStatus='CANCEL_REQUEST','ORDER_HAS_CLAIM'],
 ['quote cancelled',()=>data.estimates.e.orderStatus='CANCELED','ESTIMATE_STATE_CONFLICT'],
 ['option conflict',()=>order.optionInfo='991104-000002','OPTION_ESTIMATE_CONFLICT'],
 ['multiple refs',()=>order.optionInfo=no+' / 991104-000002','AMBIGUOUS_OPTION_ESTIMATES'],
 ['parent conflict',()=>order.orderNo='9000000000000002','PARENT_ORDER_CONFLICT']
]){reset();change();const original=clone(data);await assert.rejects(service.reconcile(input()),e=>e.code===code,name);assert.deepEqual(data,original,name+' must not write');}
reset();failCommit=true;const original=clone(data);await assert.rejects(service.reconcile(input()),/commit failure/);assert.deepEqual(data,original);reset();readFailure=true;const sourceBefore=clone(data);await assert.rejects(service.reconcile(input()),/upstream failure/);assert.deepEqual(data,sourceBefore);
reset();data.estimates.e.orderStatus='SHIPPED';assert.equal((await service.reconcile(input())).orderStatus,'SHIPPED');assert.equal(data.estimates.e.orderStatus,'SHIPPED');
assert.deepEqual(register.refs('번호 ９９１１０４－０００００１ / '+no),[no]);
console.log('PASS atomic source pair, explicit option/duplicate/conflict/amount/payment/claim checks; retry idempotence; other10 records and320 sheets/32 plates preserved; source read/commit failures never partially match; shipped state preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
