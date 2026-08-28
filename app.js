import { all, put as dbPut, clear as dbClear, setMeta, getMeta } from './db.js';
import { api, setAccessToken, getAccessToken, saveRemote, deleteRemote, flushQueue } from './api.js';
import { extractFolderId, verifyFolder, ensureAppFolders, getOrCreateItemFolder, uploadFile, uploadJson, listLatestBackups, downloadJson } from './google-drive.js';
import { enablePush, testPush } from './push.js';
import { getTaiwanHoliday } from './holidays.js';

const cfg=window.APP_CONFIG;
const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
const state={events:[],notes:[],selectedDate:new Date(),monthCursor:new Date(new Date().getFullYear(),new Date().getMonth(),1),editing:null,driveRoot:'',driveFolders:null,profile:null,lastSync:null,authStatus:'signedOut',workspace:null,workspaceMembers:[]};
let tokenClient=null; let toastTimer=null; let tokenRequestMode='manual';

boot().catch(e=>{console.error(e);toast(`啟動失敗：${friendlyError(e)}`)});

async function boot(){
  $('#currentVersion').textContent=cfg.VERSION;
  $('#appTitle').textContent=cfg.APP_NAME;
  const savedTheme=localStorage.getItem('calendarNotesTheme')||await getMeta('theme','dark');
  applyTheme(savedTheme,false);
  const savedUiStyle=localStorage.getItem('calendarNotesUiStyle')||await getMeta('uiStyle','cartoon-lime');
  applyUiStyle(savedUiStyle,false);
  bindUi();
  await registerServiceWorker();
  await loadLocal();
  await restorePersistentGoogleSession();
  state.driveRoot=await getMeta('driveRoot','');
  $('#driveFolderInput').value=state.driveRoot||'';
  $('#timezoneInput').value=await getMeta('timezone',cfg.DEFAULT_TIMEZONE);
  state.lastSync=await getMeta('lastSync',null); updateSyncLabel();
  renderAll();
  await checkUpdate(true);
  if(getAccessToken()) await afterLogin(false);
  else if(state.profile) autoReconnectGoogle();
  setInterval(()=>{if(getAccessToken()&&navigator.onLine) syncAll(false).catch(console.warn)},cfg.AUTO_SYNC_INTERVAL_MS);
  window.addEventListener('online',()=>{setStatus('已連線，正在同步…');syncAll(false).catch(console.warn)});
  window.addEventListener('offline',()=>setStatus('離線模式：資料會保存在此裝置'));
  handleDeepLink();
}

function bindUi(){
  $$('.nav-btn').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  $('#prevMonthBtn').onclick=()=>changeMonth(-1);
  $('#nextMonthBtn').onclick=()=>changeMonth(1);
  $('#todayBtn').onclick=()=>{const n=new Date();state.monthCursor=new Date(n.getFullYear(),n.getMonth(),1);state.selectedDate=n;renderCalendar();renderDayEvents()};
  $('#addEventBtn').onclick=()=>openEventEditor(); $('#addNoteBtn').onclick=()=>openNoteEditor();
  $('#quickAddBtn').onclick=()=>openAppDialog($('#quickDialog')); $('#quickClose').onclick=()=>closeAppDialog($('#quickDialog'));
  $('#quickEvent').onclick=()=>{closeAppDialog($('#quickDialog'));openEventEditor()}; $('#quickNote').onclick=()=>{closeAppDialog($('#quickDialog'));openNoteEditor()};
  $('#saveItemBtn').onclick=saveEditor; $('#deleteItemBtn').onclick=deleteEditorItem;
  $('#editorCloseBtn').onclick=closeEditor; $('#editorCancelBtn').onclick=closeEditor;
  $('#editorDialog').addEventListener('cancel',e=>{e.preventDefault();closeEditor()});
  $$('#editorDialog, #quickDialog').forEach(d=>d.addEventListener('close',releaseModalViewport));
  $('#noteSearch').addEventListener('input',renderNotes);
  $('#syncBtn').onclick=()=>syncAll(true);
  $('#googleLoginBtn').onclick=googleLogin; $('#googleLogoutBtn').onclick=googleLogout;
  $('#verifyDriveBtn').onclick=verifyAndSaveDrive; $('#backupBtn').onclick=backupNow; $('#restoreBtn').onclick=restoreLatestBackup;
  $('#enablePushBtn').onclick=enableNotifications; $('#testPushBtn').onclick=sendTestPush;
  $('#checkUpdateBtn').onclick=()=>checkUpdate(false); $('#forceUpdateBtn').onclick=forceUpdate;
  $$('.theme-option').forEach(b=>b.addEventListener('click',()=>applyTheme(b.dataset.themeChoice,true)));
  $('#uiStyleSelect')?.addEventListener('change',e=>applyUiStyle(e.target.value,true));
  bindCalendarSwipe();
  $('#timezoneInput').addEventListener('change',async()=>{await setMeta('timezone',$('#timezoneInput').value.trim()||cfg.DEFAULT_TIMEZONE);if(getAccessToken()) await saveSettingsRemote()});
}

