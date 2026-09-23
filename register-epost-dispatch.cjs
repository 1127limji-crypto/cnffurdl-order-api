const {createDispatch}=require('./epost-dispatch.cjs');
module.exports=function register(app,helpers){
 const {safeSecretEqual,getProductOrderDetailsByIds,getNaverAccessToken,cafe24GetValidToken,cafe24RequireConfig,cafe24ApiGet,cafe24LoadTokenState}=helpers;
 function internal(req,res,next){if(!safeSecretEqual(process.env.PRODUCTION_MANAGER_INTERNAL_API_KEY,req.headers['x-internal-key']))return res.status(401).json({ok:false,code:'INTERNAL_AUTH_REQUIRED'});next();}
 async function scopes(){try{const s=await cafe24LoadTokenState();return Array.isArray(s.meta.scopes)?s.meta.scopes:[];}catch{return [];}}
 async function jsonCall(url,token,body){
  const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error('CHANNEL_HTTP_ERROR');const j=await r.json();return j;
 }
 const inFlight=new Set();
 const run=createDispatch({
  naverRead:ids=>getProductOrderDetailsByIds(ids),
  naverWrite:async body=>{const t=await getNaverAccessToken();return jsonCall('https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/dispatch',t.accessToken,body);},
  cafeRead:async id=>{const r=await cafe24ApiGet(`/api/v2/admin/orders/${encodeURIComponent(id)}/items`,{shop_no:1});if(!Array.isArray(r.json.items))throw new Error('CHANNEL_RESPONSE_INVALID');return r.json.items;},
  cafeCarrier:async()=>{const r=await cafe24ApiGet('/api/v2/admin/carriers',{shop_no:1,limit:100});const found=(r.json.carriers||[]).filter(c=>['우체국택배','우체국','우체국소포'].includes(String(c.shipping_carrier||'').replace(/\s/g,'')));if(found.length!==1)throw new Error('EPOST_CARRIER_NOT_CONFIGURED');return {carrier_id:Number(found[0].carrier_id),shipping_company_code:String(found[0].shipping_carrier_code||'')};},
  cafeWrite:async(id,body)=>{const grants=await scopes();if(!grants.includes('mall.write_order'))throw new Error('CAFE24_WRITE_PERMISSION_REQUIRED');const t=await cafe24GetValidToken(false),c=cafe24RequireConfig();if(!/^[a-z0-9-]+$/i.test(c.mallId))throw new Error('MALL_ID_INVALID');return jsonCall(`https://${c.mallId}.cafe24api.com/api/v2/admin/orders/${encodeURIComponent(id)}/shipments`,t.token.access_token,body);}
 });
 app.get('/shipping/epost/capabilities',internal,async(req,res)=>{const s=await scopes();res.set('Cache-Control','no-store').json({ok:true,version:1,naver:true,cafe24:s.includes('mall.write_order')&&s.includes('mall.read_shipping'),cafe24WriteOrder:s.includes('mall.write_order'),cafe24ReadShipping:s.includes('mall.read_shipping')});});
 app.post('/shipping/epost/dispatch',internal,async(req,res)=>{
  const lock=JSON.stringify([req.body?.channel,req.body?.orderId]);
  if(inFlight.has(lock))return res.status(409).json({ok:false,code:'CHANNEL_OPERATION_IN_PROGRESS'});
  inFlight.add(lock);
  try{
   if(req.body?.channel==='cafe24'){const s=await scopes();if(!s.includes('mall.read_shipping')||(!req.body.checkOnly&&!s.includes('mall.write_order')))return res.status(409).json({ok:false,code:'CAFE24_PERMISSION_REQUIRED'});}
   const result=await run(req.body);res.set('Cache-Control','no-store').json({ok:true,...result});
  }catch(e){const allowed=['INVALID_DISPATCH','INVALID_ORDER','ORDER_CONFLICT','TRACKING_CONFLICT','ORDER_NOT_DISPATCHABLE','EPOST_CARRIER_NOT_CONFIGURED','CAFE24_WRITE_PERMISSION_REQUIRED'];res.status(409).json({ok:false,code:allowed.includes(e.message)?e.message:'CHANNEL_RESULT_UNKNOWN'});}
  finally{inFlight.delete(lock);}
 });
};
