// Process-local only: tokens remain encrypted in the existing durable store.
// A successful callback/refresh seeds the cache after the durable write.
module.exports = function createTokenCache({now=Date.now, ttlMs=300000, retryMs=60000}={}) {
  let value=null, key=null, loadedAt=0, pending=null, retryAt=0, lastError=null, generation=0;
  const quota=e=>Number(e?.code)===8||e?.code==='resource-exhausted';
  return {
    put(nextKey,next) {generation++;key=nextKey;value=next;loadedAt=now();retryAt=0;lastError=null;},
    async get(nextKey,load,{probe=false}={}) {
      if(key!==nextKey){generation++;key=nextKey;value=null;pending=null;retryAt=0;lastError=null;}
      if(!probe&&value&&now()-loadedAt<ttlMs)return value;
      if(!probe&&now()<retryAt){if(value)return value;throw lastError;}
      if(pending){if(!probe||pending.probe)return pending;await pending.catch(()=>{});}
      const started=generation;
      const request=(async()=>{
        try {const next=await load();if(key!==nextKey)throw Object.assign(new Error("Cafe24 인증 설정 변경"),{code:"CAFE24_TOKEN_CONFIG_CHANGED"});if(started===generation){value=next;loadedAt=now();retryAt=0;lastError=null;}return value||next;}
        catch(e){if(!quota(e))throw e;const safe=Object.assign(new Error('Cafe24 인증 저장소 읽기 할당량 초과'),{code:'CAFE24_TOKEN_STORE_QUOTA',httpStatus:503,stage:'token_store',retryable:false});retryAt=now()+retryMs;lastError=safe;console.warn("[cafe24 token store]",safe.code,{cachedState:Boolean(value)});if(value&&!probe)return value;throw safe;}
      })();request.probe=probe;pending=request;
      try{return await request;}finally{if(pending===request)pending=null;}
    }
  };
};
