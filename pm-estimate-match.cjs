'use strict';
const crypto=require('node:crypto');
const VERSION='pm-estimate-match-20261104-v1';
const ESTIMATE_FIELDS=['estimateNo','customerName','totalPrice','orderStatus','orderStatusLabel','finalQty','needSheets','perSheet','paperName','coatingText','matchedNaverProductOrderId','matchedNaverOrderNo','matchedNaverAmount','matchedNaverBuyerName','matchType','matchedAt','matchedBy','updatedAt','updatedBy','pmMatchReceipt'];
const ORDER_FIELDS=['productOrderId','orderNo','orderId','amount','buyerName','orderName','productName','optionInfo','productOrderStatus','productOrderStatusLabel','status','statusLabel','claimStatus','paymentDate','quantity','matchedEstimateId','matchedEstimateNo','matchType','matchedAt','matchedBy','pmMatchReceipt'];
const error=(code,status=409)=>Object.assign(Error(code),{code,status});
const refs=text=>[...new Set((String(text||'').normalize('NFKC').match(/(?<!\d)\d{6}[-_\s]?\d{6}(?!\d)/g)||[]).map(s=>s.replace(/\D/g,'')).map(s=>s.slice(0,6)+'-'+s.slice(6)))];
function project(snapshot,keys){if(!snapshot?.exists)return null;const d=snapshot.data(),v={id:snapshot.id};for(const k of keys)if(d[k]!==undefined)v[k]=d[k];return v;}
function paidOrder(order,expected){
 if(String(order?.productOrderId||'')!==expected.productOrderId)throw error('NAVER_ITEM_NOT_FOUND',404);
 const parent=String(order.orderNo||order.orderId||'');if(!parent||expected.orderNo&&parent!==expected.orderNo)throw error('PARENT_ORDER_CONFLICT');
 const state=String(order.productOrderStatus||order.status||'').toUpperCase(),claim=String(order.claimStatus||'').toUpperCase();
 if(!['PAYED','PAID','PLACE_ORDER','PREPARING','DELIVERING','DELIVERED','PURCHASE_DECIDED'].includes(state)||!order.paymentDate)throw error('ORDER_NOT_PAID');
 if(claim&&!['NONE','CANCEL_REJECT','CANCEL_WITHDRAW','RETURN_REJECT','RETURN_WITHDRAW','EXCHANGE_REJECT','EXCHANGE_WITHDRAW'].includes(claim))throw error('ORDER_HAS_CLAIM');
 const amount=Number(order.amount);if(!Number.isSafeInteger(amount)||amount<=0||expected.amount!==undefined&&amount!==Number(expected.amount))throw error('ORDER_AMOUNT_MISMATCH');
 return {parent,amount,state};
}
module.exports=function register(app,{requireFirebaseAdmin,admin,initFirebaseAdmin,readNaver,invalidate=()=>{}}){
 const db=()=>{initFirebaseAdmin();return admin.firestore();};
 async function resolveNo(input){let no=String(input.estimateNo||'');if(!no&&input.estimateId){const snap=await db().collection('estimates').doc(String(input.estimateId)).get();if(!snap.exists)throw error('ESTIMATE_NOT_FOUND',404);no=String(snap.data().estimateNo||'');}if(!/^\d{6}-\d{6}$/.test(no))throw error('INVALID_ESTIMATE_NUMBER',400);return no;}
 function inputIds(input){const productOrderId=String(input.productOrderId||''),orderNo=String(input.orderNo||'');if(!/^\d{10,25}$/.test(productOrderId)||orderNo&&!/^\d{10,25}$/.test(orderNo))throw error('INVALID_NAVER_ITEM',400);return {productOrderId,orderNo};}
 async function inspect(input){const ids=inputIds(input),no=await resolveNo(input),store=db();const [matches,order,conflicts]=await Promise.all([store.collection('estimates').where('estimateNo','==',no).limit(2).select(...ESTIMATE_FIELDS).get(),store.collection('naverOrders').doc(ids.productOrderId).get(),store.collection('estimates').where('matchedNaverProductOrderId','==',ids.productOrderId).limit(2).select('estimateNo').get()]);return {contractVersion:VERSION,estimateNo:no,estimates:matches.docs.map(d=>project(d,ESTIMATE_FIELDS)),order:project(order,ORDER_FIELDS),conflicts:conflicts.docs.map(d=>({id:d.id,estimateNo:d.data().estimateNo})),...(input.fresh?{freshOrder:(await readNaver([ids.productOrderId])).map(o=>Object.fromEntries(ORDER_FIELDS.filter(k=>o[k]!==undefined).map(k=>[k,o[k]])))}:{})};}
 async function reconcile(input){
  const ids=inputIds(input),no=await resolveNo(input);if(typeof readNaver!=='function')throw error('NAVER_VERIFICATION_UNAVAILABLE',503);
  const rows=await readNaver([ids.productOrderId]),matches=rows.filter(o=>String(o.productOrderId)===ids.productOrderId);if(matches.length!==1)throw error('NAVER_ITEM_NOT_FOUND',404);
  const order=matches[0],paid=paidOrder(order,{...ids,amount:input.amount}),numbers=refs(order.optionInfo||order.optionCode||'');
  if(numbers.length>1)throw error('AMBIGUOUS_OPTION_ESTIMATES');if(numbers.length===1&&numbers[0]!==no)throw error('OPTION_ESTIMATE_CONFLICT');if(input.mode==='automatic'&&numbers.length!==1)throw error('EXPLICIT_ESTIMATE_NUMBER_REQUIRED');
  const store=db(),orderRef=store.collection('naverOrders').doc(ids.productOrderId),receipt=crypto.createHash('sha256').update([no,ids.productOrderId,paid.parent,paid.amount].join(':')).digest('hex');
  const result=await store.runTransaction(async tx=>{
   const estimates=await tx.get(store.collection('estimates').where('estimateNo','==',no).limit(2));if(estimates.docs.length!==1)throw error(estimates.empty?'ESTIMATE_NOT_FOUND':'AMBIGUOUS_ESTIMATE_NUMBER');const snap=estimates.docs[0],estimate=snap.data(),estimateRef=store.collection('estimates').doc(snap.id);
   const [stored,conflicts]=await Promise.all([tx.get(orderRef),tx.get(store.collection('estimates').where('matchedNaverProductOrderId','==',ids.productOrderId).limit(2))]);const current=stored.exists?stored.data():{};
   if(input.estimateId&&String(input.estimateId)!==snap.id)throw error('ESTIMATE_ID_CONFLICT');if(conflicts.docs.some(d=>d.id!==snap.id)||estimate.matchedNaverProductOrderId&&String(estimate.matchedNaverProductOrderId)!==ids.productOrderId||current.matchedEstimateId&&String(current.matchedEstimateId)!==snap.id||current.matchedEstimateNo&&String(current.matchedEstimateNo)!==no)throw error('MATCH_CONFLICT');
   const status=estimate.orderStatus||'UNPAID';if(!['UNPAID','PAID','CONFIRMED','SHIPPED'].includes(status))throw error('ESTIMATE_STATE_CONFLICT');if(Number(estimate.totalPrice)!==paid.amount)throw error('ESTIMATE_AMOUNT_MISMATCH');
   const next=status==='UNPAID'?'PAID':status,alreadyMatched=estimate.pmMatchReceipt===receipt&&current.pmMatchReceipt===receipt&&status!=='UNPAID';
   if(!alreadyMatched){const time=admin.firestore.FieldValue.serverTimestamp(),kind=input.mode==='automatic'?'auto_option':'manual';
    tx.set(estimateRef,{matchedNaverProductOrderId:ids.productOrderId,matchedNaverOrderNo:paid.parent,matchedNaverAmount:paid.amount,matchedNaverBuyerName:order.buyerName||order.orderName||'',matchType:kind,matchedAt:time,matchedBy:input.actor||'production-manager',orderStatus:next,...(next==='PAID'?{orderStatusLabel:'결제완료'}:{}),updatedAt:time,pmMatchReceipt:receipt},{merge:true});
    const saved=Object.fromEntries(ORDER_FIELDS.filter(k=>!k.startsWith('matched')&&order[k]!==undefined).map(k=>[k,order[k]]));tx.set(orderRef,{...saved,productOrderId:ids.productOrderId,orderNo:paid.parent,matchedEstimateId:snap.id,matchedEstimateNo:no,matchType:kind,matchedAt:time,matchedBy:input.actor||'production-manager',lastSyncedAt:time,pmMatchReceipt:receipt},{merge:true});
    tx.set(store.collection('pmEstimateMatchReceipts').doc(receipt),{version:VERSION,estimateId:snap.id,estimateNo:no,productOrderId:ids.productOrderId,orderNo:paid.parent,amount:paid.amount,paymentDate:order.paymentDate,verifiedAt:time,actor:input.actor||'production-manager',before:{estimate:project(snap,ESTIMATE_FIELDS),order:project(stored,ORDER_FIELDS)}},{merge:true});
   }
   return {contractVersion:VERSION,estimateId:snap.id,estimateNo:no,productOrderId:ids.productOrderId,orderNo:paid.parent,amount:paid.amount,paymentDate:order.paymentDate,orderStatus:next,finalQty:estimate.finalQty,needSheets:estimate.needSheets,receipt,alreadyMatched};
  });invalidate();return result;
 }
 app.get('/stored/production-manager/estimate-match',requireFirebaseAdmin,async(req,res)=>{try{const value=await inspect({...req.query,fresh:req.query.fresh==='1'});res.set('Cache-Control','private, no-store').json({ok:true,...value});}catch(e){res.status(e.status||502).json({ok:false,code:e.code||'SOURCE_LOOKUP_FAILED'});}});
 app.post('/stored/production-manager/estimate-match',requireFirebaseAdmin,async(req,res)=>{try{const value=await reconcile({...req.body,actor:req.adminUser.email});res.set('Cache-Control','private, no-store').json({ok:true,...value});}catch(e){res.status(e.status||502).json({ok:false,code:e.code||'SOURCE_MATCH_FAILED'});}});
 return {inspect,reconcile,version:VERSION};
};
module.exports.refs=refs;module.exports.paidOrder=paidOrder;
