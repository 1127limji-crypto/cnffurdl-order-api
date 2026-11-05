'use strict';
const request=require('./read-index-client.cjs');
const VERSION='stored-nav-orders-20261105-v2';
module.exports=function(app,{requireFirebaseAdmin,indexRequest=request}){
 const list=(input,actor)=>indexRequest({action:'query',kind:'naverOrders',query:input,actor});
 app.get('/stored/admin/naver-orders',requireFirebaseAdmin,async(req,res)=>{
  res.set('Cache-Control','private, no-store');try{return res.json(await list(req.query,req.adminUser.email));}catch(e){return res.status(e.status>=500?424:e.status||424).json({ok:false,sourceStatus:e.status||503,code:e.message,retryable:false,operation:'read',message:e.message==='INDEX_BOOTSTRAP_REQUIRED'?'검색 인덱스 초기화 대기 중입니다. 이전 정상 데이터를 유지합니다.':e.status===409?'조회 조건이 바뀌었습니다. 첫 페이지부터 조회해주세요.':'저장 주문 갱신에 실패했습니다. 이전 정상 데이터를 유지합니다.'});}
 });
 app.get('/stored/admin/naver-orders/diagnostic',requireFirebaseAdmin,async(req,res)=>{res.set('Cache-Control','private, no-store');try{return res.json({...(await indexRequest({action:'diagnostic'})),readMetrics:require('./firestore-read-metrics.cjs').diagnostic(),streams:require('./firestore-index-stream.cjs').status()});}catch(e){return res.status(e.status>=500?424:e.status||424).json({ok:false,sourceStatus:e.status||503,code:e.message,retryable:false});}});
 return {list,invalidate(){/* Source mutations are consumed once through the durable change stream. */},version:VERSION};
};
