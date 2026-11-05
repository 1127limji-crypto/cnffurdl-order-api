'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),express=require('express');
const createCache=require('./cafe24-token-cache.cjs'),range=require('./cafe24-range.cjs');
test('explicit probe reads despite TTL/cooldown and cannot succeed from stale fallback',async()=>{
 let reads=0;const cache=createCache();cache.put('fixture',{state:'old'});
 await assert.rejects(cache.get('fixture',async()=>{reads++;throw {code:8};},{probe:true}),{code:'CAFE24_TOKEN_STORE_QUOTA'});
 assert.equal(reads,1);
 assert.deepEqual(await cache.get('fixture',async()=>{reads++;return {state:'new'};},{probe:true}),{state:'new'});assert.equal(reads,2);
});
test('recovery is authenticated POST, explicit, one document, no token/OAuth exposure',async()=>{
 const app=express();app.use(express.json());let reads=0;
 require('./cafe24-token-recovery.cjs')(app,{requireFirebaseAdmin:(q,r,next)=>q.headers['x-fixture-admin']==='yes'?next():r.sendStatus(401),loadTokenState:async({probe})=>{assert.equal(probe,true);reads++;return {token:'MUST_NEVER_LEAVE_SERVER'};},readMetrics:{manualQuotaProbe:fn=>fn()}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/cafe24/token-store/recover`;
 try{
  assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal(reads,0);
  const headers={'x-fixture-admin':'yes','content-type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,400);assert.equal(reads,0);
  let r=await fetch(url,{method:'POST',headers,body:'{"singleDocumentProbe":true}'}),j=await r.json();assert.equal(r.status,200);assert.equal(j.sourceDocumentsRead,1);assert.equal(j.tokenExposed,false);assert.equal(j.oauthCalled,false);assert.ok(!JSON.stringify(j).includes('MUST_NEVER'));
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"singleDocumentProbe":true}'})).status,409);assert.equal(reads,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('timestamp recovery is bounded and exact; failures survive proxy interception without remote text',async()=>{
 assert.ok(range('2026-11-05T11:36:49+09:00','2026-11-05T17:20:00+09:00'));
 for(const [a,b] of [['2026-11-05','2026-11-05T17:00:00+09:00'],['2026-11-05T24:00:00+09:00','2026-11-06T01:00:00+09:00'],['2026-11-05T12:00:00+09:00','2026-11-05T11:00:00+09:00'],['2026-11-01','2026-11-20']])assert.equal(range(a,b),false);
 let status,body;const res={status(n){status=n;return this;},set(){return this;},json(j){body=j;return this;}};
 require('./cafe24-failure.cjs')(res,{code:'CAFE24_TOKEN_STORE_QUOTA',httpStatus:503,message:'PRIVATE REMOTE BODY'},'analytics-orders');
 assert.equal(status,424);assert.equal(body.sourceStatus,503);assert.equal(body.stage,'token_store');assert.equal(body.retryable,false);assert.ok(!JSON.stringify(body).includes('PRIVATE'));
});
