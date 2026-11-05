'use strict';
module.exports=(app,{requireFirebaseAdmin,loadTokenState,readMetrics})=>{
 let flight=null,lastAttempt=0;
 app.post('/cafe24/token-store/recover',requireFirebaseAdmin,async(req,res)=>{
  if(req.body?.singleDocumentProbe!==true)return res.status(400).json({ok:false,code:'EXPLICIT_SINGLE_DOCUMENT_PROBE_REQUIRED'});
  if(flight||Date.now()-lastAttempt<60000)return res.status(409).json({ok:false,code:'TOKEN_STORE_PROBE_ALREADY_ATTEMPTED',retryable:false});
  lastAttempt=Date.now();
  try{
   // Exactly one existing encrypted document. No collection query, OAuth call,
   // credential replacement or token output. The circuit clears only on success.
   flight=readMetrics.manualQuotaProbe(()=>loadTokenState({probe:true}));
   await flight;
   return res.set('Cache-Control','private, no-store').json({ok:true,operation:'token-store-probe',sourceDocumentsRead:1,tokenExposed:false,oauthCalled:false,checkedAt:new Date().toISOString()});
  }catch(e){return require('./cafe24-failure.cjs')(res,e,'token-store-probe');}
  finally{flight=null;}
 });
};
