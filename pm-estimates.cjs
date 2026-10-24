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
module.exports=function(app,{requireFirebaseAdmin,admin,initFirebaseAdmin}){
 const cache=new Map();let revision=0;
 async function catalog(startDate,endDate){const key=startDate+':'+endDate;const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.promise;const generation=revision;
 const promise=(async()=>{initFirebaseAdmin();let query=admin.firestore().collection('estimates').select(...FIELDS).orderBy('createdAt','desc');if(startDate)query=query.where('createdAt','>=',new Date(startDate+'T00:00:00+09:00'));if(endDate)query=query.where('createdAt','<',new Date(Date.parse(endDate+'T00:00:00+09:00')+86400000));let after=null,rows=[];for(;;){const snap=await(after?query.startAfter(after):query).limit(300).get();if(snap.empty)break;rows.push(...snap.docs.map(d=>project(d,FIELDS)));after=snap.docs.at(-1);}return rows;})();cache.set(key,{promise,expires:Date.now()+15000,generation});if(cache.size>20)cache.delete(cache.keys().next().value);try{return await promise;}catch(e){cache.delete(key);throw e;}}

 async function pageOptions(pageRows){
  // Only this page's scalar option metadata is loaded; never read PDF/source-file fields.
  const batches=[];for(let n=0;n<pageRows.length;n+=10)batches.push(pageRows.slice(n,n+10));const map=new Map();let cursor=0;
  await Promise.all(Array.from({length:Math.min(2,batches.length)},async()=>{while(cursor<batches.length){const batch=batches[cursor++];const snap=await admin.firestore().collection('estimates').where(admin.firestore.FieldPath.documentId(),'in',batch.map(r=>r.id)).select(...OPTION_FIELDS).get();for(const doc of snap.docs)map.set(doc.id,optionMetadata(doc.data()));}}));
  return pageRows.map(row=>({...row,...map.get(row.id)}));
 }
 app.get('/stored/production-manager/estimates',requireFirebaseAdmin,async(req,res)=>{try{
 const {startDate='',endDate='',keyword='',status='',sort='dateDesc'}=req.query;
 if([startDate,endDate].some(d=>d&&!/^\d{4}-\d{2}-\d{2}$/.test(d))||startDate&&endDate&&startDate>endDate||String(keyword).length>200)return res.status(400).json({ok:false,message:'조회 조건을 확인해주세요.'});
 const page=Math.max(1,Number.parseInt(req.query.page)||1),pageSize=50,all=filterRows(await catalog(startDate,endDate),{startDate,endDate}),rows=sortRows(filterRows(all,{keyword,status}),sort),total=rows.length,actualPage=Math.min(page,Math.max(1,Math.ceil(total/pageSize)));
 const pageRows=req.query.countsOnly==='1'?[]:await pageOptions(rows.slice((actualPage-1)*pageSize,actualPage*pageSize));
 res.set('Cache-Control','private, no-store').json({ok:true,estimates:pageRows,total,page:actualPage,pageSize,counts:{all:all.length,paidConfirmed:all.filter(r=>['PAID','CONFIRMED','SHIPPED'].includes(r.orderStatus)).length},dateBasis:'createdAtLocal / createdAt; Asia/Seoul; end inclusive',source:'estimates'});
 }catch{res.status(502).json({ok:false,message:'원본 견적 조회에 실패했습니다. 잠시 후 다시 조회하세요.'});}});
 app.get('/stored/production-manager/estimates/:id',requireFirebaseAdmin,async(req,res)=>{try{initFirebaseAdmin();const d=await admin.firestore().collection('estimates').doc(req.params.id).get();if(!d.exists)return res.status(404).json({ok:false});res.set('Cache-Control','private, no-store').json({ok:true,estimate:project(d,DETAIL)});}catch{res.status(502).json({ok:false});}});
 // Existing status route uses this guard for PM confirmations; ordinary admin changes retain their contract.
 app.patch('/stored/production-manager/estimates/:id/confirm',requireFirebaseAdmin,async(req,res)=>{try{initFirebaseAdmin();const ref=admin.firestore().collection('estimates').doc(req.params.id);const result=await admin.firestore().runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)return {missing:true};const status=snap.data().orderStatus||'UNPAID';if(['CONFIRMED','PAID','SHIPPED'].includes(status))return {alreadyConfirmed:true,orderStatus:status};if(status!=='UNPAID')throw Error('INVALID_STATE');tx.update(ref,{orderStatus:'CONFIRMED',orderStatusLabel:'주문확인',updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.adminUser.email});return {alreadyConfirmed:false,orderStatus:'CONFIRMED'};});if(result.missing)return res.status(404).json({ok:false,message:'견적이 없습니다.'});revision++;cache.clear();res.set('Cache-Control','private, no-store').json({ok:true,...result});}catch{res.status(409).json({ok:false,message:'확정 결과를 확인하지 못했습니다. 상태를 다시 조회하세요.'});}});
};
module.exports.sortRows=sortRows;module.exports.filterRows=filterRows;module.exports.project=project;

module.exports.optionMetadata=optionMetadata;module.exports.OPTION_FIELDS=OPTION_FIELDS;
