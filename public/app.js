'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KEY='qianhai-lunch-v1';
const TYPES=[['米饭简餐','🍚','想吃饭'],['面粉馄饨','🍜','嗦粉嗦面'],['粤菜茶餐','🥟','广式茶餐'],['地方家常','🥘','家常下饭菜'],['西式日韩','🍔','西式·日韩'],['火锅煲类','🍲','火锅煲煲'],['素食自助','🥬','今天吃素'],['海鲜料理','🦐','来点海鲜'],['东南亚菜','🍃','东南亚风味'],['私藏好店','✨','我的私藏']];
const ZONES=['卓悦 INTOWN','万象前海','前海嘉里中心','恒裕前海','其他周边'];
const ADD_BUDGETS=[{low:18,high:30,label:'30元内'},{low:25,high:50,label:'50元内'},{low:50,high:80,label:'50–80元'},{low:80,high:150,label:'80元以上'}];
let saved={};try{saved=JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch{}
let legacyCustom=Array.isArray(saved.custom)?saved.custom.filter(r=>r&&typeof r.id==='string'&&typeof r.name==='string'&&typeof r.type==='string'&&typeof r.zone==='string'&&Number.isFinite(r.low)&&Number.isFinite(r.high)&&r.low>0&&r.high>=r.low).map(r=>({...r,source:-1,emoji:r.emoji||'🍱',note:'你的午餐私藏，值得再吃一次。'})):[];
let restaurants=[];
let serviceReady=false,catalogLoading=false;
const migratedRestaurantIds=new Set(Array.isArray(saved.migratedRestaurantIds)?saved.migratedRestaurantIds:[]);
let excluded=new Set(Array.isArray(saved.excluded)?saved.excluded.filter(x=>typeof x==='string'):[]);
let history=Array.isArray(saved.history)?saved.history.filter(h=>h&&typeof h.name==='string'&&typeof h.id==='string'&&Number.isFinite(h.at)):[];
let budget=Number(saved.budget)||0;if(![0,30,50,80,999].includes(budget))budget=0;
let typePref=TYPES.some(t=>t[0]===saved.type)?saved.type:'';
let zonePref=ZONES.includes(saved.zone)?saved.zone:'';
let avoidRecent=saved.avoid!==false;
let batch=[],rotation=0,busy=false,selected=null,hasSpun=false,toastTimer;
let addType='私藏好店',addZone='其他周边',addBudget=1;
const canvas=$('#wheel'),ctx=canvas.getContext('2d');
function persist(){try{localStorage.setItem(KEY,JSON.stringify({custom:legacyCustom,migratedRestaurantIds:[...migratedRestaurantIds],excluded:[...excluded],history,budget,type:typePref,zone:zonePref,avoid:avoidRecent}));}catch{toast('浏览器未允许保存偏好，美食仍会保存在数据文件中。');}}
async function requestJson(path,{method='GET',body}={}){
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetch(path,{method,signal:controller.signal,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});let result;try{result=await response.json();}catch{throw new Error('暂时没有收到美食数据，请稍后再试。');}if(!response.ok)throw new Error(result.error||'这次没保存成功，请再试一次。');return result;}
 catch(error){if(error.name==='AbortError')throw new Error('等得有点久，请确认服务正在运行后重试。');if(error instanceof TypeError)throw new Error('暂时连不上美食服务，请确认程序已经启动。');throw error;}
 finally{clearTimeout(timeout);}
}
async function loadCatalog(){
 if(catalogLoading||busy)return;catalogLoading=true;serviceReady=false;setBusy(true);$('#connection-status').hidden=true;$('#pool-count').textContent='美食加载中…';$('#wheel-caption').textContent='正在准备今天的好饭。';$('#foods').innerHTML='<div class="empty">正在准备午餐灵感…</div>';
 let failure=null;
 try{if(location.protocol==='file:')throw new Error('请先启动程序，再通过服务地址打开页面。');const data=await requestJson('/api/restaurants');if(!Array.isArray(data.restaurants))throw new Error('美食数据格式不正确，请稍后重试。');restaurants=data.restaurants;
 const pending=legacyCustom.filter(r=>!migratedRestaurantIds.has(r.id));if(pending.length){try{const imported=await requestJson('/api/restaurants/import',{method:'POST',body:{restaurants:pending}});restaurants=imported.restaurants;pending.forEach(r=>migratedRestaurantIds.add(r.id));persist();}catch{toast('旧私藏暂未同步，数据仍在浏览器里，刷新后会重试。');}}
 serviceReady=true;newBatch();renderFoods();renderPreferences();renderHistory();
 }catch(error){failure=error;}
 finally{catalogLoading=false;setBusy(false);}
 if(failure){$('#connection-status').hidden=false;$('#connection-message').textContent=failure.message;$('#pool-count').textContent='好饭暂时还没加载出来';$('#wheel-caption').textContent='稍等一下，或点上方的「再试一下」。';$('#foods').innerHTML='<div class="empty">美食暂时没加载成功，请重试。<br>已有数据会继续保存在文件中。</div>';}
}