async function loadLocal(){
  state.events=(await all('events')).filter(x=>!x.deleted_at); state.notes=(await all('notes')).filter(x=>!x.deleted_at);
}
function renderAll(){renderCalendar();renderDayEvents();renderNotes();renderStatusPanels()}
function showView(name){
  $$('.view').forEach(v=>v.classList.remove('active')); $(`#${name}View`).classList.add('active');
  $$('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  document.body.classList.toggle('calendar-active',name==='calendar');
}


function changeMonth(delta){
  const current=state.monthCursor;const target=new Date(current.getFullYear(),current.getMonth()+delta,1);
  const wantedDay=state.selectedDate.getDate();const maxDay=new Date(target.getFullYear(),target.getMonth()+1,0).getDate();
  state.monthCursor=target;state.selectedDate=new Date(target.getFullYear(),target.getMonth(),Math.min(wantedDay,maxDay));
  renderCalendar();renderDayEvents();
}
function bindCalendarSwipe(){
  const el=$('#monthGrid');if(!el)return;let sx=0,sy=0,dx=0,dy=0,tracking=false;
  el.addEventListener('touchstart',e=>{if(e.touches.length!==1)return;tracking=true;sx=e.touches[0].clientX;sy=e.touches[0].clientY;dx=0;dy=0},{passive:true});
  el.addEventListener('touchmove',e=>{if(!tracking||e.touches.length!==1)return;dx=e.touches[0].clientX-sx;dy=e.touches[0].clientY-sy;if(Math.abs(dx)>18&&Math.abs(dx)>Math.abs(dy)*1.15)e.preventDefault()},{passive:false});
  el.addEventListener('touchend',e=>{if(!tracking)return;if(e.changedTouches?.length){dx=e.changedTouches[0].clientX-sx;dy=e.changedTouches[0].clientY-sy}tracking=false;if(Math.abs(dx)>=52&&Math.abs(dx)>Math.abs(dy)*1.25)changeMonth(dx<0?1:-1)},{passive:true});
  el.addEventListener('touchcancel',()=>{tracking=false},{passive:true});
}
let modalReturnScrollY=0;
function openAppDialog(dialog){
  if(!dialog||dialog.open)return;
  modalReturnScrollY=window.scrollY||0;
  document.documentElement.classList.add('modal-open');document.body.classList.add('modal-open');
  dialog.showModal();
}
function closeAppDialog(dialog){
  if(!dialog?.open)return;
  const active=document.activeElement;if(active&&typeof active.blur==='function')active.blur();
  dialog.close();
}
function releaseModalViewport(){
  requestAnimationFrame(()=>{
    if(document.querySelector('dialog[open]'))return;
    document.documentElement.classList.remove('modal-open');document.body.classList.remove('modal-open');
    const maxScroll=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
    window.scrollTo(0,Math.min(modalReturnScrollY,maxScroll));
    // iOS 在鍵盤 / dialog 關閉後偶爾延後更新 visual viewport，再校正一次避免頁面底部多出空白。
    setTimeout(()=>{const max2=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);window.scrollTo(0,Math.min(modalReturnScrollY,max2))},80);
  });
}
function closeEditor(){state.editing=null;closeAppDialog($('#editorDialog'))}
async function applyTheme(theme,persist=true){
  const value=theme==='light'?'light':'dark';document.documentElement.dataset.theme=value;
  try{localStorage.setItem('calendarNotesTheme',value)}catch{}
  const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=value==='light'?'#f7f9fc':'#111827';
  $$('.theme-option').forEach(b=>b.classList.toggle('active',b.dataset.themeChoice===value));
  if(persist)await setMeta('theme',value);
}

async function applyUiStyle(style,persist=true){
  const legacyMap={windows10:'cartoon-lime',mac:'cartoon-lime',ios26:'cartoon-lime',cartoon:'cartoon-lime'};
  const allowed=new Set(['cartoon-lime','cartoon-sky','cartoon-peach','cartoon-lavender','cartoon-berry','cartoon-mint','cartoon-lemon','cartoon-coral','cartoon-cocoa','cartoon-night']);
  const migrated=legacyMap[style]||style;
  const value=allowed.has(migrated)?migrated:'cartoon-lime';
  document.documentElement.dataset.uiStyle=value;
  try{localStorage.setItem('calendarNotesUiStyle',value)}catch{}
  const select=$('#uiStyleSelect');if(select)select.value=value;
  if(persist)await setMeta('uiStyle',value);
}

