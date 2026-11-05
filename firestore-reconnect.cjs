'use strict';
const WINDOW_MS=30*60*1000;
// Firestore Watch treats these gRPC statuses as recoverable, including token expiry.
// RESOURCE_EXHAUSTED deliberately remains terminal for this deployment.
const TRANSIENT=new Set([1,2,4,10,13,14,16]);
const NAMES={CANCELLED:1,UNKNOWN:2,DEADLINE_EXCEEDED:4,ABORTED:10,INTERNAL:13,UNAVAILABLE:14,UNAUTHENTICATED:16};
function grpcCode(e){const c=e?.code;if(typeof c==='number'&&Number.isInteger(c))return c;if(typeof c==='string'){if(/^\d{1,2}$/.test(c))return Number(c);return NAMES[c]??null;}return null;}
const retryable=e=>!require('./firestore-read-metrics.cjs').quota(e)&&(TRANSIENT.has(grpcCode(e))||e.firestoreTransportError&&e.code===undefined||['INDEX_STREAM_ENDED','INDEX_UNAVAILABLE','INDEX_RESPONSE_INVALID','INDEX_LEASE_BUSY','INDEX_LEASE_LOST'].includes(e.message)||e.status>=500&&!/CONFIGURATION|QUOTA|REBUILD|BUDGET|RESET/.test(e.message));
class Recovery {
 constructor(now=Date.now){this.now=now;this.attempt=0;this.since=0;this.reads=0;this.budget=0;}
 restore(state){const since=Number(state.disconnected_at)||(state.heartbeat?Number(state.heartbeat):0);if(since&&(!this.since||since<this.since))this.since=since;this.attempt=Math.max(this.attempt,Number(state.retry_attempt)||0);}
 begin(){this.since ||= this.now();return this.expired();}
 expired(){return !!this.since&&this.now()-this.since>=WINDOW_MS;}
 failed(error){this.begin();if(!retryable(error)||this.expired())return null;const delay=Math.min(60000,(error.message==='INDEX_LEASE_BUSY'?30000:2000)*2**Math.min(this.attempt,10));this.attempt++;return Math.min(delay,WINDOW_MS-(this.now()-this.since));}
 connected(){this.attempt=0;this.since=0;this.reads=0;this.budget=0;}
}
module.exports={Recovery,WINDOW_MS,retryable,grpcCode};
