const {createHash}=require('node:crypto');
const {normalize:naverRow,sentStates}=require('./naver-shipping.cjs');
// NAVER Commerce API 2.89.0, seller/product-orders/dispatch, deliveryCompanyCode.
const naverCarriers=require('./manual-naver-carriers.json').filter(c=>c.id!=='UNKNOWN');
const text=v=>String(v??'').trim();
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function stamp(r){return digest([r.id,r.quantity,r.name,r.option,r.group,r.recipient]);}
function cafeItems(remote){
 return remote.items.map(r=>{
  const matches=remote.receivers.filter(x=>x.shipping_code===r.shipping_code),a=matches[0]||{};
  const state={N10:'PAYED',N20:'PAYED',N21:'PAYED',N22:'PAYED',N30:'DELIVERING',N40:'DELIVERED',N50:'PURCHASE_DECIDED'}[r.order_status]||r.order_status;
  const row={id:text(r.order_item_code),name:text(r.product_name),option:typeof r.option_value==='string'?r.option_value:JSON.stringify(r.option_value||''),quantity:Number(r.quantity),state,trackingNo:text(r.tracking_no),carrierCode:text(r.shipping_company_code),group:text(r.shipping_code),recipient:{name:text(a.name),phone:text(a.cellphone||a.phone),zip:text(a.zipcode),address1:text(a.address1||a.address_full),address2:text(a.address2)}};
  row.reason=remote.order.paid!=='T'||remote.order.canceled!=='F'?'ORDER_NOT_DISPATCHABLE':text(r.claim_code)||Number(r.claim_quantity||0)!==0?'CLAIM_ACTIVE':!['PAYED',...sentStates].includes(state)?'ORDER_NOT_DISPATCHABLE':r.store_pickup&&r.store_pickup!=='F'?'DELIVERY_METHOD_UNSUPPORTED':matches.length!==1||!row.group?'RECIPIENT_REVIEW':null;
  if(state==='PAYED'&&r.shipped_date)row.reason='ORDER_NOT_DISPATCHABLE';
  return row;
 });
}
function naverItems(rows,orderId){return rows.map(raw=>{
 const r=naverRow(raw),row={id:r.productOrderId,name:r.productName,option:r.option,quantity:r.quantity,state:r.status,trackingNo:r.trackingNo,carrierCode:r.deliveryCompany,group:r.packageNumber||r.productOrderId,recipient:r.recipient};
 row.reason=r.orderId!==orderId?'ORDER_CONFLICT':r.claimStatus||r.claimType?'CLAIM_ACTIVE':!['PAYED',...sentStates].includes(r.status)?'ORDER_NOT_DISPATCHABLE':!['DELIVERY','GDFW_ISSUE_SVC'].includes(r.deliveryMethod)?'DELIVERY_METHOD_UNSUPPORTED':r.status==='PAYED'&&(r.placeOrderStatus!=='OK'||r.dispatchDate)?'ORDER_NOT_DISPATCHABLE':null;
 return row;
});}
function classify(row,carrier,tracking){
 if(row.reason)return {id:row.id,code:row.reason};
 if(row.trackingNo&&(row.trackingNo!==tracking||row.carrierCode!==carrier.code))return {id:row.id,code:'TRACKING_CONFLICT'};
 if(sentStates.includes(row.state))return row.trackingNo===tracking&&row.carrierCode===carrier.code?{id:row.id,verified:true,state:row.state,trackingNo:tracking,carrierCode:carrier.code}:{id:row.id,code:'TRACKING_CONFLICT'};
 if(row.state!=='PAYED')return {id:row.id,code:'ORDER_NOT_DISPATCHABLE'};
 return {id:row.id,pending:true};
}
function createManualShipping(deps){
 async function carriers(channel){
  const list=channel==='naver'?naverCarriers:await deps.cafeCarriers();
  if(!Array.isArray(list)||!list.length||new Set(list.map(c=>c.id)).size!==list.length)throw Error('CARRIER_LIST_INVALID');
  return [...list].sort((a,b)=>Number(/우체국/.test(b.name))-Number(/우체국/.test(a.name))||a.name.localeCompare(b.name,'ko'));
 }
 async function read(input){
  const {channel,orderId,itemIds}=input;
  if(!['cafe24','naver'].includes(channel)||!(channel==='cafe24'?/^\d{8}-\d{7}$/:/^\d{10,30}$/).test(orderId||'')||!Array.isArray(itemIds)||!itemIds.length||itemIds.length>300||new Set(itemIds).size!==itemIds.length||itemIds.some(id=>!(/^[a-zA-Z0-9_-]{1,60}$/).test(id)))throw Error('INVALID_ORDER');
  let rows;
  if(channel==='cafe24'){const remote=await deps.cafeOrder(orderId);if(remote.order?.order_id!==orderId||!Array.isArray(remote.items)||!Array.isArray(remote.receivers))throw Error('CHANNEL_RESPONSE_INVALID');rows=cafeItems(remote);}
  else rows=naverItems(await deps.naverRead(itemIds),orderId);
  return itemIds.map(id=>{const matches=rows.filter(r=>r.id===id);if(matches.length!==1)throw Error('ORDER_CONFLICT');const r=matches[0];if(!Number.isInteger(r.quantity)||r.quantity<1)r.reason='QUANTITY_REVIEW';if(!r.recipient.name||!r.recipient.phone||!r.recipient.zip||!r.recipient.address1)r.reason=r.reason||'RECIPIENT_REVIEW';return {...r,fingerprint:stamp(r),eligible:!r.reason&&r.state==='PAYED'&&!r.trackingNo};});
 }
 async function preview(input){const [items,list]=await Promise.all([read(input),carriers(input.channel)]);return {items,carriers:list,checkedAt:new Date().toISOString()};}
 async function dispatch(input){
  const {channel,orderId,itemIds,trackingNo,carrierId,expected,checkOnly,dispatchedAt}=input;
  if(!Array.isArray(itemIds)||itemIds.length>30||!(/^[A-Za-z0-9-]{5,40}$/).test(trackingNo||'')||/^0+$/.test(trackingNo)||/TEST/i.test(trackingNo)||typeof checkOnly!=='boolean'||!Number.isFinite(Date.parse(dispatchedAt))||Date.parse(dispatchedAt)>Date.now()+60000)throw Error('INVALID_DISPATCH');
  const carrier=(await carriers(channel)).find(c=>c.id===carrierId);if(!carrier)throw Error('CARRIER_NOT_SUPPORTED');
  if((carrier.id==='EPOST'||/우체국/.test(carrier.name))&&!/^[0-9]{13}$/.test(trackingNo))throw Error('INVALID_TRACKING');
  const before=await read(input),results=before.map(r=>classify(r,carrier,trackingNo)),eligible=[];
  for(const r of before){const v=results.find(x=>x.id===r.id);if(!v.pending)continue;if(!expected||expected[r.id]!==r.fingerprint){delete v.pending;v.code='ORDER_CHANGED';}else eligible.push(r);}
  // A single external label cannot cover different recipients or shipping groups.
  if(new Set(eligible.map(r=>JSON.stringify([r.group,r.recipient]))).size>1)throw Error('MULTIPLE_RECIPIENTS');
  let writeUnknown=false,reportedFailures=[];
  if(!checkOnly&&eligible.length){
   try{
    if(channel==='naver'){
     const r=await deps.naverWrite({dispatchProductOrders:eligible.map(r=>({productOrderId:r.id,deliveryMethod:'DELIVERY',deliveryCompanyCode:carrier.code,trackingNumber:trackingNo,dispatchDate:dispatchedAt}))});
     const good=r.data?.successProductOrderIds,bad=r.data?.failProductOrderInfos;
     if(!Array.isArray(good)||!Array.isArray(bad)||eligible.some(e=>good.filter(id=>id===e.id).length+bad.filter(x=>x.productOrderId===e.id).length!==1))writeUnknown=true;
     reportedFailures=Array.isArray(bad)?bad.filter(x=>eligible.some(e=>e.id===x.productOrderId)).map(x=>({id:x.productOrderId,code:/^[A-Za-z0-9_.-]{1,100}$/.test(x.code)?x.code:'CHANNEL_ITEM_FAILED'})):[];
    }else{
     const r=await deps.cafeWrite(orderId,{shop_no:1,request:{tracking_no:trackingNo,shipping_company_code:carrier.code,carrier_id:carrier.carrier_id,order_item_code:eligible.map(r=>r.id),status:'shipping'}});
     const shipments=Array.isArray(r.shipments)?r.shipments:[r.shipments];
     if(!shipments.some(s=>s?.shipping_code&&s.order_id===orderId&&s.tracking_no===trackingNo))writeUnknown=true;
    }
   }catch{writeUnknown=true;}
  }
  // HTTP success and accepted item IDs are not proof of channel state.
  let after;try{after=await read(input);}catch{return {verified:results.filter(r=>r.verified),pendingItemIds:[],excluded:results.filter(r=>r.code),uncertainItemIds:results.filter(r=>r.pending).map(r=>r.id),reportedFailures};}
  const final=after.map(r=>{const pre=results.find(x=>x.id===r.id);return pre.code?pre:classify(r,carrier,trackingNo);});
  return {verified:final.filter(r=>r.verified),pendingItemIds:final.filter(r=>r.pending&&!writeUnknown).map(r=>r.id),uncertainItemIds:final.filter(r=>r.pending&&writeUnknown).map(r=>r.id),excluded:final.filter(r=>r.code),reportedFailures,checkedAt:new Date().toISOString()};
 }
 return {preview,dispatch};
}
module.exports={createManualShipping,naverCarriers,cafeItems,naverItems,classify};