function renderCalendar(){
  const y=state.monthCursor.getFullYear(),m=state.monthCursor.getMonth(); $('#monthLabel').textContent=`${y} 年 ${m+1} 月`;
  const first=new Date(y,m,1); const start=new Date(y,m,1-first.getDay()); const todayKey=dateKey(new Date()); const selectedKey=dateKey(state.selectedDate);
  const grid=$('#monthGrid');grid.innerHTML='';
  const weekBox=$('#weekNumbers');if(weekBox){weekBox.innerHTML='';for(let row=0;row<6;row++){const rowStart=new Date(start);rowStart.setDate(start.getDate()+row*7);const marker=new Date(rowStart);marker.setDate(rowStart.getDate()+4);const rowEnd=new Date(rowStart);rowEnd.setDate(rowStart.getDate()+6);const wk=document.createElement('div');wk.className='week-number';if(state.selectedDate>=rowStart&&state.selectedDate<=new Date(rowEnd.getFullYear(),rowEnd.getMonth(),rowEnd.getDate(),23,59,59,999))wk.classList.add('active');wk.textContent=`WK${String(isoWeekNumber(marker)).padStart(2,'0')}`;weekBox.appendChild(wk)}}
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);const key=dateKey(d);const cell=document.createElement('button');
    const weekday=d.getDay(); const holiday=getTaiwanHoliday(key);
    cell.type='button';cell.className='day-cell';
    if(d.getMonth()!==m)cell.classList.add('muted');
    if(weekday===0||weekday===6)cell.classList.add('weekend');
    if(key===todayKey)cell.classList.add('today');
    if(key===selectedKey)cell.classList.add('selected');
    if(holiday)cell.classList.add('holiday');
    const evs=eventsForDate(key);
    const holidayHtml=holiday?`<span class="holiday-chip" title="${attr(holiday.name)}">${esc(holiday.name)}</span>`:'';
    const eventsHtml=evs.slice(0,3).map(e=>`<span class="event-dot">${esc(e.title)}</span>`).join('');
    const moreHtml=evs.length>3?`<div class="more-dot">+${evs.length-3}</div>`:'';
    // 日期固定左上；假日與事件放進獨立內容區，強制從上往下排列，避免 button 內文被瀏覽器垂直置中。
    cell.innerHTML=`<span class="day-num">${d.getDate()}</span><div class="day-content">${holidayHtml}${eventsHtml}${moreHtml}</div>`;
    // 點選前後月份的灰色日期時只選取日期，不自動重排月份，保留上一週與目前視覺位置。
    cell.onclick=()=>{state.selectedDate=new Date(d);renderCalendar();renderDayEvents()};grid.appendChild(cell);
  }
}
function renderDayEvents(){
  const key=dateKey(state.selectedDate);$('#selectedDateLabel').textContent=`${state.selectedDate.getMonth()+1}/${state.selectedDate.getDate()} 事項`;
  const items=eventsForDate(key).sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at)));const box=$('#dayEvents');
  box.innerHTML=items.length?'':'<div class="hint">這天沒有行程。</div>';
  items.forEach(e=>{const div=document.createElement('button');div.className='list-item';div.innerHTML=`<div class="grow"><h4>${esc(e.title)}</h4><div class="meta">${e.all_day?'全天':formatTime(e.start_at)} ${e.location?` · ${esc(e.location)}`:''}</div>${e.description?`<div class="snippet">${esc(shorten(e.description,100))}</div>`:''}</div>${e.reminder_minutes?.length?'<span class="badge">🔔</span>':''}`;div.onclick=()=>openEventEditor(e);box.appendChild(div)});
}
function renderNotes(){
  const q=$('#noteSearch').value.trim().toLowerCase();let arr=[...state.notes].filter(n=>!n.deleted_at);if(q)arr=arr.filter(n=>`${n.title} ${n.content} ${(n.tags||[]).join(' ')}`.toLowerCase().includes(q));arr.sort((a,b)=>(Number(b.pinned)-Number(a.pinned))||String(b.updated_at).localeCompare(String(a.updated_at)));
  const box=$('#notesList');box.innerHTML=arr.length?'':'<div class="hint">尚無備註。</div>';
  arr.forEach(n=>{const div=document.createElement('button');div.className='list-item';div.innerHTML=`<div class="grow"><h4>${n.pinned?'📌 ':''}${esc(n.title)}</h4><div class="meta">${formatDateTime(n.updated_at)} ${n.reminder_at?' · 🔔 '+formatDateTime(n.reminder_at):''}</div>${n.content?`<div class="snippet">${esc(shorten(n.content,150))}</div>`:''}<div>${(n.tags||[]).slice(0,5).map(t=>`<span class="badge">${esc(t)}</span>`).join('')}</div></div>`;div.onclick=()=>openNoteEditor(n);box.appendChild(div)});
}
function renderStatusPanels(){
  const hasToken=!!getAccessToken();const connected=hasToken&&!!state.profile;
  const card=$('#googleIdentityCard'),avatar=$('#googleAvatar'),fallback=$('#googleAvatarFallback');
  if(state.profile){
    card?.classList.remove('hidden');
    if($('#googleIdentityName'))$('#googleIdentityName').textContent=state.profile.name||state.profile.email||'Google 使用者';
    if($('#googleIdentityEmail'))$('#googleIdentityEmail').textContent=state.profile.email||'';
    const initial=(state.profile.name||state.profile.email||'G').trim().charAt(0).toUpperCase()||'G';
    if(fallback){fallback.textContent=initial;fallback.classList.toggle('hidden',!!state.profile.picture)}
    if(avatar){
      if(state.profile.picture){avatar.src=state.profile.picture;avatar.alt=`${state.profile.name||'Google 使用者'} 的 Google 帳號頭像`;avatar.classList.remove('hidden')}
      else{avatar.removeAttribute('src');avatar.classList.add('hidden')}
      avatar.onerror=()=>{avatar.classList.add('hidden');fallback?.classList.remove('hidden')};
    }
    if($('#googleIdentityBadge'))$('#googleIdentityBadge').textContent=connected?'已登入':'已記住';
  }else card?.classList.add('hidden');
  const loginBtn=$('#googleLoginBtn'),logoutBtn=$('#googleLogoutBtn');
  if(loginBtn){loginBtn.classList.toggle('hidden',connected);loginBtn.textContent=state.profile?'重新授權 Google Drive':'登入 / 授權 Google Drive'}
  if(logoutBtn)logoutBtn.classList.toggle('hidden',!state.profile);
  if(connected) $('#googleStatus').textContent='Google 帳號已連線';
  else if(state.authStatus==='reconnecting'&&state.profile) $('#googleStatus').textContent='正在自動重新連線 Google…';
  else if(state.profile) $('#googleStatus').textContent='帳號已記住；Google 要求重新驗證時才需重新授權';
  else $('#googleStatus').textContent='尚未登入';

  const wsStatus=$('#workspaceStatus'),wsMembers=$('#workspaceMembers');
  if(state.workspace){
    const roleLabel={owner:'擁有者',editor:'可編輯',viewer:'唯讀'}[state.workspace.role]||state.workspace.role;
    if(wsStatus)wsStatus.innerHTML=`<strong>${esc(state.workspace.name||'共享行事曆')}</strong><br><span class="hint">已加入共享工作區 · ${roleLabel} · ${state.workspaceMembers.length||'—'} 位成員</span>`;
    if(wsMembers)wsMembers.innerHTML=state.workspaceMembers.length?state.workspaceMembers.map(m=>`<div class="workspace-member"><span class="workspace-member-avatar">${esc((m.name||m.email||'G').trim().charAt(0).toUpperCase())}</span><span><strong>${esc(m.name||m.email||'Google 使用者')}</strong><small>${esc(m.email||'')} · ${{owner:'擁有者',editor:'可編輯',viewer:'唯讀'}[m.role]||esc(m.role||'')}</small></span></div>`).join(''):'<div class="hint">成員資料同步中…</div>';
  }else{
    if(wsStatus)wsStatus.innerHTML=connected?'尚未加入共享工作區。請在下方貼上「所有成員共用」的 Google Drive 資料夾並按「加入 / 測試並儲存」。':'登入 Google 後即可加入共享工作區。';
    if(wsMembers)wsMembers.innerHTML='';
  }
  $('#driveStatus').textContent=state.driveRoot?`Folder ID：${state.driveRoot}`:'尚未設定';
  $('#pushStatus').textContent=('Notification'in window)?`通知權限：${Notification.permission}`:'此瀏覽器不支援通知';

  const readOnly=state.workspace?.role==='viewer';
  ['addEventBtn','addNoteBtn','quickAddBtn','backupBtn','restoreBtn'].forEach(id=>{const el=$(`#${id}`);if(el)el.disabled=!!readOnly});
  if($('#saveItemBtn'))$('#saveItemBtn').disabled=!!readOnly;
  if($('#deleteItemBtn'))$('#deleteItemBtn').disabled=!!readOnly;
}

