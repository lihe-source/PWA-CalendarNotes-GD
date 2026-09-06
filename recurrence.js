// Identical calendar arithmetic in the browser and Worker. Missing month-days are skipped.
const formatters=new Map();
export function validTimezone(tz){try{new Intl.DateTimeFormat('en',{timeZone:tz}).format();return true}catch{return false}}
export function zonedParts(value,tz='Asia/Taipei'){
  if(!formatters.has(tz))formatters.set(tz,new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
  return Object.fromEntries(formatters.get(tz).formatToParts(new Date(value)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
}
export const dateKeyInZone=(value,tz)=>{const p=zonedParts(value,tz);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`};
export function fromZoned(p,tz='Asia/Taipei'){
  const target=Date.UTC(p.year,p.month-1,p.day,p.hour||0,p.minute||0,p.second||0);let ms=target;
  for(let i=0;i<4;i++){const q=zonedParts(ms,tz);const diff=target-Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second);if(!diff)break;ms+=diff;}
  const result=new Date(ms),q=zonedParts(result,tz);
  if(['year','month','day','hour','minute'].some(k=>q[k]!==Number(p[k]||0)))return null;return result;
}
const stamp=(p)=>Date.UTC(p.year,p.month-1,p.day);
function dayParts(key){const [year,month,day]=key.split('-').map(Number);return {year,month,day};}
export function occurrenceAt(event,key,tz='Asia/Taipei'){
  const base=zonedParts(event.start_at,tz),target=dayParts(key),diff=(stamp(target)-stamp(base))/86400000;
  if(diff<0)return null;
  const rule=event.repeat_rule||'';
  if(!rule&&diff!==0||rule==='weekly'&&diff%7!==0||rule==='monthly'&&target.day!==base.day||rule==='yearly'&&(target.month!==base.month||target.day!==base.day))return null;
  return fromZoned({...target,hour:base.hour,minute:base.minute,second:base.second},tz);
}
export function occursOn(event,key,tz='Asia/Taipei'){
  const start=occurrenceAt(event,key,tz);if(start)return true;
  const duration=Math.max(0,Date.parse(event.end_at||event.start_at)-Date.parse(event.start_at));
  if(!duration)return false;
  const target=dayParts(key),endOfDay=fromZoned({...target,hour:23,minute:59,second:59},tz);if(!endOfDay)return false;
  // Only inspect starts that can overlap this day; long non-recurring events use direct bounds.
  if(!event.repeat_rule)return key>=dateKeyInZone(event.start_at,tz)&&key<=dateKeyInZone(new Date(Date.parse(event.end_at)-1),tz);
  const days=Math.min(3660,Math.ceil(duration/86400000)+2);
  for(let i=1;i<=days;i++){const d=new Date(stamp(target)-i*86400000),k=d.toISOString().slice(0,10),o=occurrenceAt(event,k,tz);if(o&&dateKeyInZone(new Date(o.getTime()+duration-1),tz)>=key)return true;}return false;
}
export function nextTrigger(event,offset=0,after=new Date(),tz='Asia/Taipei'){
  if(!event.repeat_rule){const t=new Date(Date.parse(event.start_at)-offset*60000);return t>after?t:null;}
  const lower=new Date(after.getTime()+offset*60000),p=zonedParts(lower,tz);let day=new Date(stamp(p));
  // At most 8 years covers leap-day yearly recurrences, without month-overflow drift.
  for(let i=0;i<2930;i++){const occurrence=occurrenceAt(event,day.toISOString().slice(0,10),tz);if(occurrence){const t=new Date(occurrence.getTime()-offset*60000);if(t>after)return t;}day.setUTCDate(day.getUTCDate()+1);}return null;
}
