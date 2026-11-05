'use strict';
const assert=require('node:assert/strict'),register=require('../pm-stored-orders.cjs');
const routes=new Map(),guard=()=>{},calls=[];
const service=register({get:(path,middleware,handler)=>{assert.equal(middleware,guard);routes.set(path,handler)}},{requireFirebaseAdmin:guard,indexRequest:async input=>{calls.push(input);return {ok:true,orders:[{id:'fixture'}],total:1,metrics:{documentsRead:0}};}});
const res=()=>({code:200,status(n){this.code=n;return this},set(k,v){assert.equal(k,'Cache-Control');assert.equal(v,'private, no-store');return this},json(v){this.body=v;return this}});
(async()=>{
 const r=res();await routes.get('/stored/admin/naver-orders')({query:{keyword:'가',cursor:'signed'},adminUser:{email:'isolated@test'}},r);assert.equal(r.code,200);assert.equal(r.body.total,1);assert.equal(calls.length,1);assert.equal(calls[0].actor,'isolated@test');assert.equal(calls[0].query.cursor,'signed');service.invalidate();assert.equal(calls.length,1);
 const failed=new Map();register({get:(path,middleware,handler)=>failed.set(path,handler)},{requireFirebaseAdmin:guard,indexRequest:async()=>{throw Object.assign(Error('INDEX_BOOTSTRAP_REQUIRED'),{status:503});}});const out=res();await failed.get('/stored/admin/naver-orders')({query:{},adminUser:{email:'fixture'}},out);assert.equal(out.code,503);assert.equal(out.body.retryable,false);assert.equal(out.body.operation,'read');assert.ok(!('orders' in out.body));console.log('PASS stored routes: existing auth, actor/cursor forwarding, zero source reads, no retry/poll/preview, explicit503 without false empty success');
})().catch(e=>{console.error(e);process.exitCode=1});
