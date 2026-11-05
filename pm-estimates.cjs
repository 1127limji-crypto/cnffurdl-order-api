'use strict';
const FIELDS=['estimateNo','customerName','totalPrice','orderStatus','createdAt','createdAtLocal','createdAtIso','source','estimateType','paperName','coatingText','finalQty','designCount','perDesignQty','needSheets','perSheet','itemW','itemH','additionalOptionsText','matchedNaverProductOrderId','matchedNaverOrderNo','matchType','fileReceived','foilText','baseTierPrice','foilAddPerSheet','foilSheetCost'];
const OPTION_FIELDS=["paperName", "coatingText", "itemW", "itemH", "doublePrint", "foilText", "diecut", "oshi", "oshiCount", "circlePunch", "circlePunchSize", "circlePunchCount", "freePunch", "freePunchCount", "punch", "punchCount", "additionalOptionsText", "layoutLabel", "layoutDetail", "perSheet", "needSheets", "needSheetsPerDesign", "totalNeedSheets", "quantityMode", "designOptions"];
const DETAIL=[...new Set([...FIELDS,'foilCount','epoxy',...OPTION_FIELDS])];
const day=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const time=r=>r.createdAt?.toDate?.().getTime()||Date.parse(r.createdAtIso||r.createdAtLocal||'')||0;
function project(doc,fields){const d=doc.data(),r={id:doc.id};for(const k of fields)if(d[k]!==undefined)r[k]=k==='createdAt'?d[k]?.toDate?.().toISOString()||d[k]:d[k];if(fields.includes('designOptions'))Object.assign(r,optionMetadata(d));r.createdAtIso=d.createdAt?.toDate?.().toISOString()||d.createdAtIso||null;r.createdDay=String(d.createdAtLocal||'').slice(0,10)|| (time(d)?day(new Date(time(d))):'');return r;}

function optionMetadata(data){
 const out={};for(const key of OPTION_FIELDS)if(key!=='designOptions'&&data[key]!==undefined)out[key]=data[key];
 const design=d=>{if(!d||typeof d!=='object')return {};const row={};for(const key of ['id','designId','designName','name','label',...OPTION_FIELDS.filter(k=>k!=='designOptions')])if(d[key]!==undefined)row[key]=d[key];if(d.options&&typeof d.options==='object')row.options=optionMetadata(d.options);return row;};
 if(Array.isArray(data.designOptions))out.designOptions=data.designOptions.map(design);else if(data.designOptions&&typeof data.designOptions==='object')out.designOptions=Object.fromEntries(Object.entries(data.designOptions).map(([key,value])=>[key,design(value)]));
 return out;
}

function sortRows(rows,sort){const text=(a,b)=>String(a||'').localeCompare(String(b||''),'ko'),comparators={dateDesc:(a,b)=>Date.parse(b.createdAtIso||b.createdAtLocal||0)-Date.parse(a.createdAtIso||a.createdAtLocal||0),dateAsc:(a,b)=>Date.parse(a.createdAtIso||a.createdAtLocal||0)-Date.parse(b.createdAtIso||b.createdAtLocal||0),amountAsc:(a,b)=>Number(a.totalPrice||0)-Number(b.totalPrice||0),amountDesc:(a,b)=>Number(b.totalPrice||0)-Number(a.totalPrice||0),customerAsc:(a,b)=>text(a.customerName,b.customerName),statusAsc:(a,b)=>text(a.orderStatus||'UNPAID',b.orderStatus||'UNPAID')};if(!comparators[sort])throw Error('INVALID_SORT');return rows.sort((a,b)=>comparators[sort](a,b)||text(a.id,b.id));}
function filterRows(rows,{startDate='',endDate='',keyword='',status=''}){const q=keyword.toLowerCase();return rows.filter(r=>(!startDate||r.createdDay>=startDate)&&(!endDate||r.createdDay<=endDate)&&(!status|| (status==='paidConfirmed'?['PAID','CONFIRMED','SHIPPED'].includes(r.orderStatus):r.orderStatus===status))&&(!q||[r.estimateNo,r.id,r.customerName,r.paperName,r.coatingText,r.orderStatus,r.additionalOptionsText].join(' ').toLowerCase().includes(q)));}
module.exports=function(app,{requireFirebaseAdmin,admin,initFirebaseAdmin,readNaver,indexRequest=require('./read-index-client.cjs')}){
 let revision=0;const cache=new Map();
 app.get('/stored/production-manager/estimates',requireFirebaseAdmin,async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{return res.json(await indexRequest({action:'query',kind:'estimates',query:req.query,actor:req.adminUser.email}));}
  catch(e){return res.status(e.status||503).json({ok:false,code:e.message,retryable:false,operation:'read',message:'견적 갱신에 실패했습니다. 이전 정상 데이터를 유지합니다.'});}
 });
 app.get('/stored/production-manager/estimates/:id',requireFirebaseAdmin,async(req,res)=>{try{initFirebaseAdmin();const d=await admin.firestore().collection('estimates').doc(req.params.id).get();if(!d.exists)return res.status(404).json({ok:false});res.set('Cache-Control','private, no-store').json({ok:true,estimate:project(d,DETAIL)});}catch{res.status(502).json({ok:false});}});
 // Existing status route uses this guard for PM confirmations; ordinary admin changes retain their contract.
 app.patch('/stored/production-manager/estimates/:id/confirm',requireFirebaseAdmin,async(req,res)=>{try{initFirebaseAdmin();const ref=admin.firestore().collection('estimates').doc(req.params.id);const result=await admin.firestore().runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)return {missing:true};const status=snap.data().orderStatus||'UNPAID';if(['CONFIRMED','PAID','SHIPPED'].includes(status))return {alreadyConfirmed:true,orderStatus:status};if(status!=='UNPAID')throw Error('INVALID_STATE');tx.update(ref,{orderStatus:'CONFIRMED',orderStatusLabel:'주문확인',updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.adminUser.email});return {alreadyConfirmed:false,orderStatus:'CONFIRMED'};});if(result.missing)return res.status(404).json({ok:false,message:'견적이 없습니다.'});revision++;cache.clear();res.set('Cache-Control','private, no-store').json({ok:true,...result});}catch(e){const quota=require('./firestore-read-metrics.cjs').quota(e);res.status(quota?503:409).json({ok:false,operation:'write',code:quota?'FIRESTORE_QUOTA':'CONFIRM_RESULT_UNKNOWN',retryable:false,message:'확정 저장 결과를 확인하지 못했습니다. 이전 조회 데이터는 저장 성공을 뜻하지 않습니다. 상태를 다시 확인하세요.'});}});
 return require('./pm-estimate-match.cjs')(app,{requireFirebaseAdmin,admin,initFirebaseAdmin,readNaver,invalidate:()=>{revision++;cache.clear();app.locals?.invalidateStoredNaver?.();}});
};
module.exports.sortRows=sortRows;module.exports.filterRows=filterRows;module.exports.project=project;

module.exports.optionMetadata=optionMetadata;module.exports.OPTION_FIELDS=OPTION_FIELDS;