function toast(msg){clearTimeout(toastTimer);$('#toast').textContent=msg;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2600);}
function all(){return restaurants;}
function matches(r){return (!budget||(budget===999?r.high>80:r.high<=budget))&&(!typePref||r.type===typePref)&&(!zonePref||r.zone===zonePref);}
function isRecent(id){return avoidRecent&&history.some(h=>h.id===id&&Date.now()-h.at<3*86400000);}
function pool(){return all().filter(r=>matches(r)&&!excluded.has(r.id)&&!isRecent(r.id));}
function syncAside(){$('.right-col').dataset.empty=String($('#result').dataset.state==='idle'&&!history.length);}
function preferenceButton(value,label,kind,on){return `<button type="button" class="preference-chip${on?' active':''}" data-${kind}="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;}
function renderPreferences(){
 $('#type-chips').innerHTML=preferenceButton('','都可以，随缘吃','type',!typePref)+TYPES.map(t=>preferenceButton(t[0],t[1]+' '+t[2],'type',typePref===t[0])).join('');
 $('#zone-chips').innerHTML=preferenceButton('','附近都可以','zone',!zonePref)+ZONES.map(z=>preferenceButton(z,z,'zone',zonePref===z)).join('');
 const n=Number(!!typePref)+Number(!!zonePref);$('#preference-count').hidden=!n;$('#preference-count').textContent=n;
 $('#active-preferences').innerHTML=(typePref?`<button data-clear="type" aria-label="取消口味偏好">${esc(TYPES.find(t=>t[0]===typePref)?.[2]||typePref)} ×</button>`:'')+(zonePref?`<button data-clear="zone" aria-label="取消商圈偏好">${esc(zonePref)} ×</button>`:'')||'<span>不挑口味，好饭随缘</span>';
 $('#avoid').setAttribute('aria-pressed',String(avoidRecent));$('#avoid').textContent=(avoidRecent?'✓ ':'')+'近3天不重样';
 document.querySelectorAll('[data-budget]').forEach(b=>{const on=Number(b.dataset.budget)===budget;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
}
function renderAddOptions(){
 $('#add-type-chips').innerHTML=TYPES.map(t=>preferenceButton(t[0],t[1]+' '+t[2],'add-type',addType===t[0])).join('');
 $('#add-zone-chips').innerHTML=ZONES.map(z=>preferenceButton(z,z,'add-zone',addZone===z)).join('');
 $('#add-budget-chips').innerHTML=ADD_BUDGETS.map((b,i)=>preferenceButton(String(i),b.label,'add-budget',addBudget===i)).join('');
 const b=ADD_BUDGETS[addBudget];$('#add-estimate').textContent=`${addType} · ${addZone} · 暂估 ¥${b.low}–${b.high}/人`;
}
function rand(n){const b=new Uint32Array(1),max=4294967296-(4294967296%n);do{crypto.getRandomValues(b);}while(b[0]>=max);return b[0]%n;}
function shuffled(a){const b=[...a];for(let i=b.length-1;i>0;i--){const j=rand(i+1);[b[i],b[j]]=[b[j],b[i]];}return b;}
function draw(){const W=canvas.width,c=W/2,R=W*.475;ctx.clearRect(0,0,W,W);ctx.save();ctx.translate(c,c);ctx.fillStyle='#fffdf5';ctx.beginPath();ctx.arc(0,0,R+15,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#d8dbc9';ctx.lineWidth=2;ctx.stroke();ctx.save();ctx.rotate(rotation);const colors=['#eac283','#f2e7be','#b8c9a4','#e4ead2','#e7987b','#f7e8bb','#bfceb0','#e9c99f','#f2e4cc','#d1dbb5','#e9b49c','#cfddc0'];
if(!batch.length){ctx.fillStyle='#eceee4';ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.fill();ctx.restore();ctx.fillStyle='#849079';ctx.font='25px sans-serif';ctx.textAlign='center';ctx.fillText(serviceReady?'换个条件，好饭就在下一转':'好饭正在准备中…',0,150);ctx.restore();return;}
const step=Math.PI*2/batch.length;
batch.forEach((r,i)=>{const start=-Math.PI/2+i*step;ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,R,start,start+step);ctx.closePath();ctx.fillStyle=colors[i%colors.length];ctx.fill();ctx.lineWidth=3;ctx.strokeStyle='#fffdf2';ctx.stroke();ctx.save();ctx.rotate(start+step/2);ctx.textBaseline='middle';ctx.fillStyle='#35482d';ctx.font=`600 ${batch.length>9?28:31}px -apple-system,"PingFang SC",sans-serif`;const label=r.name.length>9?r.name.slice(0,8)+'…':r.name;const flipped=Math.cos(start+step/2+rotation)<0;if(flipped){ctx.rotate(Math.PI);ctx.textAlign='left';ctx.fillText(label,-R+37,0);}else{ctx.textAlign='right';ctx.fillText(label,R-37,0);}ctx.restore();});ctx.restore();ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.strokeStyle='#fffdf2';ctx.lineWidth=11;ctx.stroke();for(let i=0;i<48;i++){const a=i*Math.PI/24;ctx.beginPath();ctx.arc(Math.cos(a)*(R+8),Math.sin(a)*(R+8),2.3,0,Math.PI*2);ctx.fillStyle='#b0b99c';ctx.fill();}ctx.restore();}
function controls(){const n=pool().length;$('#spin').disabled=busy||!serviceReady||!n;$('#hub').disabled=busy||!serviceReady||!n;$('#shuffle').disabled=busy||!serviceReady||!n;$('#add').disabled=busy||!serviceReady;$('#pool-count').textContent=n?`${n} 家好饭等你翻牌`:'暂时没有合适的店铺';$('#preferences-pool').textContent=`${n} 家可选`;$('#wheel-caption').textContent=n?'转到喜欢的，就出发吧。':'暂时没得选啦，试试放宽偏好。';$('#wheel').setAttribute('aria-label',batch.length?'本轮候选：'+batch.map(r=>r.name).join('、'):'没有符合条件的店铺');}
function newBatch(){batch=shuffled(pool()).slice(0,12);rotation=0;hasSpun=false;draw();controls();}
function renderFoods(){const q=$('#search').value.trim().toLowerCase();const list=all().filter(r=>matches(r)&&`${r.name} ${r.zone} ${r.type}`.toLowerCase().includes(q));$('#library-count').textContent=`${all().length} 家午餐灵感 · ${pool().length} 家等你翻牌`;
$('#foods').innerHTML=list.length?list.map(r=>{const skip=excluded.has(r.id),recent=isRecent(r.id);return `<article class="food-card${skip?' excluded':''}"><div class="food-icon">${esc(r.emoji)}</div><div class="food-info"><h3>${esc(r.name)}</h3><p>${esc(r.zone)} · ${esc(r.type)}</p><p>约 ¥${r.low}–${r.high}/人 · 估算</p><div class="food-bottom"><span>${skip?'已跳过':recent?'最近吃过':r.source<0?'我的私藏':'已加入转盘'}</span><button data-exclude="${esc(r.id)}" aria-label="${skip?'放回转盘':'先不吃'}${esc(r.name)}">${skip?'放回转盘':'先不吃'}</button></div><a class="source-link" href="${esc(mapURL(r))}" target="_blank" rel="noopener noreferrer">看看这家 ↗</a>${r.source<0?`<button class="text-btn" style="font-size:10px;display:block" data-delete="${esc(r.id)}">移除私藏</button>`:''}</div></article>`;}).join(''):'<div class="empty">这份偏爱，暂时还没遇上。<br>换个口味找找，或加一家你的私藏。</div>';}
function renderHistory(){$('.history').dataset.empty=String(!history.length);$('#history').innerHTML=history.length?history.slice(0,5).map(h=>`<div class="history-item"><span>${esc(h.name)}</span><time>${esc(new Date(h.at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}))}</time></div>`).join(''):'<div class="history-empty">吃到喜欢的，点一下「就吃这家」。<br>下次就会记得帮你换换口味。</div>';$('#clear-history').disabled=busy||!history.length;syncAside();}
function setBusy(value){busy=value;document.querySelectorAll('button,input').forEach(el=>el.disabled=value);controls();if(!value)renderHistory();}
function showIdle(){$('#result').dataset.state='idle';$('#result').innerHTML='<div class="tiny-title">你的午餐盲盒</div><span class="result-emoji">🍱</span><h2>今天的好饭，<br>马上揭晓。</h2><p>总有一家，刚好对胃口。<br>转一下，把午餐安排上。</p><div class="result-decoration">吃饱了，世界都可爱一点。</div>';syncAside();}
function refresh(){persist();selected=null;newBatch();renderFoods();renderPreferences();showIdle();renderHistory();$('#spin').textContent='转一下，今天吃这家 ↗';}
function mapURL(r){return 'https://uri.amap.com/search?keyword='+encodeURIComponent(`${r.name} ${r.zone==='卓悦 INTOWN'?'前海卓悦INTOWN':r.zone} 深圳`);}
function showResult(r){$('#result').dataset.state='ready';$('#result').innerHTML=`<div class="tiny-title">今天就宠幸这家</div><span class="result-emoji">${esc(r.emoji)}</span><h2>${esc(r.name)}</h2><p>${esc(r.note)}</p><div class="result-meta">⌖ ${esc(r.zone)}<br>约 ¥${r.low}–${r.high}/人 <span style="font-size:10px;color:#89917f">· 估算</span><br>${esc(r.type)}</div><div class="result-actions"><button class="primary" id="accept">就吃这家 ✓</button><a href="${esc(mapURL(r))}" target="_blank" rel="noopener noreferrer">带我去看看 ↗</a></div><span class="result-source">出发前看看营业和菜单，别让好饭扑个空。</span>`;$('#accept').onclick=()=>accept(r);syncAside();if(matchMedia('(max-width:760px)').matches)requestAnimationFrame(()=>$('#result').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));}
function accept(r){const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});if(!history.some(h=>h.id===r.id&&new Date(h.at).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})===today)){history.unshift({id:r.id,name:r.name,at:Date.now()});history=history.slice(0,60);persist();}$('#accept').textContent='记下啦，开饭！';$('#accept').disabled=true;renderHistory();renderFoods();controls();toast('午餐安排好啦，愿你有个满格的下午！');}
function celebrate(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;for(let i=0;i<24;i++){const el=document.createElement('i');el.className='confetti';el.style.cssText=`left:${45+rand(25)}%;top:35%;background:${['#df6849','#b0bd90','#e8ba73'][i%3]};--x:${rand(360)-180}px;animation-delay:${rand(250)}ms`;document.body.append(el);setTimeout(()=>el.remove(),2100);}}
function spin(){if(busy||!pool().length)return;if(hasSpun)newBatch();if(!batch.length)return;const chosen=rand(batch.length);selected=batch[chosen];setBusy(true);$('#spin').textContent='午餐灵感转动中…';$('#result').dataset.state='spinning';$('#result').innerHTML='<div class="tiny-title">午餐盲盒开启中</div><span class="result-emoji">✨</span><h2>好饭正在路上…</h2><p>今天，会和哪一口美味相遇？</p>';syncAside();const start=rotation,step=Math.PI*2/batch.length;const target=6*Math.PI*2+(Math.PI*2-(chosen+.5)*step);const delta=target-start;const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?80:4600;const t0=performance.now();function frame(t){const p=Math.min((t-t0)/duration,1);rotation=start+delta*(1-Math.pow(1-p,5));draw();if(p<1)requestAnimationFrame(frame);else{rotation=((rotation%(Math.PI*2))+Math.PI*2)%(Math.PI*2);hasSpun=true;setBusy(false);$('#spin').textContent='再转一下，换个好胃口 ↗';showResult(selected);celebrate();}}requestAnimationFrame(frame);}
$('#spin').onclick=spin;$('#hub').onclick=spin;
$('#shuffle').onclick=()=>{newBatch();toast('换好啦，再给午餐一点新鲜感');};
$('#budget-chips').onclick=e=>{const b=e.target.closest('[data-budget]');if(!b||busy)return;budget=Number(b.dataset.budget);refresh();};
$('#type-chips').onclick=e=>{const b=e.target.closest('[data-type]');if(!b||busy)return;typePref=b.dataset.type;refresh();};
$('#zone-chips').onclick=e=>{const b=e.target.closest('[data-zone]');if(!b||busy)return;zonePref=b.dataset.zone;refresh();};
$('#active-preferences').onclick=e=>{const b=e.target.closest('[data-clear]');if(!b||busy)return;if(b.dataset.clear==='type')typePref='';else zonePref='';refresh();};
$('#avoid').onclick=()=>{if(busy)return;avoidRecent=!avoidRecent;refresh();};
$('#preferences-open').onclick=()=>{$('#preferences-dialog').showModal();};
$('#preferences-close').onclick=()=>$('#preferences-dialog').close();$('#preferences-done').onclick=()=>$('#preferences-dialog').close();
$('#reset').onclick=()=>{budget=0;typePref='';zonePref='';avoidRecent=true;excluded.clear();$('#search').value='';refresh();toast('好啦，把选择交给一点运气');};
$('#search').oninput=renderFoods;
$('#foods').onclick=async e=>{if(busy)return;const b=e.target.closest('[data-exclude]');if(b){const id=b.dataset.exclude;excluded.has(id)?excluded.delete(id):excluded.add(id);refresh();return;}const d=e.target.closest('[data-delete]');if(d){setBusy(true);try{const result=await requestJson('/api/restaurants/'+encodeURIComponent(d.dataset.delete),{method:'DELETE'});restaurants=result.restaurants;excluded.delete(d.dataset.delete);refresh();toast('已移除这家私藏');}catch(error){toast(error.message);}finally{setBusy(false);}}};
$('#clear-history').onclick=()=>{history=[];persist();newBatch();renderFoods();renderHistory();toast('用餐记录已清空');};
$('#add-type-chips').onclick=e=>{const b=e.target.closest('[data-add-type]');if(b){addType=b.dataset.addType;renderAddOptions();}};
$('#add-zone-chips').onclick=e=>{const b=e.target.closest('[data-add-zone]');if(b){addZone=b.dataset.addZone;renderAddOptions();}};
$('#add-budget-chips').onclick=e=>{const b=e.target.closest('[data-add-budget]');if(b){addBudget=Number(b.dataset.addBudget);renderAddOptions();}};
$('#add').onclick=()=>{$('#form-error').textContent='';$('#add-form').reset();addType='私藏好店';addZone='其他周边';addBudget=1;$('#add-details').open=false;renderAddOptions();$('#add-dialog').showModal();};
$('#cancel-add').onclick=()=>$('#add-dialog').close();
$('#add-form').onsubmit=async e=>{e.preventDefault();if(busy||!serviceReady)return;const name=new FormData(e.target).get('name').trim();if(!name){$('#form-error').textContent='先告诉我这家店叫什么吧。';return;}if(all().some(r=>r.name.toLowerCase()===name.toLowerCase()&&r.zone===addZone)){$('#form-error').textContent='这家店已经在这个商圈的名单里啦。';return;}const b=ADD_BUDGETS[addBudget];const submit=$('#add-form button[type=submit]');setBusy(true);submit.textContent='正在收好这家店…';$('#form-error').textContent='';try{const result=await requestJson('/api/restaurants',{method:'POST',body:{name,low:b.low,high:b.high,type:addType,zone:addZone,note:'你的午餐私藏，值得再吃一次。',emoji:TYPES.find(t=>t[0]===addType)?.[1]||'🍱'}});restaurants=result.restaurants;$('#add-dialog').close();e.target.reset();refresh();toast('收好啦，下次转盘里见！');}catch(error){$('#form-error').textContent=error.message;}finally{submit.textContent='收进我的午餐名单 ＋';setBusy(false);}};
$('#retry-load').onclick=loadCatalog;
renderPreferences();renderAddOptions();renderHistory();loadCatalog();

// Repaint after responsive layout and page restoration, including mobile WebKit.
const wheelResizeObserver=new ResizeObserver(()=>{if(!busy)requestAnimationFrame(draw);});
wheelResizeObserver.observe(canvas);
window.addEventListener('pageshow',()=>{if(!busy)requestAnimationFrame(draw);});
