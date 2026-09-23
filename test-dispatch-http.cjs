const assert=require('node:assert/strict');
const express=require('express');
const register=require('./register-epost-dispatch.cjs');
const {createDispatch}=require('./epost-dispatch.cjs');
(async()=>{
 const old=process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY;process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY='unit-test-only';
 let scopes=['mall.read_order'],reads=0,writes=0,resolveRead;
 const rows=[{order:{orderId:'ORDER'},productOrder:{productOrderId:'ITEM',productOrderStatus:'PAYED',placeOrderStatus:'OK'}}];
 const app=express();app.use(express.json());
 register(app,{safeSecretEqual:(a,b)=>Boolean(a)&&a===b,getProductOrderDetailsByIds:async()=>{reads++;if(resolveRead===null)await new Promise(r=>resolveRead=r);return rows;},getNaverAccessToken:async()=>{writes++;throw Error('no live API');},cafe24LoadTokenState:async()=>({meta:{scopes}}),cafe24ApiGet:async(path)=>({json:path.endsWith('/carriers')?{carriers:[{carrier_id:7,shipping_carrier:'우체국택배',shipping_carrier_code:'0006'}]}:{items:[{order_item_code:'ITEM',order_status:'N30',tracking_no:'1234567890123',shipping_company_code:'0006'}]}})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const input={channel:'naver',orderId:'ORDER',itemIds:['ITEM'],trackingNo:'1234567890123',dispatchedAt:new Date().toISOString(),checkOnly:true};
 const call=(path,body,key='unit-test-only')=>fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-internal-key':key},body:body?JSON.stringify(body):undefined});
 try{
  assert.equal((await call('/shipping/epost/capabilities',null,'')).status,401);
  assert.equal((await call('/shipping/epost/dispatch',input,'wrong')).status,401);assert.equal(reads,0);
  let j=await(await call('/shipping/epost/capabilities')).json();assert.equal(j.cafe24,false);
  assert.equal((await call('/shipping/epost/dispatch',{...input,channel:'cafe24'})).status,409);
  assert.equal((await call('/shipping/epost/dispatch',{})).status,409);
  scopes.push('mall.read_shipping','mall.write_order');
  j=await(await call('/shipping/epost/dispatch',{...input,channel:'cafe24'})).json();assert.deepEqual(j.sentItemIds,['ITEM']);
  resolveRead=null;const first=call('/shipping/epost/dispatch',input);
  while(resolveRead===null)await new Promise(r=>setTimeout(r,1));
  assert.equal((await call('/shipping/epost/dispatch',input)).status,409);resolveRead();await first;
  assert.equal(writes,0);
 }finally{server.close();if(old===undefined)delete process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY;else process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY=old;}
 let dispatched=0;const run=createDispatch({naverRead:async()=>rows,naverWrite:async()=>{dispatched++;throw Error('TIMEOUT');}});
 await assert.rejects(run({...input,checkOnly:false}));assert.equal(dispatched,1);
 await run(input);assert.equal(dispatched,1);
 rows[0].productOrder.claimStatus='CANCEL_REQUEST';await assert.rejects(run(input),/ORDER_CONFLICT/);
 rows[0].productOrder.claimStatus=null;rows[0].order.orderId='WRONG';await assert.rejects(run(input),/ORDER_CONFLICT/);
 await assert.rejects(run({...input,checkOnly:'false'}),/INVALID_DISPATCH/);
 console.log('PASS: HTTP auth, permission gates, official carrier mapping, concurrency guard, check-only no writes, timeout no automatic retry, claims/order mismatch.');
})().catch(e=>{console.error(e);process.exitCode=1});
