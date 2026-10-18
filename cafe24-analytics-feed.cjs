'use strict';
// One bounded read-only page; the caller checkpoints only after DB upserts.
module.exports = (app,{requireFirebaseAdmin,cafe24ApiGet,normalize}) => {
 app.get('/cafe24/analytics-orders',requireFirebaseAdmin,async(req,res)=>{
  try {
   const start=String(req.query.start||''),end=String(req.query.end||''),shop=Number(req.query.shop_no||1),offset=Number(req.query.offset||0),dateType=String(req.query.date_type||'order_date');
   const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
   if(!['order_date','pay_date'].includes(dateType)||!validDate(start)||!validDate(end)||end<start||(Date.parse(end)-Date.parse(start))/86400000>6||!Number.isInteger(shop)||shop<1||!Number.isInteger(offset)||offset<0||offset>7900) return res.status(400).json({ok:false,error:'INVALID_ANALYTICS_RANGE'});
   const params={shop_no:shop,start_date:start,end_date:end,date_type:dateType,embed:'items,receivers,buyer',limit:100,offset};
   let result;
   for(let retry=0;retry<3;retry++){
    try {result=await cafe24ApiGet('/api/v2/admin/orders',params);break;}catch(error){if(retry===2||![429,500,502,503,504].includes(Number(error.httpStatus)))throw error;await new Promise(r=>setTimeout(r,1000*(retry+1)));}
   }
   const raw=result.json?.orders;if(!Array.isArray(raw))throw Error('INVALID_ORDER_RESPONSE');
   const orders=raw.map(normalize);if(orders.some(o=>!o.externalOrderId))throw Error('MISSING_ORDER_ID');
   let sourceCount=null;
   if(offset===0){const count=await cafe24ApiGet('/api/v2/admin/orders/count',{shop_no:shop,start_date:start,end_date:end,date_type:dateType});sourceCount=Number.isInteger(count.json?.count)?count.json.count:null;}
   return res.set('Cache-Control','no-store').json({ok:true,version:1,startDate:start,endDate:end,shopNo:shop,dateType,paidOnly:false,canceledIncluded:true,deletedScope:'unverified',limit:100,offset,sourceCount,nextOffset:offset+raw.length,complete:raw.length<100,orders});
  }catch(error){return res.status(Number(error.httpStatus)||500).json({ok:false,error:'CAFE24_ANALYTICS_READ_FAILED'});}
 });
};
