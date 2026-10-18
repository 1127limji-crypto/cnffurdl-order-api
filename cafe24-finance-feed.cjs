'use strict';
// Authenticated, read-only financial snapshots. Never includes buyer/receiver,
// payment credentials or bank account data; never invokes a mutation API.
module.exports=(app,{requireFirebaseAdmin,cafe24ApiGet,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))})=>{
 const orderKeys=['order_id','shop_no','order_date','payment_date','paid','canceled','payment_amount','actual_payment_amount','initial_order_amount','actual_order_amount','shipping_fee','refund_amount'];
 const itemKeys=['order_item_code','item_no','shop_no','product_no','quantity','claim_quantity','order_status','product_price','option_price','coupon_discount_price','additional_discount_price','app_item_discount_amount','market_discount_amount','payment_amount','refund_date','cancel_date','return_request_date','claim_code','market_cancel_request','individual_shipping_fee'];
 const moneyObject=o=>Object.fromEntries(Object.entries(o).filter(([name,v])=>/(amount$|shipping_fee$)/.test(name)&&v!==null&&v!==''&&['string','number'].includes(typeof v)&&Number.isFinite(Number(v))));
 const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(o,k)).map(k=>[k,['initial_order_amount','actual_order_amount'].includes(k)&&o[k]&&typeof o[k]==='object'?moneyObject(o[k]):o[k]]));
 app.get('/cafe24/finance-orders',requireFirebaseAdmin,async(req,res)=>{
  const ids=String(req.query.ids||'').split(','),shop=Number(req.query.shop_no||1);
  if(!ids.length||ids.length>40||new Set(ids).size!==ids.length||ids.some(id=>!/^\d{8}-\d{7}$/.test(id))||!Number.isInteger(shop)||shop<1)return res.status(400).json({ok:false,error:'INVALID_FINANCE_REQUEST'});
  try{
   const read=async(path,query)=>{
    for(let attempt=0;attempt<3;attempt++){
     await sleep(attempt?1000*attempt:500);
     try{return await cafe24ApiGet(path,query);}catch(error){if(attempt===2||![429,500,502,503,504].includes(Number(error.httpStatus)))throw error;}
    }
   };
   const orders=[];
   for(const id of ids){
    const source=await read('/api/v2/admin/orders/'+encodeURIComponent(id),{shop_no:shop,embed:'items'});
    const o=source.json?.order;
    if(o?.order_id!==id||!Array.isArray(o.items)||!o.items.length||o.items.length>=100)throw Error('INCOMPLETE_FINANCE_ORDER');
    orders.push({...pick(o,orderKeys),finance_checked_at:new Date().toISOString(),finance_schema:1,items:o.items.map(i=>pick(i,itemKeys))});
   }
   const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
   let cursor=orders.map(o=>String(o.order_date||'').slice(0,10)).sort()[0];const refunds=[];
   if(!/^\d{4}-\d{2}-\d{2}$/.test(cursor))throw Error('FINANCE_DATE_MISSING');
   while(cursor<=today){
    const endDate=new Date(cursor+'T00:00:00Z');endDate.setUTCDate(endDate.getUTCDate()+29);const end=[endDate.toISOString().slice(0,10),today].sort()[0];
    let offset=0;
    for(;;){const r=await read('/api/v2/admin/refunds',{shop_no:shop,start_date:cursor,end_date:end,limit:100,offset});const batch=r.json?.refunds;if(!Array.isArray(batch))throw Error('INCOMPLETE_REFUNDS');refunds.push(...batch);if(batch.length<100)break;offset+=100;if(offset>7900)throw Error('REFUND_PAGE_LIMIT');}
    const next=new Date(end+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);cursor=next.toISOString().slice(0,10);
   }
   for(const o of orders){o.finance_refunds=refunds.filter(r=>r.order_id===o.order_id).map(r=>pick(r,['order_item_code','quantity','actual_refund_amount','used_points','used_credits','status','refund_date','accepted_refund_date']));o.finance_checked_at=new Date().toISOString();}
   return res.set('Cache-Control','no-store').json({ok:true,version:1,shopNo:shop,orders});
  }catch(error){return res.status(Number(error.httpStatus)||409).json({ok:false,error:'CAFE24_FINANCE_READ_FAILED'});}
 });
};
