const assert=require('node:assert/strict');const {createDispatch}=require('./epost-dispatch.cjs');
(async()=>{
let writes=0,body;
const deps={naverRead:async()=>[{order:{orderId:'O'},productOrder:{productOrderId:'A',productOrderStatus:'PAYED',placeOrderStatus:'OK'}}],naverWrite:async b=>{writes++;body=b;return {data:{successProductOrderIds:['A'],failProductOrderInfos:[]}}}};
const input={channel:'naver',orderId:'O',itemIds:['A'],trackingNo:'1234567890123',dispatchedAt:new Date().toISOString()};
const run=createDispatch(deps);await run({...input,checkOnly:true});assert.equal(writes,0);await run(input);assert.equal(writes,1);assert.equal(body.dispatchProductOrders[0].deliveryCompanyCode,'EPOST');
deps.naverRead=async()=>[{order:{orderId:'O'},productOrder:{productOrderId:'A',productOrderStatus:'DELIVERING'},delivery:{trackingNumber:input.trackingNo,deliveryCompany:'EPOST'}}];await run(input);assert.equal(writes,1);
await assert.rejects(run({...input,trackingNo:'TESTREGINOAPI'}));
let cafeRows=[{order_item_code:'A',order_status:'N20'},{order_item_code:'B',order_status:'N20'}];
deps.cafeRead=async()=>cafeRows;deps.cafeCarrier=async()=>({carrier_id:7,shipping_company_code:'fixture'});deps.cafeWrite=async(id,b)=>{body=b;cafeRows[0]={...cafeRows[0],order_status:'N30',tracking_no:input.trackingNo,shipping_company_code:'fixture'};return {shipments:[{shipping_code:'S',order_id:id,tracking_no:input.trackingNo}]}};
const r=await run({...input,channel:'cafe24'});assert.deepEqual(body.request.order_item_code,['A']);assert.equal(cafeRows[1].order_status,'N20');assert.deepEqual(r.sentItemIds,['A']);
console.log('PASS: selected items only, EPOST carrier, read-only reconciliation, no repeat dispatch, test labels rejected, partial Cafe24 preserved.');
})().catch(e=>{console.error(e);process.exitCode=1});
