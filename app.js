import {initializeStore,setScope,getScope,all,put,getMeta,setMeta,listQueue,applyRemote,replaceSnapshot,readLegacy,migrateLegacy,acknowledge,guestRecords} from './db.js';
import {api,getAccessToken,getSessionToken,saveRemote,deleteRemote,flushQueue} from './api.js';
import {restoreSession,resumeAuthentication,getAuthState,refreshAccess,prepareLogin,login,logout,getAuthConfig} from './auth.js';
import {extractFolderId,ensureAppFolders,getOrCreateItemFolder,uploadFile,uploadJson,listLatestBackups,downloadJson} from './google-drive.js';
import {enablePush,subscriptionState,disconnectPush,testPush} from './push.js';
import {getTaiwanHoliday,TAIWAN_HOLIDAY_OFFICIAL_YEARS} from './holidays.js';
import {occursOn,occurrenceAt,zonedParts,dateKeyInZone,fromZoned,validTimezone} from './recurrence.js';
const cfg=window.APP_CONFIG,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={events:[],notes:[],profile:null,workspace:null,members:[],view:'calendar',filter:'all',selected:'',year:0,month:0,timezone:cfg.DEFAULT_TIMEZONE,driveRoot:'',folders:null,categories:['工作','會議','生活'],editing:null,saving:false,restoring:false,backingUp:false,syncing:false,lastSync:null,authReady:false,authBusy:false};
let connectionPromise=null,syncPromise=null,toastTimer,legacy=null,uploadController=null,pendingRestore=null,registration=null,updatePromise=null,waitingVersion='',draftTimer,lastMembersAt=0;
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const connected=()=>!!(getAccessToken()||getSessionToken());
const canEdit=()=>!state.restoring&&!state.saving&&state.workspace?.role!=='viewer';
const task=fn=>Promise.resolve().then(fn).catch(e=>{console.error(e);toast(friendly(e))});
const formatTime=iso=>new Intl.DateTimeFormat('zh-TW',{timeZone:state.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
const formatDateTime=iso=>iso?new Intl.DateTimeFormat('zh-TW',{timeZone:state.timezone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso)):'—';
const today=()=>dateKeyInZone(new Date(),state.timezone);
const dateKey=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const bytes=n=>Number(n)>1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.ceil(Number(n||0)/1024)} KB`;
function friendly(e){const m=e?.message||String(e);return {GOOGLE_LOGIN_REQUIRED:'Google 授權需要更新，請在設定頁重新登入；本機資料已保留。',UNAUTHORIZED:'Google 授權已到期，請重新登入。',WORKSPACE_REQUIRED:'請先加入共享工作區。',READ_ONLY_MEMBER:'目前帳號為唯讀，無法修改資料。',ACCOUNT_CHANGED:'帳號已切換，已停止上一個帳號的同步。',RESTORE_CONFLICT:'其他成員剛更新資料，還原已中止。請重新預覽備份。',WORKSPACE_FOLDER_MISMATCH:'備份或資料夾屬於另一個共享工作區。',DRIVE_ACCESS_REVOKED:'共用資料夾權限已移除。',SERVER_ERROR:'伺服器未能完成操作。若剛升級，請先完成資料庫升級及 Worker 部署。',INVALID_TIMEZONE:'請輸入有效時區，例如 Asia/Taipei。',GOOGLE_OFFLINE_ACCESS_REQUIRED:'Google 尚未提供持續登入權限，請重新授權一次。',PERSISTENT_AUTH_NOT_CONFIGURED:'自動登入尚未完成伺服器設定。'}[m]||(e?.name==='TimeoutError'?'連線逾時；本機內容已保留，稍後可重試。':e?.name==='AbortError'?'操作已取消；已儲存的文字仍保留。':m);}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),5000)}
function status(message){$('#statusLine').textContent=message}
async function loadLocal(){[state.events,state.notes]=await Promise.all([all('events'),all('notes')]);state.events=state.events.filter(x=>!x.deleted_at);state.notes=state.notes.filter(x=>!x.deleted_at);state.lastSync=await getMeta('lastSyncAt',null);state.categories=await getMeta('categories',['工作','會議','生活']);state.timezone=await getMeta('timezone',cfg.DEFAULT_TIMEZONE);$('#timezoneInput').value=state.timezone;}
function renderAll(){renderCalendar();renderDay();renderNotes();renderSettings();}
async function boot(){
  await initializeStore();legacy=await readLegacy();state.profile=await restoreSession(legacy);
  if(!state.profile)await setScope();
  else if(getScope()==='guest'){
    const root=await getMeta('lastDriveRoot',legacy?.meta.driveRoot||'');await setScope(state.profile.sub,root);await migrateLegacy(legacy,state.profile,root);
  }
  await loadLocal();state.driveRoot=await getMeta('lastDriveRoot',legacy?.meta.driveRoot||'');$('#driveFolderInput').value=state.driveRoot;
  const theme=localStorage.getItem('calendarNotesTheme')||legacy?.meta.theme||'dark';applyTheme(theme);
  const oldStyle=localStorage.getItem('calendarNotesUiStyle');applyStyle(localStorage.getItem('calendarNotesUiStyleV2')||(oldStyle&&oldStyle!=='cartoon-lime'?oldStyle:'mint'));
  state.selected=await getMeta('selectedDate',today());const [y,m]=state.selected.split('-').map(Number);state.year=y;state.month=m;
  $('#currentVersion').textContent=cfg.VERSION;$('#headerVersion').textContent=cfg.VERSION;
  bindUi();renderAll();updateQueueStatus();setupViewport();
  registerWorker().then(()=>checkUpdate(true)).catch(e=>{$('#updateStatus').textContent=friendly(e)});
  prepareLogin().then(()=>{state.authReady=true;renderSettings();if(state.profile&&!connected())task(()=>resumeAutomaticLogin())}).catch(()=>{state.authReady=true;renderSettings()});
  if(state.profile&&connected()&&navigator.onLine)task(()=>resumeAutomaticLogin());
  else status(state.profile?'本機資料已載入；連線後自動同步':'本機模式 · 登入後可同步');
  setInterval(()=>{if(document.visibilityState==='visible'&&connected()&&navigator.onLine&&!state.restoring)task(()=>syncAll(false))},cfg.AUTO_SYNC_INTERVAL_MS);
  addEventListener('online',()=>{status('已連線，準備同步…');task(()=>prepareLogin().finally(()=>{state.authReady=true;renderSettings()}));if(state.profile)task(()=>resumeAutomaticLogin());task(()=>checkUpdate(true))});
  addEventListener('offline',()=>status('離線模式 · 修改保留在此裝置'));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){task(()=>checkUpdate(true));if(state.profile&&navigator.onLine)task(()=>resumeAutomaticLogin())}});
  addEventListener('beforeunload',e=>{if(state.saving||state.restoring){e.preventDefault();e.returnValue=''}});
  openDeepLink(location.href);
}
function bindUi(){
  $$('.nav-btn[data-view]').forEach(b=>b.onclick=()=>showView(b.dataset.view));
  $('#statusBtn').onclick=()=>showView('settings');$('#syncBtn').onclick=()=>task(()=>syncAll(true));
  $('#prevMonthBtn').onclick=()=>changeMonth(-1);$('#nextMonthBtn').onclick=()=>changeMonth(1);$('#todayBtn').onclick=()=>{selectDate(today());const [y,m]=state.selected.split('-').map(Number);state.year=y;state.month=m;renderCalendar()};
  $('#eventSearch').oninput=renderDay;$('#noteSearch').oninput=renderNotes;
  $$('.filter').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;$$('.filter').forEach(x=>x.classList.toggle('active',x===b));renderNotes()});
  $('#addEventBtn').onclick=()=>task(()=>openEditor('events'));$('#addNoteBtn').onclick=()=>task(()=>openEditor('notes'));
  $('#quickAddBtn').onclick=()=>{if(canEdit())$('#quickDialog').showModal()};$('#quickClose').onclick=()=>$('#quickDialog').close();$('#quickDialog').addEventListener('close',activateReadyUpdate);
  $('#quickEvent').onclick=()=>{$('#quickDialog').close();task(()=>openEditor('events'))};$('#quickNote').onclick=()=>{$('#quickDialog').close();task(()=>openEditor('notes'))};
  $('#editorForm').onsubmit=e=>{e.preventDefault();task(saveEditor)};$('#editorCloseBtn').onclick=()=>task(closeEditor);$('#editorCancelBtn').onclick=()=>task(closeEditor);
  $('#editorDialog').addEventListener('cancel',e=>{e.preventDefault();task(closeEditor)});$('#editorDialog').addEventListener('close',()=>{setupViewport();activateReadyUpdate()});
  $('#deleteItemBtn').onclick=()=>task(deleteEditor);$('#cancelUploadBtn').onclick=()=>uploadController?.abort();
  $('#googleLoginBtn').onclick=()=>login(profile=>task(()=>onLogin(profile)),e=>toast(friendly(e)));$('#googleLogoutBtn').onclick=()=>task(signOut);
  $('#verifyDriveBtn').onclick=()=>task(joinFolder);$('#backupBtn').onclick=()=>task(backupNow);$('#restoreBtn').onclick=()=>task(previewCloudRestore);
  $('#exportBtn').onclick=()=>task(()=>downloadBackup(makeBackup(),'calendar-backup'));$('#importBtn').onclick=()=>$('#importFile').click();$('#importFile').onchange=()=>task(async()=>{const file=$('#importFile').files[0];if(!file)return;if(file.size>1500000)throw new Error('備份檔案過大（上限約 1.5 MB）');const data=JSON.parse(await file.text());await previewRestore(data,file.name);$('#importFile').value=''});
  $('#guestImportBtn').onclick=()=>task(importGuest);$('#recoverBtn').onclick=()=>task(recoverRestore);
  $('#restoreCloseBtn').onclick=closeRestore;$('#restoreCancelBtn').onclick=closeRestore;$('#restoreConfirmBtn').onclick=()=>task(confirmRestore);$('#restoreDialog').addEventListener('cancel',e=>{if(state.restoring)e.preventDefault()});
  $('#enablePushBtn').onclick=()=>task(async()=>{if(!state.workspace)throw new Error('WORKSPACE_REQUIRED');await enablePush();await refreshPush();toast('此裝置已啟用通知')});$('#testPushBtn').onclick=()=>task(async()=>{const r=await testPush();toast(r.sent?'推播服務已接受本裝置的測試通知；請確認系統通知。':r.errors?.join('；')||'此裝置尚未訂閱通知');await refreshPush()});$('#refreshPushBtn').onclick=()=>task(refreshPush);
  $$('.theme-option').forEach(b=>b.onclick=()=>applyTheme(b.dataset.themeChoice));$('#uiStyleSelect').onchange=e=>applyStyle(e.target.value);
  $('#addCategoryBtn').onclick=()=>task(addCategory);$('#newCategory').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();task(addCategory)}};
  $('#timezoneInput').onchange=()=>task(async()=>{const tz=$('#timezoneInput').value.trim();if(!validTimezone(tz))throw new Error('INVALID_TIMEZONE');state.timezone=tz;await setMeta('timezone',tz);await savePreferences();renderAll()});
  $('#checkUpdateBtn').onclick=()=>task(()=>checkUpdate(false));$('#forceUpdateBtn').onclick=()=>task(()=>checkUpdate(false,true));
  $('#main').onscroll=()=>$('#toTopBtn').classList.toggle('hidden',$('#main').scrollTop<300);$('#toTopBtn').onclick=()=>$('#main').scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  let touch=null;$('#monthGrid').addEventListener('touchstart',e=>{if(e.touches.length===1)touch={x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});$('#monthGrid').addEventListener('touchend',e=>{if(!touch)return;const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;touch=null;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)changeMonth(dx<0?1:-1)},{passive:true});
}
function applyTheme(theme){const value=theme==='light'?'light':'dark';document.documentElement.dataset.theme=value;localStorage.setItem('calendarNotesTheme',value);document.querySelector('meta[name="theme-color"]').content=value==='light'?'#f3f7f6':'#111a24';$$('.theme-option').forEach(b=>b.classList.toggle('active',b.dataset.themeChoice===value))}
function applyStyle(style){if(![...$('#uiStyleSelect').options].some(o=>o.value===style))style='mint';document.documentElement.dataset.uiStyle=style;$('#uiStyleSelect').value=style;localStorage.setItem('calendarNotesUiStyleV2',style)}
function showView(name){if(!['calendar','notes','settings'].includes(name))return;state.view=name;document.body.dataset.view=name;$$('.view').forEach(x=>x.classList.toggle('active',x.id===name+'View'));$$('.nav-btn[data-view]').forEach(x=>{x.classList.toggle('active',x.dataset.view===name);if(x.dataset.view===name)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current')});$('#main').scrollTop=0;$('#toTopBtn').classList.add('hidden');if(name==='settings')task(refreshPush)}
function changeMonth(delta){const d=new Date(Date.UTC(state.year,state.month-1+delta,1));state.year=d.getUTCFullYear();state.month=d.getUTCMonth()+1;const wanted=Number(state.selected.slice(8));selectDate(dateKey(state.year,state.month,Math.min(wanted,new Date(Date.UTC(state.year,state.month,0)).getUTCDate())))}
function selectDate(key){state.selected=key;setMeta('selectedDate',key).catch(()=>{});renderCalendar();renderDay()}
function isoWeek(d){const t=new Date(d);const n=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-n);return Math.ceil(((t-Date.UTC(t.getUTCFullYear(),0,1))/86400000+1)/7)}
function eventsOn(key){return state.events.filter(e=>occursOn(e,key,state.timezone))}
function renderCalendar(){
  if(!state.year)return;$('#monthLabel').textContent=`${state.year} 年 ${state.month} 月`;$('#holidayHint').textContent=TAIWAN_HOLIDAY_OFFICIAL_YEARS.includes(state.year)?'假日以綠色標示':'此年份僅顯示固定日期假日';
  const first=new Date(Date.UTC(state.year,state.month-1,1)),start=new Date(first);start.setUTCDate(1-first.getUTCDay());const fragment=document.createDocumentFragment(),weeks=document.createDocumentFragment();
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setUTCDate(start.getUTCDate()+i);const key=d.toISOString().slice(0,10),items=eventsOn(key),holiday=getTaiwanHoliday(key),button=document.createElement('button');
    button.type='button';button.className=['day-cell',d.getUTCMonth()+1!==state.month?'muted':'',[0,6].includes(d.getUTCDay())?'weekend':'',key===today()?'today':'',key===state.selected?'selected':'',holiday?'holiday':''].filter(Boolean).join(' ');button.setAttribute('aria-label',`${key}${holiday?' '+holiday.name:''}，${items.length} 個行程`);button.setAttribute('aria-pressed',String(key===state.selected));
    button.innerHTML=`<span class="day-num">${d.getUTCDate()}</span><div class="day-content">${holiday?`<span class="holiday-chip" title="${esc(holiday.name)}">${esc(holiday.name)}</span>`:''}${items.slice(0,2).map(e=>`<span class="event-dot">${e.all_day?'':formatTime(e.start_at)+' '}${esc(e.title)}</span>`).join('')}${items.length>2?`<span class="more-dot">＋${items.length-2}</span>`:''}</div><span class="mobile-dots">${items.slice(0,3).map(()=>'<i></i>').join('')}</span>`;
    button.onclick=()=>selectDate(key);fragment.append(button);
    if(i%7===0){const marker=new Date(d);marker.setUTCDate(marker.getUTCDate()+4);const week=document.createElement('span');week.className='week-number';week.textContent=isoWeek(marker);weeks.append(week)}
  }
  $('#monthGrid').replaceChildren(fragment);$('#weekNumbers').replaceChildren(weeks);
}
function renderDay(){
  if(!state.selected)return;const d=new Date(state.selected+'T12:00:00Z'),q=$('#eventSearch').value.trim().toLowerCase();$('#selectedDateLabel').textContent=`${Number(state.selected.slice(5,7))}/${Number(state.selected.slice(8))} 星期${'日一二三四五六'[d.getUTCDay()]}`;
  const items=(q?state.events.filter(e=>`${e.title} ${e.description} ${e.location}`.toLowerCase().includes(q)):eventsOn(state.selected)).sort((a,b)=>a.start_at.localeCompare(b.start_at));$('#daySummary').textContent=`${q?'搜尋結果':'當日事項'} ${items.length}`;
  const box=$('#dayEvents');box.replaceChildren();if(!items.length){box.innerHTML=`<div class="empty-state">${icon('calendar')}${q?'找不到符合的行程':'這天沒有行程'}${q?'':'<br><button class="secondary" id="emptyAddEvent">新增行程</button>'}</div>`;$('#emptyAddEvent')?.addEventListener('click',()=>task(()=>openEditor('events')));return;}
  for(const e of items){const b=document.createElement('button');b.className='list-item';b.innerHTML=`<span class="event-time">${e.all_day?'全天':formatTime(e.start_at)}</span><div class="grow"><h4>${e.completed?'✓ ':''}${esc(e.title)}</h4><div class="meta">${q?formatDateTime(e.start_at)+' ':''}${esc(e.location||e.category||'')}${e.repeat_rule?' · 重複行程':''}</div>${e.description?`<p class="snippet">${esc(e.description.slice(0,100))}</p>`:''}<div class="item-icons">${e.reminder_minutes?.length?icon('bell'):''}${e.attachment_meta?.length?icon('clip')+`<span class="meta">${e.attachment_meta.length}</span>`:''}</div></div>`;b.onclick=()=>task(()=>openEditor('events',e));box.append(b)}
}
function renderNotes(){
  const q=$('#noteSearch').value.trim().toLowerCase();let items=state.notes.filter(n=>`${n.title} ${n.content} ${(n.tags||[]).join(' ')}`.toLowerCase().includes(q));items=items.filter(n=>state.filter==='all'||state.filter==='open'&&!n.completed||state.filter==='completed'&&n.completed||state.filter==='pinned'&&n.pinned).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at));$('#notesSummary').textContent=`${state.notes.filter(n=>!n.completed).length} 個未完成 · ${state.notes.length} 則備註`;
  const box=$('#notesList');box.replaceChildren();if(!items.length){box.innerHTML=`<div class="empty-state">${icon('note')}${q?'找不到符合的備註':'此分類尚無備註'}</div>`;return;}
  for(const n of items){const card=document.createElement('article');card.className='note-card'+(n.completed?' completed':'');card.innerHTML=`<button class="note-open"><h4>${n.pinned?'⌖ ':''}${esc(n.title)}</h4><div class="snippet">${esc(n.content?.slice(0,180)||'')}</div><div class="tags">${[n.category,...(n.tags||[])].filter(Boolean).slice(0,5).map(t=>`<span class="badge">${esc(t)}</span>`).join('')}</div></button><div class="note-footer"><span class="meta">${n.reminder_at?icon('bell')+' '+formatDateTime(n.reminder_at):formatDateTime(n.updated_at)}${n.attachment_meta?.length?' · 附件 '+n.attachment_meta.length:''}</span><button class="note-done" aria-label="${n.completed?'標記未完成':'標記完成'}" aria-pressed="${n.completed}">${n.completed?icon('check'):'○'}</button></div>`;
    card.querySelector('.note-open').onclick=()=>task(()=>openEditor('notes',n));card.querySelector('.note-done').disabled=!canEdit();card.querySelector('.note-done').onclick=()=>task(async()=>{if(!canEdit())return;await saveRemote('notes',{...n,completed:!n.completed,updated_at:new Date().toISOString()});await loadLocal();renderAll();updateQueueStatus();if(connected())task(()=>syncAll(false))});box.append(card)}
}
function renderSettings(){
  const p=state.profile,auth=getAuthState(),active=connected(),automatic=auth.persistent||auth.phase==='legacy-auto',retrying=auth.phase==='temporarily-unavailable'||auth.phase==='offline';$('#googleIdentityCard').classList.toggle('hidden',!p);$('#googleLoginBtn').classList.toggle('hidden',!!p&&active);$('#googleLogoutBtn').classList.toggle('hidden',!p);$('#googleLoginBtn').textContent=p?'重新授權 Google':'首次連線 Google';
  if(p){$('#googleIdentityName').textContent=p.name||p.email;$('#googleIdentityEmail').textContent=p.email||'';$('#googleIdentityBadge').textContent=state.authBusy?'登入中':retrying?'待重試':active?(automatic?'自動登入':'已連線'):'需授權';$('#googleAvatarFallback').textContent=(p.name||p.email||'G')[0];$('#navAvatar').textContent=(p.name||p.email||'G')[0];$('#navName').textContent=p.name||'Google 使用者'}else{$('#navAvatar').textContent='○';$('#navName').textContent='本機模式'}
  $('#googleStatus').textContent=state.authBusy?'正在背景恢復 Google 登入與共享資料…':retrying?'目前離線或服務暫時無法連線；稍後會自動重試。':p?(active?'帳號已連線，資料會在背景同步。':'授權已失效；本機資料仍保留。'):'首次使用需完成一次 Google 授權。';
  const expiryText=auth.sessionExpiresAt?` · 閒置期限 ${formatDateTime(new Date(auth.sessionExpiresAt))}`:'';
  $('#autoLoginStatus').textContent=auth.persistent?`伺服器自動登入已啟用${expiryText}`:auth.phase==='legacy-auto'?'已透過瀏覽器的 Google 工作階段自動登入，不需要再按重新授權。':!state.authReady?'正在檢查自動登入設定…':auth.serverReady?(p?'正在改用現有 Google 工作階段自動連線。':'自動登入服務已就緒；首次連線後會自動保持登入。'):auth.configAvailable?'已啟用瀏覽器工作階段自動登入；伺服器長效登入設定見 DEPLOY.md。':'暫時無法確認自動登入服務，恢復連線後會重試。';
  $('#workspaceStatus').textContent=state.workspace?`${state.workspace.name||'共享行事曆'} · ${{owner:'擁有者',editor:'可編輯',viewer:'唯讀'}[state.workspace.role]||''} · ${state.members.length||'—'} 位成員`:'登入後可加入共享工作區。';
  $('#workspaceMembers').innerHTML=state.members.map(m=>`<div class="workspace-member">${esc(m.name||m.email)}<small>${esc(m.email)} · ${{owner:'擁有者',editor:'編輯者',viewer:'唯讀'}[m.role]||''}</small></div>`).join('');$('#driveStatus').textContent=state.workspace?'共享資料夾已連線':state.driveRoot?'已記住資料夾，等待連線確認':'';$('#lastSync').textContent=formatDateTime(state.lastSync);
  ['quickAddBtn','addEventBtn','addNoteBtn','saveItemBtn','deleteItemBtn','restoreBtn','addCategoryBtn'].forEach(id=>$('#'+id).disabled=!canEdit());$('#backupBtn').disabled=state.backingUp||state.saving||state.restoring||state.workspace?.role==='viewer';$('#syncBtn').disabled=state.syncing||state.restoring;$('#timezoneInput').disabled=state.workspace?.role==='viewer';renderCategories();
}
function renderCategories(){const box=$('#categoryList');box.innerHTML=state.categories.map((c,i)=>`<span class="category-chip">${esc(c)}<button data-category="${i}" aria-label="移除 ${esc(c)} 分類">×</button></span>`).join('');box.querySelectorAll('button').forEach(b=>{b.disabled=!canEdit();b.onclick=()=>task(async()=>{state.categories.splice(Number(b.dataset.category),1);await setMeta('categories',state.categories);renderCategories();await savePreferences()})})}
async function addCategory(){if(!canEdit())return;const value=$('#newCategory').value.trim();if(!value)return;if(state.categories.includes(value)){toast('此分類已存在');return}state.categories.push(value.slice(0,40));$('#newCategory').value='';await setMeta('categories',state.categories);renderCategories();await savePreferences()}
async function savePreferences(){await setMeta('preferencesPending',true);if(connected()&&state.workspace){await api('/api/settings',{method:'PUT',body:JSON.stringify({timezone:state.timezone,categories:state.categories})});await setMeta('preferencesPending',false);toast('設定已同步')}else await setMeta('preferencesPending',true)}
async function updateQueueStatus(){const q=await listQueue();$('#queueCount').textContent=q.length;const box=$('#queueErrors');box.replaceChildren();for(const op of q.filter(x=>x.error).slice(0,5)){const p=document.createElement('p');p.textContent=`${op.item.title}：${friendly(new Error(op.error))}`;box.append(p);if(op.server){const keep=document.createElement('button');keep.textContent='保留雲端版本';keep.className='secondary';keep.onclick=()=>task(async()=>{await acknowledge(op,op.server);await loadLocal();renderAll();updateQueueStatus()});box.append(keep)}}return q.length;}
function timeOptions(max,value){return Array.from({length:max+1},(_,i)=>`<option value="${i}"${i===value?' selected':''}>${String(i).padStart(2,'0')}</option>`).join('')}
function dateTimeHtml(prefix,label,value,optional=false){const p=value?zonedParts(value,state.timezone):null;return `<section class="dt24-block"><div class="dt24-title">${label}<span class="format-24h">24 小時制</span></div><div class="dt24-date-field"><label for="${prefix}Date" class="dt24-label">日期${optional?'（可留空）':''}</label><input id="${prefix}Date" type="date" value="${p?dateKey(p.year,p.month,p.day):''}" ${optional?'':'required'}></div><div class="dt24-time-row"><div class="dt24-time-field"><label for="${prefix}Hour" class="dt24-label">時</label><select id="${prefix}Hour" aria-label="${label} 小時">${timeOptions(23,p?.hour??9)}</select></div><span class="dt24-colon">:</span><div class="dt24-time-field"><label for="${prefix}Minute" class="dt24-label">分</label><select id="${prefix}Minute" aria-label="${label} 分鐘">${timeOptions(59,p?.minute??0)}</select></div></div></section>`}
function readDateTime(prefix,optional=false){const value=$('#'+prefix+'Date').value;if(!value&&optional)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('請設定有效日期');const [year,month,day]=value.split('-').map(Number);const d=fromZoned({year,month,day,hour:Number($('#'+prefix+'Hour').value),minute:Number($('#'+prefix+'Minute').value),second:0},state.timezone);if(!d)throw new Error('此時間在指定時區不存在，請調整日期或時間');return d.toISOString()}
function setDateTime(prefix,value){const p=zonedParts(value,state.timezone);$('#'+prefix+'Date').value=dateKey(p.year,p.month,p.day);$('#'+prefix+'Hour').value=p.hour;$('#'+prefix+'Minute').value=p.minute;}
function categoryHtml(value=''){return `<label for="fCategory">分類</label><div class="input-action"><input id="fCategory" list="categoryOptions" value="${esc(value)}" maxlength="40" placeholder="搜尋或輸入分類"><button id="editorNewCategory" type="button" class="secondary" aria-label="加入分類">＋</button></div><datalist id="categoryOptions">${state.categories.map(c=>`<option value="${esc(c)}"></option>`).join('')}</datalist>`}
function safeAttachmentUrl(a){return /^[A-Za-z0-9_-]+$/.test(a.id||'')?`https://drive.google.com/file/d/${a.id}/view`:'#';}
function attachmentsHtml(items){return `<div class="attachment-list" id="editorAttachments">${items.map(a=>`<div class="attachment">${icon('clip')}<a href="${safeAttachmentUrl(a)}" target="_blank" rel="noopener noreferrer">${esc(a.name||'附件')}</a><span class="meta">${bytes(a.size)}</span></div>`).join('')}</div><label for="fFiles">新增照片／附件</label><input class="upload-input" id="fFiles" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"><p class="hint">文字先儲存；附件需要登入並連線。中斷時可重試。</p>`}
async function openEditor(kind,item=null){
  if(state.restoring||state.saving)return;
  let draft=item?null:await getMeta('draft:'+kind,null);const restored=!!draft;if(draft)item=draft;
  const now=zonedParts(new Date(),state.timezone),[year,month,day]=state.selected.split('-').map(Number);const start=fromZoned({year,month,day,hour:now.hour,minute:now.minute,second:0},state.timezone)||new Date();
  const value=item?structuredClone(item):{id:crypto.randomUUID(),title:'',start_at:start.toISOString(),end_at:new Date(start.getTime()+3600000).toISOString(),reminder_minutes:[0],attachment_meta:[],created_at:new Date().toISOString(),revision:0};
  state.editing={kind,item:value,existing:state[kind].some(x=>x.id===value.id),dirty:false};$('#editorTitle').textContent=(state.editing.existing?'編輯':'新增')+(kind==='events'?'行程':'備註');$('#saveItemBtn').textContent=kind==='events'?'儲存行程':'儲存備註';$('#deleteItemBtn').classList.toggle('hidden',!state.editing.existing);
  let content=`<label for="fTitle">標題</label><input id="fTitle" maxlength="300" required value="${esc(value.title)}" placeholder="${kind==='events'?'行程名稱':'備註標題'}">`;
  if(kind==='events')content+=`<div class="check-row"><label><input id="fAllDay" type="checkbox" ${value.all_day?'checked':''}>全天</label><label><input id="fCompleted" type="checkbox" ${value.completed?'checked':''}>已完成</label></div>${dateTimeHtml('fStart','開始',value.start_at)}${dateTimeHtml('fEnd','結束',value.all_day&&value.end_at?new Date(Date.parse(value.end_at)-1).toISOString():(value.end_at||new Date(Date.parse(value.start_at)+3600000).toISOString()))}${categoryHtml(value.category)}<label>提醒</label><div class="check-row">${[[0,'準時'],[10,'10 分鐘前'],[60,'1 小時前'],[1440,'1 天前'],[10080,'1 週前']].map(([n,t])=>`<label><input type="checkbox" name="reminder" value="${n}" ${(value.reminder_minutes||[]).includes(n)?'checked':''}>${t}</label>`).join('')}</div><details class="editor-section" ${value.repeat_rule||value.location||value.description?'open':''}><summary>更多選項</summary><label for="fRepeat">重複</label><select id="fRepeat"><option value="">不重複</option><option value="daily">每天</option><option value="weekly">每週</option><option value="monthly">每月</option><option value="yearly">每年</option></select><label for="fLocation">地點</label><input id="fLocation" maxlength="500" value="${esc(value.location)}"><label for="fDescription">說明</label><textarea id="fDescription" maxlength="30000">${esc(value.description)}</textarea></details>`;
  else content+=`<label for="fContent">內容</label><textarea id="fContent" maxlength="60000" rows="6">${esc(value.content)}</textarea>${categoryHtml(value.category)}<label for="fTags">標籤（以逗號分隔）</label><input id="fTags" value="${esc((value.tags||[]).join(', '))}"><div class="check-row"><label><input id="fPinned" type="checkbox" ${value.pinned?'checked':''}>置頂</label><label><input id="fCompleted" type="checkbox" ${value.completed?'checked':''}>已完成</label></div>${dateTimeHtml('fReminderAt','提醒時間',value.reminder_at,true)}`;
  $('#editorFields').innerHTML=content+attachmentsHtml(value.attachment_meta||[]);$('#uploadPanel').classList.add('hidden');
  $('#editorNewCategory').onclick=()=>task(async()=>{const c=$('#fCategory').value.trim();if(!c)return;if(!state.categories.includes(c)){state.categories.push(c);await setMeta('categories',state.categories);renderCategories();await savePreferences();$('#categoryOptions').innerHTML=state.categories.map(c=>`<option value="${esc(c)}"></option>`).join('');toast('已加入分類')}});
  if(kind==='events'){
    $('#fRepeat').value=value.repeat_rule||'';let autoEnd=!state.editing.existing;
    for(const suffix of ['Date','Hour','Minute']){$('#fStart'+suffix).addEventListener('change',()=>{if(autoEnd){try{setDateTime('fEnd',new Date(Date.parse(readDateTime('fStart'))+3600000))}catch{}}});$('#fEnd'+suffix).addEventListener('change',()=>{autoEnd=false})}
    const toggle=()=>{const checked=$('#fAllDay').checked;for(const prefix of ['fStart','fEnd'])for(const part of ['Hour','Minute'])$('#'+prefix+part).disabled=checked};$('#fAllDay').onchange=toggle;toggle();
  }
  $('#editorFields').oninput=()=>{state.editing.dirty=true;clearTimeout(draftTimer);draftTimer=setTimeout(()=>{task(persistDraft)},350)};
  if(state.workspace?.role==='viewer')$('#editorFields').querySelectorAll('input,textarea,select,button').forEach(x=>x.disabled=true);
  renderSettings();setupViewport();$('#editorDialog').showModal();$('#editorFields').scrollTop=0;if(restored)toast('已載入上次未完成的草稿');
}
function readEditor(validate=true){
  const ed=state.editing;if(!ed)return null;const title=$('#fTitle').value.trim();if(validate&&!title)throw new Error('請輸入標題');const item={...ed.item,title,category:$('#fCategory').value.trim(),completed:$('#fCompleted').checked,updated_at:new Date().toISOString(),deleted_at:null};
  if(ed.kind==='events'){
    item.start_at=readDateTime('fStart');item.end_at=readDateTime('fEnd');item.all_day=$('#fAllDay').checked;
    if(item.all_day){const a=zonedParts(item.start_at,state.timezone),b=zonedParts(item.end_at,state.timezone);const dayEnd=new Date(Date.UTC(b.year,b.month-1,b.day+1));item.start_at=fromZoned({...a,hour:0,minute:0,second:0},state.timezone).toISOString();item.end_at=fromZoned({year:dayEnd.getUTCFullYear(),month:dayEnd.getUTCMonth()+1,day:dayEnd.getUTCDate(),hour:0,minute:0,second:0},state.timezone).toISOString();}
    if(validate&&item.end_at<item.start_at)throw new Error('結束時間不可早於開始時間');item.repeat_rule=$('#fRepeat').value;item.location=$('#fLocation').value;item.description=$('#fDescription').value;item.reminder_minutes=$$('input[name="reminder"]:checked').map(x=>Number(x.value));
  }else {item.content=$('#fContent').value;item.tags=$('#fTags').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);item.pinned=$('#fPinned').checked;item.reminder_at=readDateTime('fReminderAt',true)}
  return item;
}
async function persistDraft(){if(!state.editing||!state.editing.dirty||state.saving)return;try{const item=readEditor(false);await setMeta('draft:'+state.editing.kind,item)}catch{/* Invalid partial time fields stay visible until corrected. */}}
async function closeEditor(){if(state.saving){toast('正在儲存；可先取消附件上傳');return;}clearTimeout(draftTimer);await persistDraft();state.editing=null;document.activeElement?.blur();$('#editorDialog').close()}
async function saveEditor(){
  if(!canEdit()||!state.editing)return;const ed=state.editing;let item=readEditor(),textSaved=false;const files=[...$('#fFiles').files];state.saving=true;renderSettings();$('#editorCloseBtn').disabled=true;$('#editorCancelBtn').disabled=true;
  try{
    item=await saveRemote(ed.kind,item);textSaved=true;ed.item=item;ed.existing=true;ed.dirty=false;await setMeta('draft:'+ed.kind,item);await loadLocal();renderAll();
    if(files.length){
      if(!navigator.onLine||!connected()||!state.workspace)throw new Error('文字已儲存；附件請在登入、連線並加入共享工作區後重試。');
      state.folders=state.folders||await ensureAppFolders(state.driveRoot);const folder=await getOrCreateItemFolder(state.folders.attachments.id,item.id);uploadController=new AbortController();$('#uploadPanel').classList.remove('hidden');
      for(let i=0;i<files.length;i++){
        $('#uploadStatus').textContent=`${i+1}/${files.length} ${files[i].name}`;
        const result=await uploadFile(files[i],folder.id,files[i].name,{signal:uploadController.signal,onProgress:(loaded,total)=>$('#uploadProgress').value=total?loaded/total*100:0});
        item.attachment_meta.push({id:result.id,name:result.name,mimeType:result.mimeType,size:Number(result.size||files[i].size),webViewLink:result.webViewLink||'',createdTime:result.createdTime||new Date().toISOString()});
        item=await saveRemote(ed.kind,item);ed.item=item;await setMeta('draft:'+ed.kind,item);
      }
    }
    await setMeta('draft:'+ed.kind,null);state.editing=null;document.activeElement?.blur();$('#editorDialog').close();toast(connected()?'已儲存，準備同步':'已儲存在此裝置');
  }catch(e){toast(textSaved?`文字已儲存。${friendly(e)}`:friendly(e));if(textSaved){$('#fFiles').value='';$('#editorAttachments').innerHTML=(item.attachment_meta||[]).map(a=>`<div class="attachment">${icon('clip')}<a href="${safeAttachmentUrl(a)}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a></div>`).join('')}}
  finally{state.saving=false;uploadController=null;$('#uploadPanel').classList.add('hidden');$('#editorCloseBtn').disabled=false;$('#editorCancelBtn').disabled=false;await loadLocal();renderAll();await updateQueueStatus();if(connected())task(()=>syncAll(false));activateReadyUpdate()}
}
async function deleteEditor(){if(!canEdit()||!state.editing?.existing)return;const ed=state.editing;if(!confirm(`刪除「${ed.item.title}」？已上傳的 Drive 附件會保留。`))return;await deleteRemote(ed.kind,ed.item);await setMeta('draft:'+ed.kind,null);ed.dirty=false;await closeEditor();await loadLocal();renderAll();updateQueueStatus();toast('刪除已儲存，連線後同步');if(connected())task(()=>syncAll(false))}
let autoLoginPromise=null;
async function resumeAutomaticLogin(){
  if(autoLoginPromise)return autoLoginPromise;
  if(!state.profile){renderSettings();return}
  if(!navigator.onLine){status('離線模式 · 已載入帳號本機資料');renderSettings();return}
  autoLoginPromise=(async()=>{
    state.authBusy=true;status('正在自動登入…');renderSettings();
    try{const profile=await resumeAuthentication();if(profile)state.profile=profile;renderSettings();await connectWorkspace(false)}
    catch(e){console.error('automatic sign-in failed',e);renderSettings();status(e.status===401?'Google 授權需要更新 · 本機資料已保留':'自動登入暫時無法連線 · 稍後會重試')}
    finally{state.authBusy=false;renderSettings();autoLoginPromise=null}
  })();return autoLoginPromise;
}
async function onLogin(profile){
  if(syncPromise)await syncPromise.catch(()=>{});if(state.saving||state.restoring)return;
  state.profile=profile;state.workspace=null;state.folders=null;state.members=[];
  await setScope(profile.sub,state.driveRoot);await loadLocal();renderAll();await connectWorkspace(true);
}
async function connectWorkspace(showToast=false){
  if(connectionPromise)return connectionPromise;
  connectionPromise=connectWorkspaceInner(showToast).finally(()=>{connectionPromise=null});return connectionPromise;
}
async function connectWorkspaceInner(showToast=false){
  if(!connected()||!navigator.onLine)return;status('正在連線共享工作區…');await refreshAccess();
  let response=await api('/api/workspace/status');if(!response.joined&&state.driveRoot)response=await api('/api/workspace/join',{method:'POST',body:JSON.stringify({drive_root_folder_id:state.driveRoot})});
  if(!response.joined){state.workspace=null;status('Google 已連線 · 請設定共享資料夾');renderSettings();return;}
  state.workspace=response.workspace;state.driveRoot=response.workspace.drive_root_folder_id;state.folders=null;await setMeta('lastDriveRoot',state.driveRoot);$('#driveFolderInput').value=state.driveRoot;
  await setScope(state.profile.sub,state.driveRoot);await migrateLegacy(legacy,state.profile,state.driveRoot);await loadLocal();
  if(response.workspace.timezone){state.timezone=response.workspace.timezone;await setMeta('timezone',state.timezone)}
  renderAll();await syncAll(false);await resumePush();if(!state.editing)task(()=>openDeepLink(location.href));if(showToast)toast('Google 已連線，共享資料已同步');
}
async function joinFolder(){
  if(state.saving||state.restoring||state.backingUp)throw new Error('請等待目前的儲存、還原或備份完成');
  if(!connected())throw new Error('GOOGLE_LOGIN_REQUIRED');if(syncPromise)await syncPromise;
  const root=extractFolderId($('#driveFolderInput').value);if(!root)throw new Error('請貼上有效的 Google Drive 共用資料夾連結');
  const r=await api('/api/workspace/join',{method:'POST',body:JSON.stringify({drive_root_folder_id:root})});if(!r.joined)throw new Error('未能加入共享工作區');state.driveRoot=root;state.workspace=null;await setMeta('lastDriveRoot',root);await connectWorkspace(true);
}
async function signOut(){
  if(state.saving||state.restoring||state.backingUp){toast('請等待目前的儲存、還原或備份完成');return}if(syncPromise)await syncPromise.catch(()=>{});
  const count=await updateQueueStatus();if(count&&!confirm(`尚有 ${count} 個項目未同步。登出會保留在此帳號的本機資料區，下次登入同帳號才會繼續同步。確定登出？`))return;
  await disconnectPush().catch(()=>{});await logout();state.profile=null;state.workspace=null;state.members=[];state.folders=null;await setScope();await loadLocal();renderAll();await updateQueueStatus();status('已登出 · 本機模式');
}
async function syncAll(manual=false){
  if(syncPromise)return syncPromise;if(state.restoring)return;
  if(connected()&&navigator.onLine&&!state.workspace)return connectWorkspace(manual);
  syncPromise=(async()=>{
    if(!connected()){if(manual)throw new Error('GOOGLE_LOGIN_REQUIRED');return}if(!navigator.onLine){if(manual)toast('目前離線，修改會保留在此裝置');return}
    state.syncing=true;renderSettings();status('正在同步…');
    try{
      await refreshAccess();const result=await flushQueue();const since=await getMeta('lastSync',null);const data=await api(`/api/sync${since!==null?'?since='+encodeURIComponent(since):''}`);
      await applyRemote(data.events||[],data.notes||[],data.cursor??data.serverTime);await setMeta('lastSyncAt',data.serverTime);
      const prefsPending=await getMeta('preferencesPending',false);
      if(!prefsPending&&data.settings?.timezone){state.timezone=data.settings.timezone;await setMeta('timezone',state.timezone)}
      if(prefsPending&&canEdit()){await savePreferences();await setMeta('preferencesPending',false)}else if(data.settings?.categories){state.categories=data.settings.categories;await setMeta('categories',state.categories)}
      if(data.workspace)state.workspace=data.workspace;
      if(Date.now()-lastMembersAt>300000){const members=await api('/api/workspace/members');state.members=members.members||[];lastMembersAt=Date.now()}
      await loadLocal();renderAll();const remaining=await updateQueueStatus();status(remaining?`已儲存 · ${remaining} 項待處理`:'已同步');if(manual)toast(result.conflicts?'已保留衝突副本，請查看同步狀態。':remaining?`${remaining} 個項目待同步或處理衝突`:'同步完成');
    }catch(e){status('同步未完成 · 本機修改已保留');await updateQueueStatus();renderSettings();throw e}
    finally{state.syncing=false;renderSettings();}
  })().finally(()=>{syncPromise=null});return syncPromise;
}
function makeBackup(){return {schema:2,appVersion:cfg.VERSION,createdAt:new Date().toISOString(),timezone:state.timezone,events:state.events,notes:state.notes,settings:{driveRoot:state.workspace?state.driveRoot:'',categories:state.categories}}}
function downloadBackup(data,prefix){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${prefix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
async function backupNow(){
  if(state.backingUp)return;
  if(!state.workspace)throw new Error('WORKSPACE_REQUIRED');state.backingUp=true;$('#backupBtn').disabled=true;$('#backupStatus').textContent='正在確認同步與備份內容…';
  try{await syncAll(false);if((await listQueue()).length)throw new Error('尚有待同步或衝突項目，請先處理後再備份。');state.folders=state.folders||await ensureAppFolders(state.driveRoot);await uploadJson(makeBackup(),state.folders.backups.id,`backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);$('#backupStatus').textContent='備份已上傳 Google Drive · '+formatDateTime(new Date());toast('備份完成')}finally{state.backingUp=false;$('#backupBtn').disabled=false;activateReadyUpdate()}
}
function validateBackup(data){if(!data||![1,2].includes(data.schema)||!Array.isArray(data.events)||!Array.isArray(data.notes))throw new Error('備份格式不正確');if(data.events.length+data.notes.length>2000)throw new Error('單次還原最多 2,000 筆記錄');for(const kind of ['events','notes']){const ids=new Set();for(const x of data[kind]){if(!x||typeof x.id!=='string'||!x.id||typeof x.title!=='string'||!x.title.trim()||ids.has(x.id))throw new Error('備份有無效或重複的記錄');ids.add(x.id);if(kind==='events'&&!Number.isFinite(Date.parse(x.start_at)))throw new Error('備份含無效行程日期');if(x.end_at&&!Number.isFinite(Date.parse(x.end_at))||x.reminder_at&&!Number.isFinite(Date.parse(x.reminder_at)))throw new Error('備份含無效提醒日期')}}}
async function previewCloudRestore(){if(!state.workspace)throw new Error('WORKSPACE_REQUIRED');state.folders=state.folders||await ensureAppFolders(state.driveRoot);const backups=await listLatestBackups(state.folders.backups.id);if(!backups.length)throw new Error('尚未找到備份');if(Number(backups[0].size)>1500000)throw new Error('備份超過安全還原上限（約 1.5 MB）');const data=await downloadJson(backups[0].id);await previewRestore(data,backups[0].name)}
async function previewRestore(data,name){
  if(!canEdit())return;validateBackup(data);if(state.workspace&&data.settings?.driveRoot&&data.settings.driveRoot!==state.driveRoot)throw new Error('WORKSPACE_FOLDER_MISMATCH');
  let snapshot=null;if(state.workspace){await syncAll(false);if((await listQueue()).length)throw new Error('請先處理待同步項目後再還原');snapshot=await api('/api/snapshot')}
  pendingRestore={data,name,generation:snapshot?.generation,scope:getScope()};const old=new Set([...state.events,...state.notes].map(x=>x.id)),items=[...data.events,...data.notes].filter(x=>!x.deleted_at),ids=new Set(items.map(x=>x.id));$('#restoreInfo').textContent=`${name}\n${data.events.filter(x=>!x.deleted_at).length} 個行程、${data.notes.filter(x=>!x.deleted_at).length} 則備註。新增 ${items.filter(x=>!old.has(x.id)).length} 筆，取代 ${items.filter(x=>old.has(x.id)).length} 筆，移除 ${[...old].filter(x=>!ids.has(x)).length} 筆。`;$('#restoreProgress').textContent='';$('#restoreDialog').showModal();
}
function closeRestore(){if(state.restoring)return;pendingRestore=null;$('#restoreDialog').close();activateReadyUpdate()}
async function confirmRestore(){
  if(!pendingRestore||state.restoring)return;if(pendingRestore.scope!==getScope())throw new Error('ACCOUNT_CHANGED');const pending=pendingRestore;
  if(syncPromise)await syncPromise;state.restoring=true;renderSettings();$('#restoreConfirmBtn').disabled=true;$('#restoreCancelBtn').disabled=true;$('#restoreCloseBtn').disabled=true;
  try{
    const recovery=makeBackup();await setMeta('recoveryBackup',recovery);downloadBackup(recovery,'before-restore');$('#restoreProgress').textContent='正在還原，請保留此畫面…';
    if(state.workspace){const result=await api('/api/restore',{method:'POST',body:JSON.stringify({backup:pending.data,expectedGeneration:pending.generation})});await replaceSnapshot(result.events,result.notes,result.cursor);await setMeta('lastSyncAt',result.serverTime);}
    else {await replaceSnapshot(pending.data.events.filter(x=>!x.deleted_at),pending.data.notes.filter(x=>!x.deleted_at),null);}
    if(validTimezone(pending.data.timezone||''))await setMeta('timezone',pending.data.timezone);if(Array.isArray(pending.data.settings?.categories))await setMeta('categories',pending.data.settings.categories);
    await loadLocal();renderAll();pendingRestore=null;$('#restoreDialog').close();toast('還原完成；還原前資料已保存為復原備份');
  }catch(e){$('#restoreProgress').textContent=`${friendly(e)} 若連線在回應前中斷，請先重新同步確認結果，再重新預覽。`;throw e}
  finally{state.restoring=false;$('#restoreConfirmBtn').disabled=false;$('#restoreCancelBtn').disabled=false;$('#restoreCloseBtn').disabled=false;renderSettings();await updateQueueStatus();activateReadyUpdate()}
}
async function resumePush(){if(!state.workspace)return;const sub=await subscriptionState();if(sub.subscription&&sub.permission==='granted')await enablePush({requestPermission:false});await refreshPush()}
async function refreshPush(){const info=await subscriptionState();$('#pushStatus').textContent=info.supported?(info.permission==='denied'?'通知已封鎖，請至瀏覽器或系統設定允許。':info.subscription?'此裝置已訂閱通知':info.permission==='granted'?'已允許通知，尚未完成此裝置訂閱':'尚未啟用通知'):'此環境未提供 Web Push；iPhone／iPad 請由加入主畫面的 App 開啟。';if(connected()&&state.workspace){try{const r=await api('/api/push/diagnostics');$('#pushDiagnostics').textContent=`伺服器設定：${r.configured?'完成':'尚未完成'}；帳號裝置 ${r.devices.length} 個。${r.deliveries.map(x=>`${{accepted:'服務已接受',retry:'等待重試',sending:'處理中',gone:'訂閱失效'}[x.status]||x.status} ${x.n}`).join('、')}。系統勿擾、通知摘要或權限可能影響畫面顯示。`}catch(e){$('#pushDiagnostics').textContent=friendly(e)}}}
function setupViewport(){
  const viewport=window.visualViewport;const height=viewport?.height||innerHeight;document.documentElement.style.setProperty('--dialog-height',height+'px');document.documentElement.style.setProperty('--dialog-top',(viewport?.offsetTop||0)+'px');
  // The shell fills the layout viewport; only the editor follows the on-screen keyboard.
  if(!$('#editorDialog').open)document.documentElement.style.setProperty('--app-height',innerHeight+'px');
}
addEventListener('resize',setupViewport);window.visualViewport?.addEventListener('resize',setupViewport);window.visualViewport?.addEventListener('scroll',setupViewport);
async function registerWorker(){
  if(!('serviceWorker' in navigator))return;
  registration=await navigator.serviceWorker.register('./service-worker.js',{scope:'./',updateViaCache:'none'});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!sessionStorage.getItem('calendar-update-reloading')){sessionStorage.setItem('calendar-update-reloading','1');location.reload()}});
  navigator.serviceWorker.addEventListener('message',e=>{if(e.data?.type==='OPEN_ITEM')openDeepLink(e.data.url)});
  registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed')activateReadyUpdate()})});
  if(!navigator.serviceWorker.controller&&registration.waiting)registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});
  activateReadyUpdate();
}
async function checkUpdate(silent=false,force=false){
  if(updatePromise)return updatePromise;
  updatePromise=(async()=>{
    const r=await fetch(`./version.json?t=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('版本資訊暫時無法取得');const v=await r.json();$('#latestVersion').textContent=v.version||'未知';
    if(v.version===cfg.VERSION&&!force){sessionStorage.removeItem('calendar-update-reloading');sessionStorage.removeItem('calendar-update-target');$('#updateStatus').textContent='目前已是最新版本；啟動時會自動檢查。';if(!silent)toast('目前已是最新版本');return;}
    if(Number(v.build)<Number(cfg.BUILD)){if(!silent)toast('伺服器版本較舊，已保留目前版本');return;}
    if(sessionStorage.getItem('calendar-update-target')===v.version&&v.version!==cfg.VERSION){$('#updateStatus').textContent='已偵測到更新，但部分檔案尚未一致；稍後再檢查。';return;}
    waitingVersion=v.version;if(!registration)await registerWorker();if(!registration)throw new Error('此瀏覽器無法自動更新');
    $('#updateStatus').textContent='正在準備新版本…';await registration.update();
    if(force&&v.version===cfg.VERSION){if(state.editing||state.saving||state.restoring){toast('請先完成編輯或上傳後重試');return;}const name=`calendar-notes:${new URL('./',location.href).pathname}:${cfg.VERSION}`;const cache=await caches.open(name);const paths=Object.keys(v.assets||{});if(!paths.length)throw new Error('版本檔案缺少完整性資訊');const downloads=await Promise.all(paths.map(async path=>{const response=await fetch(path,{cache:'reload',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('程式檔案下載未完成');const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer()))).map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==v.assets[path])throw new Error('程式檔案尚未發布完整，已保留目前版本');return [path,response]}));for(const [path,response] of downloads)await cache.put(path,response);location.reload();return;}
    activateReadyUpdate();
  })().catch(e=>{$('#latestVersion').textContent='暫時無法檢查';$('#updateStatus').textContent='離線時可繼續使用；連線後會再次檢查。';if(!silent)throw e}).finally(()=>{updatePromise=null});return updatePromise;
}
function activateReadyUpdate(){
  if(!registration?.waiting)return;
  if(state.editing||state.saving||state.restoring||state.backingUp||$('#quickDialog').open||$('#restoreDialog').open){$('#updateStatus').textContent='新版本已準備完成；結束編輯後自動更新。';return;}
  if(waitingVersion){sessionStorage.setItem('calendar-update-target',waitingVersion);sessionStorage.removeItem('calendar-update-reloading')}
  registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});
}
async function openDeepLink(value){try{const u=new URL(value,location.href);if(u.searchParams.get('new')){await openEditor(u.searchParams.get('new')==='note'?'notes':'events');history.replaceState(null,'',new URL('./',location.href));return;}const kind=u.searchParams.get('open'),id=u.searchParams.get('id');if(!id||!['event','note'].includes(kind))return;const table=kind==='event'?'events':'notes';let item=state[table].find(x=>x.id===id);if(!item&&connected()){await (state.workspace?syncAll(false):connectWorkspace(false));item=state[table].find(x=>x.id===id)}if(item){if(state.editing){toast('提醒已開啟，請先完成目前的編輯');return}if(table==='notes')showView('notes');await openEditor(table,item)}}catch(e){toast(friendly(e))}}
boot().catch(e=>{console.error(e);status('啟動未完成');toast(friendly(e))});

async function importGuest(){
 if(!state.workspace||!canEdit())throw new Error('WORKSPACE_REQUIRED');const data=await guestRecords();const n=data.events.length+data.notes.length;if(!n){toast('本機模式沒有可匯入的內容');return;}
 if(!confirm(`將本機模式的 ${n} 筆內容複製到目前帳號的共享工作區？原本本機資料仍會保留。`))return;
 for(const kind of ['events','notes'])for(const src of data[kind]){const id='guest-'+src.id;if(state[kind].some(x=>x.id===id))continue;await saveRemote(kind,{...src,id,revision:0});}
 await loadLocal();renderAll();await syncAll(true);
}
async function recoverRestore(){
 if(state.workspace){const r=await api('/api/restore/history');if(!r.history.length)throw new Error('沒有伺服器復原備份');const data=await api('/api/restore/history/'+encodeURIComponent(r.history[0].id));await previewRestore(data,'還原前復原備份 '+formatDateTime(r.history[0].created_at));}
 else{const data=await getMeta('recoveryBackup',null);if(!data)throw new Error('沒有本機復原備份');await previewRestore(data,'上次還原前的本機備份');}
}
