const {inspect}=require('./naver-shipping.cjs');
// Official Naver dispatch + Cafe24 shipments. No automatic mutation retries.
function createDispatch(deps){
 return async function dispatch(input){
  const {channel,orderId,itemIds,trackingNo,dispatchedAt,checkOnly}=input||{};
  if(checkOnly!==undefined&&typeof checkOnly!=='boolean')throw new Error('INVALID_DISPATCH');
  if(!['naver','cafe24'].includes(channel)||!Array.isArray(itemIds)||!itemIds.length||itemIds.length>30||new Set(itemIds).size!==itemIds.length||itemIds.some(i=>!/^[a-zA-Z0-9_-]{1,60}$/.test(i))||!/^\d{13}$/.test(trackingNo)||/^0+$/.test(trackingNo)||!dispatchedAt||!Number.isFinite(Date.parse(dispatchedAt))||Date.parse(dispatchedAt)>Date.now()+60000)throw new Error('INVALID_DISPATCH');
  if(channel==='naver'){
   const before=inspect(await deps.naverRead(itemIds),orderId,itemIds,trackingNo),pending=before.pendingItemIds;
   if(checkOnly||!pending.length)return before;
   const r=await deps.naverWrite({dispatchProductOrders:pending.map(productOrderId=>({productOrderId,deliveryMethod:'DELIVERY',deliveryCompanyCode:'EPOST',trackingNumber:trackingNo,dispatchDate:dispatchedAt}))});
   const success=r.data?.successProductOrderIds,fail=r.data?.failProductOrderInfos;
   if(!Array.isArray(success)||!Array.isArray(fail))throw new Error('DISPATCH_RESULT_UNKNOWN');
   // Never treat a 200 or success array alone as proof of the applied carrier and number.
   const after=inspect(await deps.naverRead(itemIds),orderId,itemIds,trackingNo);
   const failedIds=new Set(fail.map(x=>String(x.productOrderId)));
   return {...after,failed:after.pendingItemIds.length>0,uncertain:after.pendingItemIds.some(id=>!failedIds.has(id)),failedCodes:fail.filter(x=>pending.includes(String(x.productOrderId))).map(x=>({itemId:String(x.productOrderId),code:/^[A-Za-z0-9_.-]{1,60}$/.test(String(x.code||''))?String(x.code):'DISPATCH_FAILED'}))};
  }
  if(!/^[\w-]{1,60}$/.test(orderId||''))throw new Error('INVALID_ORDER');
  const rows=await deps.cafeRead(orderId),found=new Map(rows.map(i=>[i.order_item_code,i]));
  const sent=[],pending=[];
  const carrier=await deps.cafeCarrier();
  if(!carrier?.shipping_company_code||!carrier?.carrier_id)throw new Error('EPOST_CARRIER_NOT_CONFIGURED');
  for(const id of itemIds){const i=found.get(id);if(!i||Number(i.claim_quantity||0)>0)throw new Error('ORDER_CONFLICT');
   if(['N30','N40','N50'].includes(i.order_status)){
    if(i.tracking_no!==trackingNo||String(i.shipping_company_code)!==String(carrier.shipping_company_code))throw new Error('TRACKING_CONFLICT');sent.push(id);
   }else if(['N10','N20','N21','N22'].includes(i.order_status))pending.push(id);else throw new Error('ORDER_NOT_DISPATCHABLE');
  }
  if(checkOnly||!pending.length)return {sentItemIds:sent,pendingItemIds:pending};
  // Partial quantities inside one product-order are deliberately unsupported.
  const r=await deps.cafeWrite(orderId,{shop_no:1,request:{tracking_no:trackingNo,shipping_company_code:carrier.shipping_company_code,carrier_id:carrier.carrier_id,order_item_code:pending,status:'shipping'}});
  // Official response uses shipments (example: array; schema also permits object).
  const shipments=Array.isArray(r.shipments)?r.shipments:[r.shipments];
  if(!shipments.some(s=>s?.shipping_code&&s.order_id===orderId&&s.tracking_no===trackingNo))throw new Error('DISPATCH_RESULT_UNKNOWN');
  // Return only authoritative read-after-write results; a missing update is uncertain.
  const after=await deps.cafeRead(orderId);
  const accepted=after.filter(i=>pending.includes(i.order_item_code)&&['N30','N40','N50'].includes(i.order_status)&&i.tracking_no===trackingNo&&String(i.shipping_company_code)===String(carrier.shipping_company_code)).map(i=>i.order_item_code);
  return {sentItemIds:[...sent,...accepted],pendingItemIds:pending.filter(id=>!accepted.includes(id)),uncertain:accepted.length!==pending.length};
 };
}
module.exports={createDispatch};
