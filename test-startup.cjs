const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
(async()=>{
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,stdio:'ignore',env:{...process.env,PORT:'3198',CAFE24_MALL_ID:'fixture',CAFE24_CLIENT_ID:'fixture-id',CAFE24_CLIENT_SECRET:'fixture-secret',CAFE24_REDIRECT_URI:'https://example.invalid/callback',CAFE24_OAUTH_STATE_SECRET:'s'.repeat(40),CAFE24_TOKEN_ENCRYPTION_KEY:'a'.repeat(64)}});
 try{
  let ready=false;for(let n=0;n<60;n++){try{const r=await fetch('http://127.0.0.1:3198/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  for(const shipping of [false,true]){const r=await fetch('http://127.0.0.1:3198/cafe24/oauth/start'+(shipping?'?shipping=1':''),{redirect:'manual'});assert.equal(r.status,302);const u=new URL(r.headers.get('location'));assert.equal(u.searchParams.get('scope'),shipping?'mall.read_order mall.write_order mall.read_shipping':'mall.read_order');assert.equal(u.hostname,'fixture.cafe24api.com');}
  const r=await fetch('http://127.0.0.1:3198/shipping/epost/capabilities');assert.equal(r.status,401);
  console.log('PASS: complete server startup, existing health, normal OAuth scope unchanged, explicit shipping scopes, internal-only new routes.');
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