function openEventEditor(item=null){
  // 新增行程時以「現在」為開始時間；結束時間預設為開始時間 + 1 小時。
  // 編輯既有行程時則保留原本的開始 / 結束時間。
  const now=item?new Date(item.start_at):new Date();
  const end=item?.end_at?new Date(item.end_at):new Date(now.getTime()+60*60*1000);
  state.editing={kind:'events',item:item?structuredClone(item):null};
  $('#editorTitle').textContent=item?'編輯行程':'新增行程';$('#deleteItemBtn').classList.toggle('hidden',!item);
  // 新增行程預設勾選「準時」；編輯行程沿用原本設定。
  const mins=item?.reminder_minutes??[0];
  $('#editorFields').innerHTML=`
    <label>標題<input id="fTitle" value="${attr(item?.title||'')}" required></label>
    ${dateTime24Html('fStart','開始時間',now)}
    ${dateTime24Html('fEnd','結束時間',end)}
    <div class="check-row"><label><input id="fAllDay" type="checkbox" ${item?.all_day?'checked':''}>全天</label><label><input id="fCompleted" type="checkbox" ${item?.completed?'checked':''}>已完成</label></div>
    <label>重複<select id="fRepeat"><option value="">不重複</option><option value="daily">每天</option><option value="weekly">每週</option><option value="monthly">每月</option><option value="yearly">每年</option></select></label>
    <label>分類<input id="fCategory" value="${attr(item?.category||'')}"></label>
    <label>地點<input id="fLocation" value="${attr(item?.location||'')}"></label>
    <label>說明<textarea id="fDescription">${esc(item?.description||'')}</textarea></label>
    <label>提醒</label><div class="check-row">${[[0,'準時'],[10,'10 分鐘前'],[60,'1 小時前'],[1440,'1 天前'],[10080,'1 週前']].map(([v,l])=>`<label><input type="checkbox" name="reminder" value="${v}" ${mins.includes(v)?'checked':''}>${l}</label>`).join('')}</div>
    ${attachmentsHtml(item?.attachment_meta||[])}
    <label>新增照片 / 附件<input id="fFiles" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"></label>
  `;
  $('#fRepeat').value=item?.repeat_rule||'';

  // V1.6.1：所有時間改用 00–23 / 00–59 的自訂 24 小時選擇器，避免 iOS/Chrome 依系統地區切回 AM/PM。
  // 新增行程時，只要尚未手動修改結束時間，變更開始時間就自動把結束時間調成 +1 小時。
  if(!item){
    let autoEnd=true;
    const syncEnd=()=>{
      if(!autoEnd)return;
      const startDate=readDateTime24('fStart');
      if(!startDate)return;
      setDateTime24('fEnd',new Date(startDate.getTime()+60*60*1000));
    };
    bindDateTime24('fStart',syncEnd);
    bindDateTime24('fEnd',()=>{autoEnd=false});
  }

  openAppDialog($('#editorDialog'));
}
function openNoteEditor(item=null){
  state.editing={kind:'notes',item:item?structuredClone(item):null};$('#editorTitle').textContent=item?'編輯備註':'新增備註';$('#deleteItemBtn').classList.toggle('hidden',!item);
  $('#editorFields').innerHTML=`
    <label>標題<input id="fTitle" value="${attr(item?.title||'')}" required></label>
    <label>內容<textarea id="fContent">${esc(item?.content||'')}</textarea></label>
    <label>分類<input id="fCategory" value="${attr(item?.category||'')}"></label>
    <label>標籤（用逗號分隔）<input id="fTags" value="${attr((item?.tags||[]).join(', '))}"></label>
    ${dateTime24Html('fReminderAt','提醒時間',item?.reminder_at?new Date(item.reminder_at):null,{allowEmpty:true,defaultHour:9,defaultMinute:0})}
    <div class="check-row"><label><input id="fPinned" type="checkbox" ${item?.pinned?'checked':''}>置頂</label><label><input id="fCompleted" type="checkbox" ${item?.completed?'checked':''}>已完成</label></div>
    ${attachmentsHtml(item?.attachment_meta||[])}
    <label>新增照片 / 附件<input id="fFiles" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"></label>
  `;
  bindOptionalDateTime24('fReminderAt');
  openAppDialog($('#editorDialog'));
}
function attachmentsHtml(items){if(!items.length)return '<div class="hint">目前沒有附件。</div>';return `<div class="attachment-list">${items.map(a=>`<div class="attachment">${a.mimeType?.startsWith('image/')&&a.thumbnailLink?`<img class="attachment-thumb" src="${attr(a.thumbnailLink)}" alt="">`:'📎'} <a href="${attr(a.webViewLink||'#')}" target="_blank" rel="noopener">${esc(a.name||'附件')}</a><span class="meta">${formatBytes(a.size)}</span></div>`).join('')}</div>`}

async function saveEditor(){
  try{
    if(state.workspace?.role==='viewer')throw new Error('READ_ONLY_MEMBER');
    const ed=state.editing;if(!ed)return;const old=ed.item||{};const title=$('#fTitle').value.trim();if(!title){toast('請輸入標題');return}
    const now=new Date().toISOString();const id=old.id||crypto.randomUUID();let item;
    if(ed.kind==='events'){
      const start=readDateTime24('fStart'),end=readDateTime24('fEnd');if(!start){toast('請設定開始時間');return}
      if(end&&end.getTime()<start.getTime()){toast('結束時間不可早於開始時間');return}
      item={...old,id,title,description:$('#fDescription').value,location:$('#fLocation').value,start_at:start.toISOString(),end_at:end?end.toISOString():null,all_day:$('#fAllDay').checked,category:$('#fCategory').value,color:old.color||'',completed:$('#fCompleted').checked,repeat_rule:$('#fRepeat').value,reminder_minutes:$$('input[name="reminder"]:checked').map(x=>Number(x.value)),attachment_meta:[...(old.attachment_meta||[])],revision:Number(old.revision||0),created_at:old.created_at||now,updated_at:now,deleted_at:null};
    }else{
      const rem=readDateTime24('fReminderAt',{allowEmpty:true});item={...old,id,title,content:$('#fContent').value,category:$('#fCategory').value,tags:$('#fTags').value.split(',').map(x=>x.trim()).filter(Boolean),pinned:$('#fPinned').checked,completed:$('#fCompleted').checked,reminder_at:rem?rem.toISOString():null,attachment_meta:[...(old.attachment_meta||[])],revision:Number(old.revision||0),created_at:old.created_at||now,updated_at:now,deleted_at:null};
    }
    const files=[...($('#fFiles')?.files||[])];if(files.length){item.attachment_meta.push(...await uploadAttachments(id,files));}
    await dbPut(ed.kind,item);replaceStateItem(ed.kind,item);renderAll();closeAppDialog($('#editorDialog'));toast('已儲存');
    if(getAccessToken()&&navigator.onLine){const saved=await saveRemote(ed.kind,item);replaceStateItem(ed.kind,saved);renderAll();}else{await saveRemote(ed.kind,item)}
  }catch(e){console.error(e);toast(`儲存失敗：${friendlyError(e)}`)}
}
async function deleteEditorItem(){
  const ed=state.editing;if(!ed?.item)return;if(!confirm(`確定刪除「${ed.item.title}」？\nGoogle Drive 已上傳附件不會自動刪除。`))return;
  try{const tomb=await deleteRemote(ed.kind,ed.item);state[ed.kind]=state[ed.kind].filter(x=>x.id!==ed.item.id);renderAll();closeAppDialog($('#editorDialog'));toast('已刪除')}catch(e){toast(`刪除失敗：${friendlyError(e)}`)}
}
function replaceStateItem(kind,item){const arr=state[kind];const i=arr.findIndex(x=>x.id===item.id);if(item.deleted_at){if(i>=0)arr.splice(i,1);return}if(i>=0)arr[i]=item;else arr.push(item)}

