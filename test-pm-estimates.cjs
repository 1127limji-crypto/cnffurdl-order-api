'use strict';
const assert=require('node:assert/strict'),register=require('./pm-estimates.cjs');
let writes=0,reads=0,indexCalls=0;const target={orderStatus:'UNPAID'},routes={};
const db={collection(){return {doc(id){return {id,get:async()=>({id,exists:id==='fixture',data:()=>target})}}}},async runTransaction(fn){return fn({get:async ref=>{reads++;return ref.get()},update(ref,values){writes++;Object.assign(target,values)}})}};
const guard=()=>{};register({post(){},get:(p,g,h)=>{assert.equal(g,guard);routes['GET '+p]=h},patch:(p,g,h)=>{assert.equal(g,guard);routes['PATCH '+p]=h}},{requireFirebaseAdmin:guard,initFirebaseAdmin(){},admin:{firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=>new Date()}})},indexRequest:async input=>{indexCalls++;assert.equal(input.kind,'estimates');return {ok:true,estimates:[],counts:{all:107,paidConfirmed:36},total:107,metrics:{documentsRead:0}};}});
const response=()=>({code:200,status(n){this.code=n;return this},set(){return this},json(v){this.body=v;return this}});
(async()=>{
 const list=response();await routes['GET /stored/production-manager/estimates']({query:{countsOnly:'1'},adminUser:{email:'fixture@test'}},list);assert.equal(reads,0);assert.equal(indexCalls,1);assert.equal(list.body.counts.all,107);
 const route=routes['PATCH /stored/production-manager/estimates/:id/confirm'];for(let n=0;n<2;n++){const r=response();await route({params:{id:'fixture'},adminUser:{email:'fixture@test'}},r);assert.equal(r.body.orderStatus,'CONFIRMED');assert.equal(r.body.alreadyConfirmed,n>0);}assert.equal(writes,1);
 target.orderStatus='PAID';const r=response();await route({params:{id:'fixture'},adminUser:{email:'fixture@test'}},r);assert.equal(r.body.orderStatus,'PAID');assert.equal(writes,1);
 const missing=response();await route({params:{id:'missing'},adminUser:{email:'fixture@test'}},missing);assert.equal(missing.code,404);assert.equal(writes,1);console.log('PASS estimates proxy counts zero source reads; original confirmation idempotence, paid preservation and missing-source guard');
})().catch(e=>{console.error(e);process.exitCode=1});
