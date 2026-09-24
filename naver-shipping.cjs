const sentStates=['DELIVERING','DELIVERED','PURCHASE_DECIDED'];
const value=v=>String(v??'').trim();
function normalize(row){
 const r=row.productOrderInfo||row,p=r.productOrder||{},d=r.delivery||{},a=p.shippingAddress||r.shippingAddress||{};
 return {orderId:value(r.order?.orderId),productOrderId:value(p.productOrderId||r.productOrderId),status:p.productOrderStatus,placeOrderStatus:p.placeOrderStatus,quantity:Number(p.remainQuantity??p.quantity),initialQuantity:Number(p.initialQuantity??p.quantity),claimStatus:value(p.claimStatus),claimType:value(p.claimType),productName:value(p.productName),option:value(p.productOption),packageNumber:value(p.packageNumber),deliveryMethod:value(p.expectedDeliveryMethod),recipient:{name:value(a.name),phone:value(a.tel1||a.tel2),zip:value(a.zipCode),address1:value(a.baseAddress),address2:value(a.detailedAddress),memo:value(p.shippingMemo)},trackingNo:value(d.trackingNumber),deliveryCompany:value(d.deliveryCompany),dispatchDate:value(d.sendDate)};
}
function inspect(rows,orderId,ids,trackingNo){
 const normalized=rows.map(normalize),pending=[],sent=[];
 for(const id of ids){
  const matches=normalized.filter(r=>r.productOrderId===id);if(matches.length!==1)throw Error('ORDER_CONFLICT');const r=matches[0];
  if(r.orderId!==String(orderId)||r.claimStatus||r.claimType)throw Error('ORDER_CONFLICT');
  if(sentStates.includes(r.status)){
   if(r.trackingNo!==trackingNo||r.deliveryCompany!=='EPOST')throw Error('TRACKING_CONFLICT');sent.push(id);
  }else if(r.status==='PAYED'&&r.placeOrderStatus==='OK'&&!r.trackingNo&&!r.dispatchDate&&(!r.deliveryMethod||['DELIVERY','GDFW_ISSUE_SVC'].includes(r.deliveryMethod)))pending.push(id);
  else throw Error('ORDER_NOT_DISPATCHABLE');
 }
 return {sentItemIds:sent,pendingItemIds:pending};
}
module.exports={normalize,inspect,sentStates};