async function uploadAttachments(itemId,files){
  if(!navigator.onLine)throw new Error('附件上傳需要網路連線');if(!getAccessToken())throw new Error('請先登入 Google');if(!state.driveRoot)throw new Error('請先在設定頁指定 Google Drive 共用資料夾');
  const folders=state.driveFolders||await ensureAppFolders(state.driveRoot);state.driveFolders=folders;const itemFolder=await getOrCreateItemFolder(folders.attachments.id,itemId);const out=[];
  for(const file of files){setStatus(`正在上傳 ${file.name}…`);const r=await uploadFile(file,itemFolder.id,file.name);out.push({id:r.id,name:r.name,mimeType:r.mimeType,size:Number(r.size||file.size),webViewLink:r.webViewLink||'',thumbnailLink:r.thumbnailLink||'',createdTime:r.createdTime||new Date().toISOString()})}
  setStatus('附件上傳完成');return out;
}

async function waitForGoogleIdentity(timeoutMs=8000){
  const started=Date.now();while(!window.google?.accounts?.oauth2){if(Date.now()-started>timeoutMs)throw new Error('Google Identity Services 載入逾時');await new Promise(r=>setTimeout(r,120))}return true;
}
function initTokenClient(){
  if(tokenClient)return tokenClient;if(!window.google?.accounts?.oauth2)throw new Error('Google Identity Services 尚未載入，請確認網路');
  if(!cfg.GOOGLE_CLIENT_ID||cfg.GOOGLE_CLIENT_ID.startsWith('REPLACE_'))throw new Error('請先在 config.js 設定 GOOGLE_CLIENT_ID');
  tokenClient=google.accounts.oauth2.initTokenClient({client_id:cfg.GOOGLE_CLIENT_ID,scope:cfg.GOOGLE_SCOPES,callback:async response=>{
    const mode=tokenRequestMode;tokenRequestMode='manual';
    if(response.error){state.authStatus=state.profile?'remembered':'signedOut';renderStatusPanels();if(mode!=='auto')toast(`Google 授權失敗：${response.error}`);else setStatus('Google 帳號已記住；Google 目前要求重新授權');return}
    setAccessToken(response.access_token);const expiresAt=Date.now()+(Number(response.expires_in||3600)-60)*1000;state.authStatus='connected';await setMeta('googleSession',{token:response.access_token,expiresAt,profile:state.profile||null});await afterLogin(mode!=='auto');
  },error_callback:error=>{const mode=tokenRequestMode;tokenRequestMode='manual';state.authStatus=state.profile?'remembered':'signedOut';renderStatusPanels();if(mode!=='auto')toast(`Google 授權視窗失敗：${error?.type||'unknown'}`)}});return tokenClient;
}
async function googleLogin(){try{await waitForGoogleIdentity();tokenRequestMode='manual';initTokenClient().requestAccessToken({prompt:'',login_hint:state.profile?.email||''})}catch(e){toast(friendlyError(e))}}
async function restorePersistentGoogleSession(){
  try{
    let saved=await getMeta('googleSession',null);
    if(!saved){const legacy=JSON.parse(sessionStorage.getItem('googleToken')||'null');if(legacy?.token&&legacy.expiresAt>Date.now()){saved={...legacy,profile:null};await setMeta('googleSession',saved)}}
    if(!saved)return;state.profile=saved.profile||null;
    if(saved.token&&Number(saved.expiresAt)>Date.now()){setAccessToken(saved.token);state.authStatus='connected'}
    else{setAccessToken('');state.authStatus=state.profile?'remembered':'signedOut';await setMeta('googleSession',{token:'',expiresAt:0,profile:state.profile||null})}
  }catch(e){console.warn('restore Google session failed',e)}
}
async function autoReconnectGoogle(){
  if(getAccessToken()||!state.profile||!navigator.onLine)return;state.authStatus='reconnecting';renderStatusPanels();setStatus(`正在自動連線 Google：${state.profile.email||state.profile.name||''}`);
  try{await waitForGoogleIdentity();tokenRequestMode='auto';initTokenClient().requestAccessToken({prompt:'none',login_hint:state.profile.email||''})}catch(e){tokenRequestMode='manual';state.authStatus='remembered';renderStatusPanels();setStatus('Google 帳號已記住；需要時可按登入重新授權')}
}
async function afterLogin(showToast=true){
  try{
    state.profile=await fetchGoogleProfile();state.authStatus='connected';
    const saved=await getMeta('googleSession',{});await setMeta('googleSession',{token:getAccessToken(),expiresAt:Number(saved?.expiresAt||Date.now()+50*60*1000),profile:state.profile});
    renderStatusPanels();setStatus(`Google：${state.profile.email||state.profile.name}`);
    const joined=await ensureWorkspaceConnection(true);
    if(joined){await syncAll(false);if(state.driveRoot&&state.workspace?.role!=='viewer'){try{await verifyFolder(state.driveRoot);state.driveFolders=await ensureAppFolders(state.driveRoot);$('#driveStatus').textContent='Google Drive 已連線'}catch(e){$('#driveStatus').textContent=`Drive：${friendlyError(e)}`}}}
    else setStatus('Google 已登入；等待加入共享工作區');
    if(showToast)toast(joined?'Google 登入成功，已連線共享工作區':'Google 登入成功，請設定共享資料夾');
  }catch(e){
    console.error(e);
    if(String(e.message).includes('已失效')||e.status===401||String(e.message).includes('401')){setAccessToken('');state.authStatus=state.profile?'remembered':'signedOut';await setMeta('googleSession',{token:'',expiresAt:0,profile:state.profile||null});renderStatusPanels();setStatus('Google 帳號已記住，但授權已到期');if(showToast)toast('Google 授權已到期，請重新授權');return}
    if(showToast)toast(`登入後同步失敗：${friendlyError(e)}`);
  }
}

