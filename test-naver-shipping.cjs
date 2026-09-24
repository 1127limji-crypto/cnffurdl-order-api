const assert=require('node:assert/strict');
const {createDispatch}=require('./epost-dispatch.cjs');
const {normalize}=require('./naver-shipping.cjs');
const input={channel:'naver',orderId:'202609240000001',itemIds:['202609240000011'],trackingNo:'1234567890123',dispatchedAt:new Date().toISOString()};
function row(id=input.itemIds[0]){return {order:{orderId:input.orderId,accessToken:'never-export'},productOrder:{productOrderId:id,productOrderStatus:'PAYED',placeOrderStatus:'OK',quantity:3,remainQuantity:2,expectedDeliveryMethod:'DELIVERY',packageNumber:'P',shippingAddress:{name:'Fixture',tel1:'01000000000',zipCode:'00000',baseAddress:'test',detailedAddress:'test'}},delivery:{}};}
(async()=>{
 let rows=[row()],writes=0,last;
 const deps={naverRead:async()=>structuredClone(rows),naverWrite:async b=>{writes++;last=b;for(const i of b.dispatchProductOrders){const r=rows.find(r=>r.productOrder.productOrderId===i.productOrderId);r.productOrder.productOrderStatus='DELIVERING';r.delivery={trackingNumber:i.trackingNumber,deliveryCompany:i.deliveryCompanyCode};}return {data:{successProductOrderIds:input.itemIds,failProductOrderInfos:[]}};}};
 const run=createDispatch(deps);assert.equal(normalize(rows[0]).quantity,2);assert(!JSON.stringify(normalize(rows[0])).includes('never-export'));
 assert.deepEqual((await run({...input,checkOnly:true})).pendingItemIds,input.itemIds);assert.equal(writes,0);
 assert.deepEqual((await run(input)).sentItemIds,input.itemIds);assert.equal(writes,1);assert.equal(last.dispatchProductOrders[0].deliveryCompanyCode,'EPOST');assert.equal(last.dispatchProductOrders[0].deliveryMethod,'DELIVERY');
 await run(input);assert.equal(writes,1);
 await assert.rejects(run({...input,trackingNo:'9876543210123'}),/TRACKING_CONFLICT/);
 for(const trackingNo of ['0000000000000','TESTREGINOAPI'])await assert.rejects(run({...input,trackingNo}),/INVALID_DISPATCH/);
 for(const change of [{claimStatus:'RETURN_REQUEST'},{placeOrderStatus:'NOT_YET'},{productOrderStatus:'CANCELED'},{expectedDeliveryMethod:'VISIT_RECEIPT'}]){rows=[row()];Object.assign(rows[0].productOrder,change);await assert.rejects(run(input));assert.equal(writes,1);}
 rows=[row()];rows[0].order.orderId='another';await assert.rejects(run(input),/ORDER_CONFLICT/);
 rows=[row()];deps.naverWrite=async()=>{writes++;return {data:{successProductOrderIds:input.itemIds,failProductOrderInfos:[]}}};
 const uncertain=await run(input);assert.equal(uncertain.uncertain,true);assert.deepEqual(uncertain.sentItemIds,[]);
 deps.naverWrite=async()=>{writes++;throw Error('timeout')};await assert.rejects(run(input),/timeout/);const afterWrites=writes;await run({...input,checkOnly:true});assert.equal(writes,afterWrites);
 rows=[row(),row('202609240000012')];rows[0].productOrder.productOrderStatus='DELIVERING';rows[0].delivery={trackingNumber:input.trackingNo,deliveryCompany:'EPOST'};
 deps.naverWrite=async b=>{assert.deepEqual(b.dispatchProductOrders.map(x=>x.productOrderId),['202609240000012']);rows[1].productOrder.productOrderStatus='DELIVERING';rows[1].delivery={trackingNumber:input.trackingNo,deliveryCompany:'EPOST'};return {data:{successProductOrderIds:['202609240000012'],failProductOrderInfos:[]}};};assert.equal((await run({...input,itemIds:rows.map(r=>r.productOrder.productOrderId)})).sentItemIds.length,2);
 console.log('PASS Naver: auth-data whitelist, remaining quantity, official carrier/body, read-after-write, idempotence, claims/pickup/conflicts, timeout read-only check, partial pending-only dispatch');
})().catch(e=>{console.error(e);process.exitCode=1});
