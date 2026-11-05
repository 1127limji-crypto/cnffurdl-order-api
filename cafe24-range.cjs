'use strict';
module.exports=function validRange(start,end){
 const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 const time=v=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|\+09:00)$/.test(v)&&date(v.slice(0,10))&&Number.isFinite(Date.parse(v))&&Number(v.slice(11,13))<24&&Number(v.slice(14,16))<60&&Number(v.slice(17,19))<60;
 return (date(start)&&date(end)||time(start)&&time(end))&&Date.parse(end)>=Date.parse(start)&&Date.parse(end)-Date.parse(start)<=6*86400000;
};