async function ensureWorkspaceConnection(autoJoin=true){
  if(!getAccessToken())return false;
  try{
    let result=await api('/api/workspace/status');
    if(!result.joined&&autoJoin&&state.driveRoot){
      result=await api('/api/workspace/join',{method:'POST',body:JSON.stringify({drive_root_folder_id:state.driveRoot})});
    }
    if(!result.joined){state.workspace=null;state.workspaceMembers=[];renderStatusPanels();return false}
    const previousId=await getMeta('workspaceSyncId','');
    state.workspace=result.workspace||null;
    if(state.workspace?.drive_root_folder_id){state.driveRoot=state.workspace.drive_root_folder_id;await setMeta('driveRoot',state.driveRoot);$('#driveFolderInput').value=state.driveRoot}
    if(state.workspace?.timezone){$('#timezoneInput').value=state.workspace.timezone;await setMeta('timezone',state.workspace.timezone)}
    if(previousId!==state.workspace?.id){state.lastSync='1970-01-01T00:00:00.000Z';await setMeta('lastSync',state.lastSync);await setMeta('workspaceSyncId',state.workspace?.id||'')}
    await loadWorkspaceMembers();renderStatusPanels();return true;
  }catch(e){
    if(e.message==='WORKSPACE_REQUIRED'){state.workspace=null;state.workspaceMembers=[];renderStatusPanels();return false}
    throw e;
  }
}

async function loadWorkspaceMembers(){
  if(!getAccessToken()||!state.workspace){state.workspaceMembers=[];return}
  try{const r=await api('/api/workspace/members');state.workspaceMembers=r.members||[]}catch(e){console.warn('workspace members failed',e);state.workspaceMembers=[]}
}

