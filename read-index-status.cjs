'use strict';
// Metadata only: never queries Firestore or starts a listener.
module.exports=async function syncStatus(indexRequest=require('./read-index-client.cjs')){
 const streams=require('./firestore-index-stream.cjs').status();
 let sources=[],available=true;
 try{sources=(await indexRequest({action:'diagnostic'})).sources||[];}catch{available=false;}
 const now=Date.now(),states=['naverOrders','estimates'].map(kind=>{
  const source=sources.find(s=>s.kind===kind),stream=streams.find(s=>s.kind===kind);
  const stopped=!available||!source?.ready||!!source.error||now-source.heartbeat>90000||!!stream&&stream.state!=='current';
  const disconnectedAt=source?.disconnected_at||Date.parse(stream?.disconnectedAt||'')||(stopped&&source?.heartbeat)||null;
  return {kind,stopped,lastUpdatedAt:source?.read_time||null,disconnectedAt:disconnectedAt?new Date(disconnectedAt).toISOString():null,retryAttempt:stream?.retryAttempt||source?.retry_attempt||0,nextRetryAt:stream?.nextRetryAt||null,manualRequired:!!stream?.manualRequired||source?.error==='INDEX_RECONNECT_WINDOW_EXPIRED'||!!disconnectedAt&&now-disconnectedAt>=1800000,errorCode:source?.error_code??stream?.errorCode??null,reason:!available?'INDEX_UNAVAILABLE':source?.error||stream?.error||(!source?.ready?'INDEX_BOOTSTRAP_REQUIRED':null)};
 });
 return {ok:true,stopped:states.some(s=>s.stopped),states,checkedAt:new Date(now).toISOString(),sourceDocumentsRead:0};
};
