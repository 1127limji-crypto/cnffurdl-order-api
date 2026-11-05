'use strict';
const assert=require('node:assert/strict'),metrics=require('../firestore-read-metrics.cjs');let calls=0,fail=true;
class Query{async get(){calls++;if(fail)throw Object.assign(Error('isolated quota exceeded'),{code:8});return {docs:[{id:'fixture'}]};}}
metrics.install({Query});
(async()=>{const query=new Query();await assert.rejects(query.get(),e=>e.code===8);await assert.rejects(query.get(),e=>e.code===8);assert.equal(calls,1);await assert.rejects(metrics.manualQuotaProbe(()=>query.get()),e=>e.code===8);assert.equal(calls,2);fail=false;await metrics.manualQuotaProbe(()=>query.get());assert.equal(calls,3);await query.get();assert.equal(calls,4);assert.equal(metrics.diagnostic().blockedUntil,null);console.log('PASS quota circuit: automatic reads suppressed; explicit operator probe is one attempt and clears circuit only on success');})().catch(e=>{console.error(e);process.exitCode=1});
