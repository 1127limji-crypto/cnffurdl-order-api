import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
export const VERSION='firestore-index-20261105-v2';
export const DISPLAY=['productOrderId','orderNo','orderId','matchedEstimateNo','estimateNo','matchType','buyerName','orderName','productName','optionInfo','optionCode','quantity','amount','productOrderStatus','productOrderStatusLabel','status','statusLabel','placeOrderLabel','claimStatus','claimStatusLabel','claimType','shippingMemo','paymentDate','orderDate'];
export const ESTIMATE_FIELDS=['estimateNo','customerName','totalPrice','orderStatus','createdAt','createdAtLocal','createdAtIso','source','estimateType','paperName','coatingText','finalQty','designCount','perDesignQty','needSheets','perSheet','itemW','itemH','additionalOptionsText','matchedNaverProductOrderId','matchedNaverOrderNo','matchType','fileReceived','foilText','baseTierPrice','foilAddPerSheet','foilSheetCost','doublePrint','diecut','oshi','oshiCount','circlePunch','circlePunchSize','circlePunchCount','freePunch','freePunchCount','punch','punchCount','layoutLabel','layoutDetail','needSheetsPerDesign','totalNeedSheets','quantityMode','designOptions','foilCount','epoxy','pdfFileName'];
export const SOURCE_FIELDS={naverOrders:[...DISPLAY,'paymentDateYmd','orderDateYmd','localDate','dateYmd','createdAtLocal','createdAtIso','lastSyncedAt','createdAt','updatedAt','receiverName','receiverTel1','baseAddress'],estimates:ESTIMATE_FIELDS};
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
export const normalize=v=>String(v??'').normalize('NFKC').toLowerCase().trim();
const time=v=>{if(v?.toDate)v=v.toDate();if(v&&typeof v==='object'&&v.seconds!==undefined)return Number(v.seconds)*1000+Math.floor(Number(v.nanoseconds||v.nanos||0)/1e6);const n=Date.parse(v||'');return Number.isFinite(n)?n:0;};
const day=v=>{const n=time(v);return n?dateFormatter.format(new Date(n)):'';};
export function storedDay(r){for(const k of ['paymentDate','orderDate'])if(day(r[k]))return day(r[k]);for(const k of ['paymentDateYmd','orderDateYmd','localDate','dateYmd'])if(/^\d{4}-\d{2}-\d{2}$/.test(r[k]||''))return r[k];for(const k of ['createdAtLocal','createdAtIso','lastSyncedAt','createdAt','updatedAt'])if(day(r[k]))return day(r[k]);return '';}
const paid=r=>['PAID','CONFIRMED','SHIPPED'].includes(r.orderStatus);
const allowed=(data,fields)=>Object.fromEntries(fields.filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
function options(data){const fields=ESTIMATE_FIELDS.filter(k=>!['designOptions','pdfBase64'].includes(k));const one=d=>{if(!d||typeof d!=='object')return {};const v=allowed(d,['id','designId','designName','name','label',...fields]);if(d.options&&typeof d.options==='object')v.options=allowed(d.options,fields);return v;};return Array.isArray(data)?data.map(one):data&&typeof data==='object'?Object.fromEntries(Object.entries(data).map(([k,v])=>[k,one(v)])):undefined;}
export function project(kind,id,data){
 if(!SOURCE_FIELDS[kind]||!id||id.length>1500)throw Error('INVALID_SOURCE_DOCUMENT');
 const r={id,...allowed(data,SOURCE_FIELDS[kind])};
 if(kind==='estimates'){
  if(r.designOptions)r.designOptions=options(r.designOptions);
  for(const k of ['createdAt','createdAtIso'])if(time(r[k]))r[k]=new Date(time(r[k])).toISOString();
  r.createdAtIso=r.createdAt||r.createdAtIso||null;r.createdDay=String(r.createdAtLocal||'').slice(0,10)||day(r.createdAtIso);
 }
 return r;
}
    function getEstimateTypeLabel(row){
      const source = String(row.source || "").toLowerCase();
      const hasFoilData = !!(row.foilText || row.baseTierPrice || row.foilAddPerSheet || row.foilSheetCost);

      if (source.includes("foil") || hasFoilData) {
        return "박/에폭시";
      }

      return "지류";
    }

    // 새 견적 필드를 우선 사용하고, 구 서버에서 필드가 누락되면 옵션 문구를 읽습니다.
    // 기존 견적의 finalQty는 1건의 제작수량이자 총수량입니다.
    function getDesignQuantityInfo(row){
      const positiveInteger = (value) => {
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
      };
      const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== "";
      const optionMatch = String(row.additionalOptionsText || "").match(
        /디자인\s*([\d,]+)\s*건\s*\/\s*건당\s*([\d,]+)\s*장\s*\/\s*총\s*([\d,]+)\s*장/
      );
      const fromOption = (index) => optionMatch
        ? positiveInteger(optionMatch[index].replace(/,/g, "")) : null;
      const read = (value, index) => hasValue(value) ? positiveInteger(value) : fromOption(index);
      let designCount = read(row.designCount, 1);
      if (!hasValue(row.designCount) && !optionMatch) designCount = 1;
      let perDesignQty = read(row.perDesignQty, 2);
      let finalQty = read(row.finalQty, 3);
      const invalidField = [row.designCount, row.perDesignQty, row.finalQty]
        .some((value) => hasValue(value) && positiveInteger(value) === null);
      if (!hasValue(row.perDesignQty) && perDesignQty === null && designCount && finalQty && finalQty % designCount === 0) {
        perDesignQty = finalQty / designCount;
      }
      if (!hasValue(row.finalQty) && finalQty === null && designCount && perDesignQty) {
        finalQty = positiveInteger(designCount * perDesignQty);
      }
      const consistent = !invalidField && !!designCount && !!perDesignQty && !!finalQty &&
        designCount * perDesignQty === finalQty;
      const format = (value, unit) => value === null ? "-" : `${Number(value).toLocaleString("ko-KR")}${unit}`;
      const designCountText = format(designCount, "건");
      const perDesignQtyText = format(perDesignQty, "장");
      const finalQtyText = format(finalQty, "장");
      return {
        designCount, perDesignQty, finalQty,
        designCountText, perDesignQtyText, finalQtyText,
        summary: `디자인 ${designCountText} / 건당 ${perDesignQtyText} / 총 ${finalQtyText}`,
        warning: consistent ? "" : "디자인 건수·건당 수량·총수량 확인 필요"
      };
    }

    function getDoublePrintText(row){
      const optionText = String(row.additionalOptionsText || "");

      if (row.doublePrint || optionText.includes("양면인쇄")) {
        return "양면";
      }

      return "-";
    }

    function getCutTypeText(row){
      const optionText = String(row.additionalOptionsText || row.foilText || "");

      if (row.diecut || optionText.includes("자유형재단")) {
        return "자유형재단";
      }

      return "-";
    }

    function getPostProcessText(row){
      const parts = [];

      if (row.oshi) {
        parts.push(`오시 ${row.oshiCount || 1}줄`);
      }

      if (row.circlePunch) {
        parts.push(`원형타공 ${row.circlePunchSize || ""}mm ${row.circlePunchCount || 1}개`);
      }

      if (row.freePunch) {
        parts.push(`자유형타공 ${row.freePunchCount || 1}개`);
      }

      if (!row.circlePunch && !row.freePunch && row.punch && row.punchCount) {
        parts.push(`타공 ${row.punchCount}개`);
      }

      if (!parts.length && row.additionalOptionsText) {
        const text = String(row.additionalOptionsText);
        const found = [];

        const oshiMatch = text.match(/오시\s*\d*줄?/);
        const circlePunchMatch = text.match(/원형타공\s*\d*mm\s*\d*개?/);
        const freePunchMatch = text.match(/자유형타공\s*\d*개?/);
        const oldPunchMatch = text.match(/(?<!원형)(?<!자유형)타공\s*\d*개?/);

        if (oshiMatch) found.push(oshiMatch[0]);
        if (circlePunchMatch) found.push(circlePunchMatch[0]);
        if (freePunchMatch) found.push(freePunchMatch[0]);
        if (oldPunchMatch) found.push(oldPunchMatch[0]);

        return found.length ? found.join(", ") : "-";
      }

      return parts.length ? parts.join(", ") : "-";
    }


function normalized(kind,id,data){
 const r=project(kind,id,data),naver=kind==='naverOrders';
 const fields=naver?DISPLAY:['estimateNo','id','customerName','paperName','coatingText','orderStatus','additionalOptionsText'];
 const adminSearch=normalize([r.estimateNo,r.customerName,r.paperName,r.perSheet,r.coatingText,getDoublePrintText(r),r.foilText,r.additionalOptionsText,getDesignQuantityInfo(r).summary,getEstimateTypeLabel(r),getCutTypeText(r),getPostProcessText(r),r.pdfFileName].join(' '));
 const search=naver?fields.map(k=>normalize(r[k])).join(' '):normalize(fields.map(k=>r[k]||'').join(' '))+' '+adminSearch;
 const ids=naver?[r.productOrderId,r.orderNo,r.orderId,r.estimateNo,r.matchedEstimateNo,...search.matchAll(/\d{6}-\d{6}/g)].map(v=>Array.isArray(v)?v[0]:v):[id,r.estimateNo];
 return {r,search,ids:[...new Set(ids.filter(Boolean).map(normalize))],day:naver?storedDay(r):r.createdDay,stamp:naver?(time(r.paymentDate)||time(r.orderDate)):time(r.createdAtIso||r.createdAtLocal),amount:Number(naver?r.amount:r.totalPrice)||0,visible:naver?(!['CANCEL_DONE','RETURN_DONE'].includes(String(r.claimStatus||'').toUpperCase())&&!/취소완료|반품완료/.test(String(r.claimStatusLabel||r.claimType||''))):true,matched:!!(r.matchedEstimateNo||r.estimateNo),paid:paid(r),status:r.orderStatus||'UNPAID',customer:normalize(r.customerName),receiver:normalize([r.receiverName,r.receiverTel1,r.baseAddress].join(' ')),product:normalize(naver?r.productOrderId:r.estimateNo||id)};
}
function grams(s,max=3){const a=Array.from(s),out=new Set();for(let i=0;i<a.length;i++)for(let n=1;n<=max&&i+n<=a.length;n++)out.add(a.slice(i,i+n).join(''));return [...out];}
const schema=`
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS source_state(kind TEXT PRIMARY KEY,generation TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,token TEXT,read_time TEXT,error TEXT,heartbeat INTEGER DEFAULT 0,documents_read INTEGER DEFAULT 0,owner TEXT,lease_until INTEGER DEFAULT 0,sequence INTEGER DEFAULT 0,data_revision INTEGER DEFAULT 0,bootstrap_after TEXT,bootstrap_snapshot TEXT);
CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,day TEXT NOT NULL,stamp INTEGER NOT NULL,amount REAL NOT NULL,visible INTEGER NOT NULL,matched INTEGER NOT NULL,paid INTEGER NOT NULL,status TEXT NOT NULL,customer TEXT NOT NULL,receiver TEXT NOT NULL,product TEXT NOT NULL,search TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS idx_records_day ON records(kind,visible,day,id);
CREATE INDEX IF NOT EXISTS idx_records_stamp ON records(kind,visible,stamp,id);
CREATE INDEX IF NOT EXISTS idx_records_product ON records(kind,visible,product,id);
CREATE INDEX IF NOT EXISTS idx_records_receiver ON records(kind,visible,receiver,stamp,id);
CREATE INDEX IF NOT EXISTS idx_records_amount ON records(kind,visible,amount,id);
CREATE INDEX IF NOT EXISTS idx_records_customer ON records(kind,visible,customer,id);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(kind,visible,status,id);
CREATE INDEX IF NOT EXISTS idx_records_matched ON records(kind,visible,matched,stamp,id);
CREATE TABLE IF NOT EXISTS search_grams(kind TEXT NOT NULL,gram TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,gram,id),FOREIGN KEY(kind,id) REFERENCES records(kind,id) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS exact_ids(kind TEXT NOT NULL,identifier TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,identifier,id),FOREIGN KEY(kind,id) REFERENCES records(kind,id) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daily_summary(kind TEXT NOT NULL,day TEXT NOT NULL,visible INTEGER NOT NULL,total INTEGER NOT NULL,paid INTEGER NOT NULL,amount REAL NOT NULL,PRIMARY KEY(kind,day,visible));
CREATE TABLE IF NOT EXISTS read_ledger(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,documents INTEGER NOT NULL,empty_queries INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS summary_insert AFTER INSERT ON records BEGIN INSERT INTO daily_summary VALUES(NEW.kind,NEW.day,NEW.visible,1,NEW.paid,NEW.amount) ON CONFLICT(kind,day,visible) DO UPDATE SET total=total+1,paid=paid+NEW.paid,amount=amount+NEW.amount; END;
CREATE TRIGGER IF NOT EXISTS summary_delete AFTER DELETE ON records BEGIN UPDATE daily_summary SET total=total-1,paid=paid-OLD.paid,amount=amount-OLD.amount WHERE kind=OLD.kind AND day=OLD.day AND visible=OLD.visible; END;
`;
export async function openIndex(path,secret='isolated-test-key'){
 const {DatabaseSync}=await import(/* webpackIgnore: true */ 'node:sqlite');
 if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});chmodSync(dirname(path),0o700);}
 const db=new DatabaseSync(path);db.exec(schema);if(path!==':memory:')chmodSync(path,0o600);
 const columns=new Set(db.prepare('PRAGMA table_info(source_state)').all().map(c=>c.name));
 for(const [name,type] of [['disconnected_at','INTEGER DEFAULT 0'],['retry_attempt','INTEGER DEFAULT 0']])if(!columns.has(name))db.exec(`ALTER TABLE source_state ADD COLUMN ${name} ${type}`);
 const txn=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
 const state=kind=>db.prepare('SELECT * FROM source_state WHERE kind=?').get(kind);
 const upsert=(kind,id,data)=>{
  const n=normalized(kind,id,data);db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(kind,id,n.day,n.stamp,n.amount,+n.visible,+n.matched,+n.paid,n.status,n.customer,n.receiver,n.product,n.search,JSON.stringify(n.r));
  const gs=db.prepare('INSERT INTO search_grams VALUES(?,?,?)');for(const g of grams(n.search))gs.run(kind,g,id);
  const es=db.prepare('INSERT INTO exact_ids VALUES(?,?,?)');for(const v of n.ids)es.run(kind,v,id);
 };
 const encode=v=>{const body=Buffer.from(JSON.stringify(v)).toString('base64url');return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');};
 const decode=s=>{try{if(s.length>5000)throw Error();const [body,sig]=s.split('.'),expected=createHmac('sha256',secret).update(body).digest(),actual=Buffer.from(sig||'','base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();return JSON.parse(Buffer.from(body,'base64url'));}catch{throw Object.assign(Error('INVALID_CURSOR'),{status:409});}};
 function query(kind,input={},actor=''){
  let sqlQueryCount=1;const prepare=sql=>{sqlQueryCount++;return db.prepare(sql);};
  const started=performance.now(),s=state(kind);if(!s?.ready)throw Object.assign(Error('INDEX_BOOTSTRAP_REQUIRED'),{status:503});
  const startDate=String(input.startDate||''),endDate=String(input.endDate||''),keyword=normalize(input.keyword),sort=String(input.sort||(kind==='naverOrders'?'paymentDesc':'dateDesc')),status=String(input.status||''),pageSize=Math.min(kind==='naverOrders'?50:100,Math.max(1,parseInt(input.pageSize)|| (kind==='naverOrders'?30:50)));
  const validDay=d=>!d||/^\d{4}-\d{2}-\d{2}$/.test(d)&&day(d+'T12:00:00+09:00')===d;
  if(!validDay(startDate)||!validDay(endDate)||startDate&&endDate&&startDate>endDate||keyword.length>200)throw Object.assign(Error('INVALID_QUERY'),{status:400});
  const sorts=kind==='naverOrders'?{paymentDesc:['stamp','desc'],paymentAsc:['stamp','asc'],matchedOnly:['stamp','desc'],productOrderAsc:['product','asc'],productOrderDesc:['product','desc'],receiverGroup:['receiver','asc','stamp','desc']}:{dateDesc:['stamp','desc'],dateAsc:['stamp','asc'],amountAsc:['amount','asc'],amountDesc:['amount','desc'],customerAsc:['customer','asc'],statusAsc:['status','asc'],estimateNoAsc:['product','asc'],estimateNoDesc:['product','desc']};
  if(!sorts[sort])throw Object.assign(Error('INVALID_SORT'),{status:400});
  const scope=createHash('sha256').update(JSON.stringify([actor,kind,startDate,endDate,keyword,sort,status,pageSize])).digest('hex');
  let cursor=input.cursor?decode(String(input.cursor)):null;if(cursor&&(cursor.scope!==scope||cursor.generation!==s.generation||cursor.revision!==s.data_revision))throw Object.assign(Error('CURSOR_CONDITION_CHANGED'),{status:409});
  // Legacy numeric pages resolve a key cursor inside this database, never fetch skipped Firestore documents.
  const requestedPage=Math.max(1,parseInt(input.page)||1);
  const where=['r.kind=?','r.visible=1'],args=[kind];
  if(startDate){where.push('r.day>=?');args.push(startDate);}if(endDate){where.push("r.day<>'' AND r.day<=?");args.push(endDate);}
  const baseWhere=where.join(' AND '),baseArgs=[...args];
  if(keyword){
   if(/^\d{10,25}$|^\d{6}-\d{6}$/.test(keyword)){where.push('r.id IN (SELECT id FROM exact_ids WHERE kind=? AND identifier=?)');args.push(kind,keyword);}
   else{const a=Array.from(keyword),g=a.slice(0,Math.min(3,a.length)).join('');where.push('r.id IN (SELECT id FROM search_grams WHERE kind=? AND gram=?) AND instr(r.search,?)>0');args.push(kind,g,keyword);}
  }
  if(sort==='matchedOnly')where.push('r.matched=1');
  if(status){if(status==='paidConfirmed')where.push('r.paid=1');else {where.push('r.status=?');args.push(status);}}
  const completeWhere=where.join(' AND '),completeArgs=[...args],summaryWhere=['kind=?','visible=1'],summaryArgs=[kind];if(startDate){summaryWhere.push('day>=?');summaryArgs.push(startDate);}if(endDate){summaryWhere.push("day<>'' AND day<=?");summaryArgs.push(endDate);}
  const counts=prepare('SELECT coalesce(sum(total),0) AS allCount,coalesce(sum(paid),0) AS paidConfirmed,coalesce(sum(amount),0) AS amount FROM daily_summary WHERE '+summaryWhere.join(' AND ')).get(...summaryArgs);
  const totals=!keyword&&!status&&sort!=='matchedOnly'?{total:counts.allCount,totalAmount:counts.amount}:prepare('SELECT count(*) AS total,coalesce(sum(r.amount),0) AS totalAmount FROM records r WHERE '+completeWhere).get(...completeArgs);
  const order=[sorts[sort][0],sorts[sort][1],...(sorts[sort].slice(2)), 'id','asc'];
  const orderParts=[];for(let i=0;i<order.length;i+=2)orderParts.push([order[i],order[i+1]]);
  const orderSQL=orderParts.map(([col,dir])=>'r.'+col+' '+dir).join(',');
  let offset=cursor?.offset||0;
  if(!cursor&&requestedPage>1){offset=Math.min((requestedPage-1)*pageSize,Math.max(0,Math.ceil(totals.total/pageSize)-1)*pageSize);if(offset){const row=prepare('SELECT '+orderParts.map(([col])=>'r.'+col).join(',')+' FROM records r WHERE '+completeWhere+' ORDER BY '+orderSQL+' LIMIT 1 OFFSET ?').get(...completeArgs,offset-1);cursor={values:orderParts.map(([col])=>row[col]),scope,generation:s.generation,revision:s.data_revision,offset};}}
  if(cursor){const alternatives=[];for(let i=0;i<orderParts.length;i++){const terms=[];for(let j=0;j<i;j++){terms.push('r.'+orderParts[j][0]+'=?');args.push(cursor.values[j]);}terms.push('r.'+orderParts[i][0]+(orderParts[i][1]==='desc'?'<':'>')+'?');args.push(cursor.values[i]);alternatives.push('('+terms.join(' AND ')+')');}where.push('('+alternatives.join(' OR ')+')');}
  const selected=input.countsOnly==='1'?[]:prepare('SELECT r.* FROM records r WHERE '+where.join(' AND ')+' ORDER BY '+orderSQL+' LIMIT ?').all(...args,pageSize+1);
  const hasMore=selected.length>pageSize,rows=selected.slice(0,pageSize),last=rows.at(-1),stale=!!s.error||Date.now()-s.heartbeat>90000;
  const nextCursor=hasMore?encode({scope,generation:s.generation,revision:s.data_revision,offset:offset+rows.length,values:orderParts.map(([col])=>last[col])}):null;
  const todayResult=prepare('SELECT count(*) AS n,coalesce(sum(r.amount),0) AS amount FROM records r WHERE '+completeWhere+' AND r.day=?').get(...completeArgs,dateFormatter.format(new Date()));
  const result={todayCount:todayResult.n,todayAmount:todayResult.amount,ok:true,version:VERSION,total:totals.total,totalAmount:totals.totalAmount,pageSize,page:Math.floor(offset/pageSize)+1,offset,hasMore,nextCursor,counts:{all:counts.allCount,paidConfirmed:counts.paidConfirmed},generatedAt:s.read_time||new Date(s.heartbeat).toISOString(),realtimeStopped:stale,reconnectManualRequired:s.error==='INDEX_RECONNECT_WINDOW_EXPIRED',stale,refreshFailed:!!s.error,refreshError:s.error||null,source:'durable-firestore-index',dateBasis:'normalized original dates; Asia/Seoul; end inclusive',metrics:{queryCount:0,sqlQueryCount,documentsRead:0,firestoreDocumentsRead:0,indexRowsReturned:rows.length,pageRowsFetched:selected.length,returnedDocuments:rows.length,databaseMs:Math.round(performance.now()-started)}};
  if(kind==='naverOrders')result.orders=rows.map(row=>allowed(JSON.parse(row.payload),['id',...DISPLAY]));else result.estimates=rows.map(row=>JSON.parse(row.payload));
  return result;
 }
 function mutate(kind,message){
  if(!SOURCE_FIELDS[kind])throw Error('INVALID_SOURCE');return txn(()=>{
   let s=state(kind);const now=Date.now();
   if(message.action==='lease'){
    if(!message.bootstrap&&db.prepare("SELECT 1 FROM source_state WHERE error='FIRESTORE_QUOTA' LIMIT 1").get())throw Object.assign(Error('FIRESTORE_QUOTA'),{status:503});
    if(!message.bootstrap&&s?.error&&/RESET|BUDGET|MISMATCH|PARTIAL|WINDOW_EXPIRED/.test(s.error))throw Object.assign(Error(s.error),{status:409});
    if(s&&!s.ready&&!message.bootstrap)return {ok:true,bootstrapRequired:true};
    if(!s){if(!message.bootstrap) return {ok:true,bootstrapRequired:true};db.prepare('INSERT INTO source_state(kind,generation) VALUES(?,?)').run(kind,message.generation);s=state(kind);}
    if(s.lease_until>now&&s.owner!==message.owner)throw Object.assign(Error('INDEX_LEASE_BUSY'),{status:409});
    if(s.error==='FIRESTORE_QUOTA'&&!message.bootstrap)throw Object.assign(Error('FIRESTORE_QUOTA'),{status:503});
    const disconnectedAt=s.disconnected_at||(s.ready?s.heartbeat:0);
    if(!message.bootstrap&&disconnectedAt&&now-disconnectedAt>=1800000){db.prepare("UPDATE source_state SET error='INDEX_RECONNECT_WINDOW_EXPIRED',disconnected_at=? WHERE kind=?").run(disconnectedAt,kind);return {ok:true,state:state(kind),recordCount:db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n};}
    db.prepare('UPDATE source_state SET owner=?,lease_until=? WHERE kind=?').run(message.owner,now+60000,kind);
    return {ok:true,state:state(kind),recordCount:db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n};
   }
   if(!s||s.owner!==message.owner||(s.lease_until<now&&message.action!=='error'))throw Object.assign(Error('INDEX_LEASE_LOST'),{status:409});
   if(message.action==='verify'){const actual=db.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n;if(actual!==message.expectedCount)throw Object.assign(Error('INDEX_EXISTENCE_FILTER_MISMATCH'),{status:409});return {ok:true};}
   if(message.action==='error'){const code=String(message.error||'INDEX_SYNC_FAILED').slice(0,60);db.prepare('UPDATE source_state SET error=?,lease_until=?,disconnected_at=CASE WHEN disconnected_at>0 THEN disconnected_at ELSE ? END,retry_attempt=? WHERE kind=?').run(code,now,Math.min(now,Number(message.disconnectedAt)||now),Math.max(0,Number(message.retryAttempt)||0),kind);return {ok:true};}
   if(message.action!=='apply')throw Error('INVALID_INDEX_ACTION');
   if(message.sequence<=s.sequence)return {ok:true,duplicate:true};if(message.sequence!==s.sequence+1)throw Object.assign(Error('INDEX_SEQUENCE_GAP'),{status:409});
   if(!Array.isArray(message.changes)||message.changes.length>100)throw Error('INVALID_INDEX_BATCH');
   const since=now-86400000;const recentReads=db.prepare('SELECT coalesce(sum(documents),0) AS n FROM read_ledger WHERE at>=?').get(since).n;if(recentReads+Number(message.documentsRead||0)>20000)throw Object.assign(Error('INDEX_DAILY_READ_BUDGET'),{status:429});
   for(const change of message.changes){if(change.deleted)db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,change.id);else upsert(kind,change.id,change.data);}
   db.prepare('UPDATE source_state SET sequence=?,token=coalesce(?,token),read_time=coalesce(?,read_time),ready=CASE WHEN ? THEN 1 ELSE ready END,error=CASE WHEN ? THEN NULL ELSE error END,heartbeat=CASE WHEN ? THEN ? ELSE heartbeat END,lease_until=?,data_revision=data_revision+?,documents_read=documents_read+?,bootstrap_after=coalesce(?,bootstrap_after),bootstrap_snapshot=coalesce(?,bootstrap_snapshot) WHERE kind=?').run(message.sequence,message.token||null,message.readTime||null,+!!message.current,+!!(message.current||message.readTime),+!!(message.current||message.readTime),now,now+60000,+!!message.changes.length,message.documentsRead||0,message.bootstrapAfter||null,message.bootstrapSnapshot?JSON.stringify(message.bootstrapSnapshot):null,kind);
   if(message.current||message.readTime)db.prepare('UPDATE source_state SET disconnected_at=0,retry_attempt=0 WHERE kind=?').run(kind);
   if(message.documentsRead)db.prepare('INSERT INTO read_ledger(at,kind,path,documents) VALUES(?,?,?,?)').run(now,kind,message.bootstrap?'bootstrap':'change-stream',message.documentsRead);
   return {ok:true,sequence:message.sequence};
  });
 }
 const snapshotQuery=(...args)=>{db.exec('BEGIN');try{const result=query(...args);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 return {db,state,query:snapshotQuery,mutate,close:()=>db.close(),diagnostic:()=>({ok:true,version:VERSION,sources:db.prepare('SELECT kind,ready,read_time,error,heartbeat,documents_read,disconnected_at,retry_attempt FROM source_state').all(),reads:db.prepare('SELECT kind,path,sum(documents) AS documents FROM read_ledger GROUP BY kind,path').all()})};
}
