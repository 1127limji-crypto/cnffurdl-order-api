'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const makeClient=require('./cafe24-token-vault.cjs');
test('vault transport uses only existing private bridge and fails closed on network/401; does not expose remote text',async()=>{
 let request;const client=makeClient({key:()=> 'fixture-key',transport:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({ok:true,value:null})};}});
 assert.deepEqual(await client({action:'get',key:'a'.repeat(64)}),{ok:true,value:null});assert.equal(request.options.redirect,'error');assert.equal(request.options.headers['x-internal-key'],'fixture-key');assert.equal(request.url,'https://pm.cnffurdl.com/api/internal/cafe24-token-vault');
 await assert.rejects(makeClient({key:()=> 'fixture',transport:async()=>{throw Error('PRIVATE');}})({}),{code:'CAFE24_TOKEN_VAULT_UNAVAILABLE'});
 await assert.rejects(makeClient({key:()=> 'fixture',transport:async()=>({ok:false,status:401,json:async()=>({ok:false,code:'UNAUTHORIZED',message:'PRIVATE'})})})({}),e=>e.httpStatus===503&&!e.message.includes('PRIVATE'));
});
function runtime(vault,source){
 const c={mallId:'fixture',clientId:'fixture-client',tokenKey:'fixture'},ref={get:source.read,set:source.write};let refreshCalls=0;
 const block=fs.readFileSync(__dirname+'/server.js','utf8').split('let cafe24RefreshInFlight = null;')[1].split('async function cafe24ApiGet')[0];
 const context={app:{},requireFirebaseAdmin:()=>{},readMetrics:{},crypto,cafe24Crypto:crypto,Buffer,Date,URLSearchParams,AbortSignal,console:{warn:m=>source.warnings.push(m)},admin:{firestore:()=>Object.assign(()=>{}, {collection:()=>({doc:()=>ref})})},cafe24RequireConfig:()=>c,cafe24TokenKey:()=>Buffer.alloc(32,7),initFirebaseAdmin:()=>{},CAFE24_TOKEN_DOC_COLLECTION:'fixture',CAFE24_TOKEN_DOC_ID:'fixture',CAFE24_SCOPE:'mall.read_order',require:name=>name==='./cafe24-token-vault.cjs'?()=>vault:name==='./cafe24-token-cache.cjs'?require(name):()=>{},fetch:async()=>{refreshCalls++;return {ok:true,json:async()=>tokens('rotated')};}};
 context.admin.firestore.FieldValue={serverTimestamp:()=>null};
 vm.createContext(context);const encryptSource=fs.readFileSync(__dirname+'/server.js','utf8').split('function cafe24EncryptJson(')[1].split('function cafe24SafeHtml(')[0];
 vm.runInContext('function cafe24EncryptJson('+encryptSource+'let cafe24RefreshInFlight=null;'+block+';this.load=cafe24LoadTokenState;this.refresh=cafe24RefreshTokenNow;',context);
 return {load:context.load,refresh:context.refresh,refreshCalls:()=>refreshCalls};
}
const tokens=id=>({access_token:'fixture-access-'+id,refresh_token:'fixture-refresh-'+id,expires_at:'2026-11-09T23:00:00+09:00',refresh_token_expires_at:'2026-11-23T23:00:00+09:00',scopes:['mall.read_order'],issued_at:'2026-11-09T09:00:00+09:00'});
function encrypt(token){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.alloc(32,7),iv),data=Buffer.concat([cipher.update(JSON.stringify(token)),cipher.final()]);return {version:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
test('cold restart with source quota uses durable cipher, automatic refresh persists before mirror; no OAuth',async()=>{
 let value=null,lease=null;const fixture={close(){},operate(i){if(i.action==='get')return {ok:true,value};if(i.action==='seed'&&!value||i.action==='put'){if(i.action==='put')assert.equal(i.owner,lease);value={record:i.record,revision:crypto.randomUUID()};return {ok:true,value};}if(i.action==='seed')return {ok:true,value};if(i.action==='lease'){lease=crypto.randomUUID();return {ok:true,owner:lease};}if(i.action==='release'){lease=null;return {ok:true};}throw Error('fixture action');}};
 const db=process.env.PM_TOKEN_VAULT_MODEL?await (await import(process.env.PM_TOKEN_VAULT_MODEL)).openTokenVault(':memory:'):fixture;
 let reads=0,writes=0,quota=false,mirrorFails=false;const source={warnings:[],read:async()=>{reads++;if(quota)throw {code:8};return {exists:true,data:()=>({mallId:'fixture',scopes:['mall.read_order'],expiresAt:tokens().expires_at,refreshTokenExpiresAt:tokens().refresh_token_expires_at,tokenCipher:encrypt(tokens('old'))})};},write:async()=>{writes++;if(mirrorFails)throw Error('PRIVATE');}};
 const vault=async input=>db.operate(input);try{
 const first=runtime(vault,source);assert.equal((await first.load()).token.access_token,'fixture-access-old');assert.equal(reads,1);
 quota=true;const restarted=runtime(vault,source);assert.equal((await restarted.load()).token.access_token,'fixture-access-old');assert.equal(reads,1,'cold process cannot read Firestore when primary exists');
 mirrorFails=true;await restarted.refresh();assert.equal(restarted.refreshCalls(),1);assert.equal(writes,1);assert.ok(source.warnings.some(x=>x.includes('MIRROR_WRITE_FAILED')));
 const afterRotation=runtime(vault,source);assert.equal((await afterRotation.load()).token.access_token,'fixture-access-rotated');assert.equal(reads,1);
 await assert.rejects(afterRotation.load({probe:true}),{code:'CAFE24_TOKEN_STORE_QUOTA'});assert.equal(reads,2,'explicit recovery still performs its one approved source read');
 const unavailable=runtime(async()=>{throw {code:'CAFE24_TOKEN_VAULT_UNAVAILABLE'};},source);await assert.rejects(unavailable.load(),{code:'CAFE24_TOKEN_VAULT_UNAVAILABLE'});assert.equal(reads,2,'unavailable primary must not load a potentially stale mirror');
 }finally{db.close();}
});
