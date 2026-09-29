const assert=require('node:assert/strict');
const {createManualShipping,naverCarriers}=require('./manual-shipping.cjs');
(async()=>{
 const orderId='202609290000001',ids=['2026092900000011','2026092900000012'];
 const rows=ids.map(productOrderId=>({order:{orderId},productOrder:{productOrderId,productName:'Mock product',productOrderStatus:'PAYED',placeOrderStatus:'OK',quantity:2,expectedDeliveryMethod:'DELIVERY',packageNumber:'same',shippingAddress:{name:'mock',tel1:'01000000000',zipCode:'12345',baseAddress:'mock address'}}}));
 let writes=0,body,mode='partial';
 const api=createManualShipping({naverRead:async()=>structuredClone(rows),naverWrite:async b=>{body=b;writes++;const selected=b.dispatchProductOrders.slice(0,mode==='partial'?1:30);for(const p of selected){const r=rows.find(r=>r.productOrder.productOrderId===p.productOrderId);r.productOrder.productOrderStatus='DELIVERING';r.delivery={trackingNumber:p.trackingNumber,deliveryCompany:p.deliveryCompanyCode};}return {data:{successProductOrderIds:selected.map(p=>p.productOrderId),failProductOrderInfos:b.dispatchProductOrders.slice(selected.length).map(p=>({productOrderId:p.productOrderId,code:'ERR_TEMP'}))}};}});
 const preview=await api.preview({channel:'naver',orderId,itemIds:ids});assert.equal(writes,0);assert.equal(preview.carriers.find(c=>c.id==='EPOST').name,'우체국택배');assert.equal(new Set(naverCarriers.map(c=>c.id)).size,naverCarriers.length);
 const input={channel:'naver',orderId,itemIds:ids,trackingNo:'123456789012',carrierId:'CJGLS',expected:Object.fromEntries(preview.items.map(i=>[i.id,i.fingerprint])),checkOnly:false,dispatchedAt:new Date().toISOString()};
 let result=await api.dispatch(input);assert.equal(result.verified.length,1);assert.equal(result.pendingItemIds.length,1);assert.equal(body.dispatchProductOrders[0].deliveryCompanyCode,'CJGLS');assert.equal(result.reportedFailures[0].code,'ERR_TEMP');
 mode='success';result=await api.dispatch(input);assert.equal(body.dispatchProductOrders.length,1);assert.equal(result.verified.length,2);await api.dispatch(input);assert.equal(writes,2);
 await assert.rejects(api.dispatch({...input,trackingNo:'999999999999',carrierId:'INVALID'}),/CARRIER_NOT_SUPPORTED/);
 result=await api.dispatch({...input,trackingNo:'999999999999'});assert.equal(result.excluded.length,2);assert.equal(writes,2);
 await assert.rejects(api.dispatch({...input,trackingNo:'0000000000000'}),/INVALID_DISPATCH/);
 console.log('PASS manual gateway: official carriers/product IDs, read-only preview, per-item partial failure, read-after-write, pending-only retry, no duplicate, conflicts and zero/test number guards. No live calls.');
})().catch(e=>{console.error(e);process.exitCode=1});