async function fetchGoogleProfile(){const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${getAccessToken()}`}});if(!r.ok)throw new Error('Google token 已失效');return r.json()}
async function googleLogout(){const t=getAccessToken();if(t&&window.google?.accounts?.oauth2)google.accounts.oauth2.revoke(t,()=>{});setAccessToken('');sessionStorage.removeItem('googleToken');await setMeta('googleSession',null);state.profile=null;state.authStatus='signedOut';state.workspace=null;state.workspaceMembers=[];renderStatusPanels();setStatus('已登出 Google');toast('已登出')}

async function syncAll(manual=true){
  if(!getAccessToken()){if(manual)toast('請先登入 Google');return}if(!navigator.onLine){if(manual)toast('目前離線');return}
  if(!state.workspace){const joined=await ensureWorkspaceConnection(true);if(!joined){if(manual)toast('請先加入共享工作區');return}}
  $('#syncBtn').disabled=true;setStatus('同步共享資料中…');
  try{
    await flushQueue();const since=await getMeta('lastSync','1970-01-01T00:00:00.000Z');const data=await api(`/api/sync?since=${encodeURIComponent(since)}`);
    for(const e of data.events||[]){await dbPut('events',e);replaceStateItem('events',e)}for(const n of data.notes||[]){await dbPut('notes',n);replaceStateItem('notes',n)}
    if(data.workspace)state.workspace=data.workspace;
    if(data.settings?.drive_root_folder_id){state.driveRoot=data.settings.drive_root_folder_id;await setMeta('driveRoot',state.driveRoot);$('#driveFolderInput').value=state.driveRoot}
    if(data.settings?.timezone){$('#timezoneInput').value=data.settings.timezone;await setMeta('timezone',data.settings.timezone)}
    state.lastSync=data.serverTime||new Date().toISOString();await setMeta('lastSync',state.lastSync);await loadWorkspaceMembers();renderAll();updateSyncLabel();setStatus('共享資料同步完成');if(manual)toast('共享資料同步完成');
  }catch(e){console.error(e);if(e.message==='WORKSPACE_REQUIRED'){state.workspace=null;state.workspaceMembers=[];renderStatusPanels()}setStatus(`同步失敗：${friendlyError(e)}`);if(manual)toast(`同步失敗：${friendlyError(e)}`)}finally{$('#syncBtn').disabled=false}
}
async function saveSettingsRemote(){if(!getAccessToken()||!state.workspace)return;await api('/api/settings',{method:'PUT',body:JSON.stringify({drive_root_folder_id:state.driveRoot||'',timezone:$('#timezoneInput').value.trim()||cfg.DEFAULT_TIMEZONE})})}

async function verifyAndSaveDrive(){
  try{
    if(!getAccessToken())throw new Error('請先登入 Google');
    const id=extractFolderId($('#driveFolderInput').value);if(!id)throw new Error('無法辨識 Google Drive Folder ID');
    setStatus('正在驗證共享工作區與 Google Drive 權限…');
    const joined=await api('/api/workspace/join',{method:'POST',body:JSON.stringify({drive_root_folder_id:id})});
    state.workspace=joined.workspace;state.driveRoot=id;await setMeta('driveRoot',id);$('#driveFolderInput').value=id;
    if(state.workspace?.role!=='viewer'){const info=await verifyFolder(id);state.driveFolders=await ensureAppFolders(id);$('#driveStatus').textContent=`已連線：${info.name} (${id})`}
    else{$('#driveStatus').textContent=`已連線共享資料夾（唯讀） (${id})`}
    state.lastSync='1970-01-01T00:00:00.000Z';await setMeta('lastSync',state.lastSync);await setMeta('workspaceSyncId',state.workspace?.id||'');
    await loadWorkspaceMembers();renderStatusPanels();await saveSettingsRemote();await syncAll(false);
    toast(`已加入共享工作區（${{owner:'擁有者',editor:'可編輯',viewer:'唯讀'}[state.workspace?.role]||state.workspace?.role}）`);setStatus('共享工作區已連線');
  }catch(e){console.error(e);$('#driveStatus').textContent=`失敗：${friendlyError(e)}`;toast(`共享工作區設定失敗：${friendlyError(e)}`)}
}
async function backupNow(){
  try{if(!getAccessToken())throw new Error('請先登入 Google');if(!state.driveRoot)throw new Error('請先設定 Google Drive 共用資料夾');const folders=state.driveFolders||await ensureAppFolders(state.driveRoot);state.driveFolders=folders;const payload={schema:1,appVersion:cfg.VERSION,createdAt:new Date().toISOString(),timezone:$('#timezoneInput').value.trim()||cfg.DEFAULT_TIMEZONE,events:state.events,notes:state.notes,settings:{driveRoot:state.driveRoot}};const stamp=new Date().toISOString().replace(/[:.]/g,'-');await uploadJson(payload,folders.backups.id,`backup-${stamp}.json`);toast('備份已上傳 Google Drive')}catch(e){console.error(e);toast(`備份失敗：${friendlyError(e)}`)}
}
async function restoreLatestBackup(){
  try{
    if(!getAccessToken())throw new Error('請先登入 Google');
    if(!state.driveRoot)throw new Error('請先設定 Google Drive 共用資料夾');
    const folders=state.driveFolders||await ensureAppFolders(state.driveRoot);state.driveFolders=folders;
    const files=await listLatestBackups(folders.backups.id);if(!files.length)throw new Error('Backups 資料夾內沒有備份');
    const latest=files[0];if(!confirm(`要還原最新備份？\n${latest.name}\n目前雲端資料會以此備份內容為準。`))return;
    const data=await downloadJson(latest.id);if(!Array.isArray(data.events)||!Array.isArray(data.notes))throw new Error('備份格式不正確');
    await syncAll(false); // 先拿到最新 revision，避免用舊版本覆寫。
    const currentEvents=new Map(state.events.map(x=>[x.id,x]));const currentNotes=new Map(state.notes.map(x=>[x.id,x]));
    const backupEventIds=new Set(data.events.map(x=>x.id));const backupNoteIds=new Set(data.notes.map(x=>x.id));
    for(const x of state.events.filter(x=>!backupEventIds.has(x.id)))await deleteRemote('events',x);
    for(const x of state.notes.filter(x=>!backupNoteIds.has(x.id)))await deleteRemote('notes',x);
    await dbClear('events');await dbClear('notes');state.events=[];state.notes=[];
    for(const src of data.events){const e={...src,revision:Number(currentEvents.get(src.id)?.revision||0),updated_at:new Date().toISOString(),deleted_at:null};const saved=await saveRemote('events',e);await dbPut('events',saved);state.events.push(saved)}
    for(const src of data.notes){const n={...src,revision:Number(currentNotes.get(src.id)?.revision||0),updated_at:new Date().toISOString(),deleted_at:null};const saved=await saveRemote('notes',n);await dbPut('notes',saved);state.notes.push(saved)}
    state.lastSync=new Date().toISOString();await setMeta('lastSync',state.lastSync);renderAll();updateSyncLabel();toast(`已還原 ${latest.name}`);
  }catch(e){console.error(e);toast(`還原失敗：${friendlyError(e)}`)}
}

async function enableNotifications(){try{if(!getAccessToken())throw new Error('請先登入 Google');await enablePush();renderStatusPanels();toast('通知已啟用')}catch(e){console.error(e);toast(`通知設定失敗：${friendlyError(e)}`)}}
async function sendTestPush(){try{if(Notification.permission!=='granted')throw new Error('請先啟用通知');const r=await testPush();toast(r.sent?`已送出 ${r.sent} 個測試通知`:'沒有可用的 Push Subscription，請重新啟用通知')}catch(e){toast(`測試通知失敗：${friendlyError(e)}`)}}

async function registerServiceWorker(){if('serviceWorker'in navigator){try{await navigator.serviceWorker.register(`./service-worker.js?v=${encodeURIComponent(cfg.VERSION)}`,{scope:'./',updateViaCache:'none'});navigator.serviceWorker.addEventListener('message',ev=>{if(ev.data?.type==='SW_UPDATED')toast('新版本已準備完成')})}catch(e){console.warn('SW registration failed',e)}}}
async function checkUpdate(silent=false){
  try{
    const res=await fetch(`./version.json?t=${Date.now()}`,{cache:'no-store'});const v=await res.json();$('#latestVersion').textContent=v.version||'未知';
    if(v.version&&v.version!==cfg.VERSION){
      const attempted=sessionStorage.getItem('updateAttempted');
      if(attempted===v.version){toast(`版本 ${v.version} 已偵測到，但檔案可能尚未完全更新`);return}
      sessionStorage.setItem('updateAttempted',v.version);toast(`發現新版本 ${v.version}，正在更新…`);await forceUpdate();
    }else{sessionStorage.removeItem('updateAttempted');if(!silent)toast('目前已是最新版本')}
  }catch(e){$('#latestVersion').textContent='檢查失敗';if(!silent)toast('版本檢查失敗')}
}
async function forceUpdate(){
  try{
    // 只處理本 PWA，避免更新或刪除同一 github.io 網域下其他 PWA 的 Service Worker / Cache。
    if('caches'in window){const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('calendar-notes-pwa-')).map(k=>caches.delete(k)))}
    if('serviceWorker'in navigator){
      const reg=await navigator.serviceWorker.register(`./service-worker.js?v=${encodeURIComponent(cfg.VERSION)}&t=${Date.now()}`,{scope:'./',updateViaCache:'none'});
      try{await reg.update()}catch(err){console.warn('Current app SW update skipped',err)}
    }
    sessionStorage.removeItem('updateAttempted');
    const u=new URL(location.href);u.searchParams.set('_refresh',Date.now());location.replace(u.toString());
  }catch(e){toast(`更新失敗：${friendlyError(e)}`)}
}

function handleDeepLink(){const u=new URL(location.href);const kind=u.searchParams.get('open'),id=u.searchParams.get('id');if(kind==='event'&&id){const e=state.events.find(x=>x.id===id);if(e)openEventEditor(e)}if(kind==='note'&&id){const n=state.notes.find(x=>x.id===id);if(n){showView('notes');openNoteEditor(n)}}}
function eventsForDate(key){return state.events.filter(e=>!e.deleted_at&&occursOnDate(e,key))}
function occursOnDate(e,key){
  const start=new Date(e.start_at);if(!e.repeat_rule)return dateKey(start)===key;const target=parseDateKey(key);const base=new Date(start.getFullYear(),start.getMonth(),start.getDate());if(target<base)return false;const days=Math.floor((target-base)/86400000);
  if(e.repeat_rule==='daily')return true;if(e.repeat_rule==='weekly')return days%7===0;if(e.repeat_rule==='monthly')return target.getDate()===base.getDate();if(e.repeat_rule==='yearly')return target.getMonth()===base.getMonth()&&target.getDate()===base.getDate();return false;
}
function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function parseDateKey(k){const [y,m,d]=k.split('-').map(Number);return new Date(y,m-1,d)}
function isoWeekNumber(d){const x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const yearStart=new Date(Date.UTC(x.getUTCFullYear(),0,1));return Math.ceil((((x-yearStart)/86400000)+1)/7)}
function localDateValue(d){const z=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`}
function timeOptionHtml(max,selected){let out='';for(let i=0;i<=max;i++){const v=String(i).padStart(2,'0');out+=`<option value="${v}" ${i===selected?'selected':''}>${v}</option>`}return out}
function dateTime24Html(prefix,label,date,opts={}){
  const valid=date instanceof Date&&!Number.isNaN(date.getTime());
  const allowEmpty=!!opts.allowEmpty;
  const h=valid?date.getHours():Number(opts.defaultHour??0);
  const m=valid?date.getMinutes():Number(opts.defaultMinute??0);
  return `<fieldset class="datetime24-group" data-prefix="${attr(prefix)}"><legend>${esc(label)} <span class="format-24h">24H</span></legend><div class="datetime24-row"><label class="datetime24-date"><span>日期</span><input id="${attr(prefix)}Date" type="date" value="${valid?localDateValue(date):''}" ${allowEmpty?'':'required'}></label><label class="datetime24-time"><span>時</span><select id="${attr(prefix)}Hour" aria-label="${esc(label)} 小時">${timeOptionHtml(23,h)}</select></label><span class="datetime24-colon">:</span><label class="datetime24-time"><span>分</span><select id="${attr(prefix)}Minute" aria-label="${esc(label)} 分鐘">${timeOptionHtml(59,m)}</select></label></div></fieldset>`;
}
function readDateTime24(prefix,opts={}){
  const dateEl=$(`#${prefix}Date`),hourEl=$(`#${prefix}Hour`),minuteEl=$(`#${prefix}Minute`);
  if(!dateEl||!hourEl||!minuteEl)return null;
  const date=String(dateEl.value||'').trim();
  if(!date)return opts.allowEmpty?null:null;
  const h=Number(hourEl.value),m=Number(minuteEl.value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(h)||h<0||h>23||!Number.isInteger(m)||m<0||m>59)return null;
  const [y,mo,day]=date.split('-').map(Number);const d=new Date(y,mo-1,day,h,m,0,0);
  if(d.getFullYear()!==y||d.getMonth()!==mo-1||d.getDate()!==day||d.getHours()!==h||d.getMinutes()!==m)return null;
  return d;
}
function setDateTime24(prefix,d){
  if(!(d instanceof Date)||Number.isNaN(d.getTime()))return;
  const dateEl=$(`#${prefix}Date`),hourEl=$(`#${prefix}Hour`),minuteEl=$(`#${prefix}Minute`);
  if(dateEl)dateEl.value=localDateValue(d);if(hourEl)hourEl.value=String(d.getHours()).padStart(2,'0');if(minuteEl)minuteEl.value=String(d.getMinutes()).padStart(2,'0');
}
function bindDateTime24(prefix,handler){['Date','Hour','Minute'].forEach(suffix=>{const el=$(`#${prefix}${suffix}`);if(el){el.addEventListener('input',handler);el.addEventListener('change',handler)}})}
function bindOptionalDateTime24(prefix){
  const dateEl=$(`#${prefix}Date`),hourEl=$(`#${prefix}Hour`),minuteEl=$(`#${prefix}Minute`);if(!dateEl||!hourEl||!minuteEl)return;
  const sync=()=>{const disabled=!dateEl.value;hourEl.disabled=disabled;minuteEl.disabled=disabled};dateEl.addEventListener('input',sync);dateEl.addEventListener('change',sync);sync();
}
function formatTime(iso){return new Date(iso).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}
function formatDateTime(iso){if(!iso)return'—';return new Date(iso).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}
function formatBytes(n){n=Number(n||0);if(!n)return'';if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function attr(s){return esc(s).replace(/`/g,'&#96;')}
function shorten(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}
function setStatus(s){$('#statusLine').textContent=s}
function updateSyncLabel(){$('#lastSync').textContent=state.lastSync?new Date(state.lastSync).toLocaleString('zh-TW'):'—'}
function toast(s){const t=$('#toast');t.textContent=s;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3200)}
function friendlyError(e){const m=e?.message||String(e);const map={GOOGLE_LOGIN_REQUIRED:'請先登入 Google',UNAUTHORIZED:'Google 授權已失效，請重新登入',REVISION_CONFLICT:'資料已在其他裝置更新，已保留衝突副本',WORKSPACE_REQUIRED:'請先加入共享工作區',WORKSPACE_FOLDER_MISMATCH:'此系統已綁定另一個共享 Google Drive 資料夾，請使用相同的共用資料夾',DRIVE_FOLDER_REQUIRED:'請輸入共享 Google Drive 資料夾',DRIVE_ACCESS_REQUIRED:'目前 Google 帳號沒有這個共享資料夾的存取權限',DRIVE_ACCESS_REVOKED:'此 Google 帳號的共享資料夾權限已被移除',DRIVE_FOLDER_NOT_FOUND:'找不到共享 Google Drive 資料夾',DRIVE_FOLDER_INVALID:'指定位置不是有效的 Google Drive 資料夾',READ_ONLY_MEMBER:'目前帳號是唯讀成員，無法新增、修改或刪除資料'};return map[m]||m.replace(/^DRIVE_\d+:\s*/,'Google Drive：').slice(0,220)}
