'use strict';
// Cloudtype intercepts upstream 5xx bodies. Preserve the actual source status in
// an authenticated failed-dependency response; never return remote response text.
module.exports=function failure(res,error,operation){
 const sourceStatus=Number(error?.httpStatus)||500;
 const code=/^[A-Z][A-Z0-9_]{2,70}$/.test(error?.code||'')?error.code:'CAFE24_SOURCE_FAILED';
 const stage=error?.stage||(/TOKEN_STORE/.test(code)?'token_store':/TOKEN|REFRESH/.test(code)?'authentication':'source_api');
 return res.status(sourceStatus>=500?424:sourceStatus).set('Cache-Control','private, no-store').json({ok:false,sourceStatus,code,stage,retryable:false,operation,message:stage==='token_store'?'Cafe24 인증 저장소 읽기 실패':'Cafe24 원본 요청 실패'});
};
