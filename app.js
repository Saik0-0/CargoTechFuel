/* Vanilla JS. The API owns fueling state and money; this file owns navigation and a durable request journal. */
(() => {
  'use strict';
  const api = window.FakeApi;
  const root = document.getElementById('app');
  const banner = document.getElementById('banner');
  const KEY = 'cargotech.driver.journal.v1';
  const terminal = f => f && ['completed', 'cancelled'].includes(f.status);
  const money = v => Number(v).toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2}) + ' ₽';
  const num = v => Number(v).toLocaleString('ru-RU', {maximumFractionDigits:2});
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const round = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const cents = v => Math.round(v * 100);
  const state = {screen:'loading', trip:null, stations:[], station:null, location:null, fuel:'diesel', pump:null, liters:'50', purpose:'Тягач', fueling:null, busy:false, error:'', stale:false, geoError:false, all:false, sort:'distance', search:'', confirmed:false};
  let journal = {}, storageOK = true, timer = null, pollBusy = false, failures = 0;
  function readJournal() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || (j.pending && !j.pending.request?.clientRequestId)) throw new Error('journal');
    return j;
  }
  function loadJournal() {
    try { journal = readJournal(); localStorage.setItem(KEY, JSON.stringify(journal)); storageOK = true; }
    catch (_) { storageOK = false; }
  }
  function saveJournal(next) {
    try { localStorage.setItem(KEY, JSON.stringify(next)); journal = next; storageOK = true; return true; }
    catch (_) { storageOK = false; return false; }
  }
  function notice(text, kind='') { return text ? `<div class="notice ${kind}" role="status">${esc(text)}</div>` : ''; }
  function btn(text, action, kind='primary', disabled=false) { return `<button class="${kind}" data-action="${action}" ${disabled?'disabled':''}>${text}</button>`; }
  function back(target) { return `<button class="back" data-action="${target}">← Назад</button>`; }
  function rows(items) { return items.map(([k,v]) => `<div class="row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join(''); }
  function pumpName(p) {
    const n = Number(p), letters = ['А','Б','В','Г','Д','Е','Ж','З'];
    return state.station?.brand === 'Колесо' ? `${letters[n-1] || n} · № ${n}` : `№ ${n}`;
  }
  function distance(s) {
    if (!state.location) return Infinity;
    const rad = x => x*Math.PI/180, a=state.location;
    const h = Math.sin(rad(s.lat-a.lat)/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(s.lat))*Math.sin(rad(s.lon-a.lon)/2)**2;
    return 6371*2*Math.asin(Math.sqrt(Math.min(1,h)));
  }
  function maxLiters() {
    const p = state.station?.prices[state.fuel];
    return p > 0 ? Math.min(state.station.litersMax, Math.floor(cents(state.trip.limitLeft)*100/cents(p))/100) : 0;
  }
  function validation() {
    const s = state.station, L = Number(String(state.liters).replace(',','.'));
    if (!s || !state.fuel || !s.prices[state.fuel]) return 'Выберите доступное топливо.';
    const p = s.pumps.find(x => x.number === state.pump);
    if (!p || p.status !== 'free' || !p.fuels.includes(state.fuel)) return 'Выберите свободную колонку с нужным топливом.';
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(String(state.liters).trim())) return 'Введите литры числом, не больше двух знаков после запятой.';
    if (!Number.isFinite(L) || L < s.litersMin) return `Минимальный заказ — ${num(s.litersMin)} л.`;
    if (L > s.litersMax) return `Эта АЗС отпускает не больше ${num(s.litersMax)} л за заказ.`;
    if (L > maxLiters() || cents(round(L*s.prices[state.fuel])) > cents(state.trip.limitLeft)) return `По доступному лимиту можно заказать до ${num(maxLiters())} л. Уменьшите объём.`;
    return '';
  }
  function setScreen(screen) { state.screen=screen; state.error=''; state.confirmed=false; render(); window.scrollTo(0,0); }
  function header(title,step) { return `${step?`<div class="step">${step}</div>`:''}<h1>${title}</h1>`; }
  function render() {
    root.setAttribute('aria-busy',String(state.busy || state.screen==='loading'));
    banner.innerHTML = notice(!navigator.onLine ? 'Нет сети. Заказ на АЗС может продолжаться. Восстановим статус при появлении связи.' : state.stale ? 'Нет подтверждённого обновления. Показываем последние известные данные.' : '');
    let html='';
    const s=state.station, f=state.fueling;
    const errors=notice(state.error,'error');
    if(state.screen==='loading') html=header('Заправка в рейсе')+'<p>Проверяем рейс и незавершённые заправки…</p>';
    if(state.screen==='bootError') html=header('Не удалось обновить данные')+'<p>Новый заказ недоступен, пока не проверим предыдущие операции.</p>'+errors+btn('Проверить ещё раз','boot');
    if(state.screen==='home') {
      const t=state.trip;
      html=header('Заправка в рейсе')+`<div class="card"><div class="eyebrow">Текущий рейс · ${esc(new Date(t.date+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'}))}</div><div class="route">${esc(t.from)} → ${esc(t.to)}</div><p class="muted">Тягач ${esc(t.truck)}</p></div><div class="card"><div class="small">Сейчас доступно</div><div class="hero">${esc(num(t.limitLeft))} ₽</div><div class="small">Общий лимит рейса ${esc(money(t.limitTotal))}</div><div class="bar"><i style="width:${Math.min(100,Math.max(0,100*t.limitLeft/t.limitTotal))}%"></i></div><details><summary>Почему доступно меньше?</summary><p>Лимит уменьшают покупки и временные резервы. Резерв — деньги под заказ: их нельзя потратить повторно. После расчёта АЗС неиспользованная часть возвращается.</p><p>API не показывает историю и старые резервы отдельно. Разницу ${esc(money(t.limitTotal-t.limitLeft))} нельзя целиком называть списанием. Если сумма непонятна, уточните у диспетчера.</p></details></div>`+notice(!storageOK?'Не удалось безопасно прочитать или сохранить историю операций. Новый заказ заблокирован. Сохраните данные браузера и обратитесь за помощью.':'')+errors+btn('Заправиться','stations','primary',state.busy||!storageOK||!navigator.onLine)+btn('Обновить лимит','refreshHome','secondary',state.busy);
    }
    if(state.screen==='stations') {
      html=back('home')+header('Выберите АЗС','1 / 3 · Место')+'<p class="small">Выберите станцию, у которой стоите или к которой можете безопасно подъехать.</p>'+errors+
        `<label class="label" for="search">Название, сеть или адрес</label><input id="search" type="search" value="${esc(state.search)}" placeholder="Например, Колесо"><label class="label" for="sort">Порядок АЗС</label><select id="sort"><option value="distance" ${state.sort==='distance'?'selected':''}>Сначала ближайшие</option><option value="price" ${state.sort==='price'?'selected':''}>Сначала дешевле ДТ</option></select><label class="check"><input id="all" type="checkbox" ${state.all?'checked':''}>Показать АЗС по всей стране</label>`+
        notice(state.geoError?'Местоположение недоступно. Ищите АЗС по адресу, расстояния не рассчитаны.':'Расстояния по прямой. Подъезд, сторона дороги и отклонение от маршрута не проверены.');
      const nearby=state.stations.filter(x => x.prices.diesel && distance(x)<=40);
      const cheap=nearby.slice().sort((a,b)=>a.prices.diesel-b.prices.diesel)[0];
      let list=state.stations.filter(x => (state.all || !state.location || distance(x)<=40) && `${x.name} ${x.address}`.toLowerCase().includes(state.search.toLowerCase()));
      list.sort((a,b)=>state.sort==='price'?(a.prices.diesel??Infinity)-(b.prices.diesel??Infinity):distance(a)-distance(b));
      html+=`<p class="small">${list.length} АЗС · цены на обычное ДТ, ₽/л</p><div id="station-list">`+list.map(x=>`<button class="station ${cheap?.id===x.id?'recommended':''}" data-station="${esc(x.id)}"><span class="distance">${Number.isFinite(distance(x))?num(round(distance(x)))+' км':''}</span>${cheap?.id===x.id?'<span class="badge">Самая низкая цена ДТ в радиусе 40 км</span>':''}<strong>${esc(x.name)}</strong><div class="small">${esc(x.address)}</div><p class="price">${x.prices.diesel?esc(money(x.prices.diesel))+' / л':'Уточнить топливо'}</p></button>`).join('')+`</div>`;
      if(!list.length) html+='<p class="empty">АЗС не найдены. Измените поиск или покажите все станции.</p>';
    }
    if(state.screen==='form' && s) {
      html=back('stationsBack')+header('Что заправляем','2 / 3 · Заказ')+`<h2>${esc(s.name)}</h2><p class="small">${esc(s.address)}</p>`+errors+
        `<label class="label" for="purpose">Бак</label><select id="purpose"><option ${state.purpose==='Тягач'?'selected':''}>Тягач</option><option ${state.purpose==='Рефрижератор'?'selected':''}>Рефрижератор</option></select><p class="small">Один заказ — один бак. Лимит общий. Название бака сохраняется только на этом устройстве.</p><label class="label" for="fuel">Топливо</label><select id="fuel">`+s.fuels.map(x=>`<option value="${esc(x.code)}" ${state.fuel===x.code?'selected':''}>${esc(x.name)} · ${esc(money(x.price))}/л</option>`).join('')+`</select><label class="label">Колонка, у которой вы стоите</label><p class="small">${s.brand==='Колесо'?'По расшифровке у «Колеса» А = 1, Б = 2, В = 3, Г = 4. Для следующих букв соответствие предположено: проверьте на месте.':'Проверьте физический номер на стойке.'} Не выбирайте соседнюю колонку, если ваша занята.</p><div class="pumps">`+s.pumps.map(p=>{
        const unavailable=p.status!=='free'||!p.fuels.includes(state.fuel);
        return `<button class="pump ${p.number===state.pump?'selected':''}" data-pump="${p.number}" aria-pressed="${p.number===state.pump}" ${unavailable?'disabled':''}>${esc(pumpName(p.number))}<small>${p.status==='busy'?'Занята':p.status==='off'?'Не работает':!p.fuels.includes(state.fuel)?'Нет топлива':'Свободна'}</small></button>`;
      }).join('')+`</div><label class="label" for="liters">Объём, литры</label><input id="liters" inputmode="decimal" autocomplete="off" value="${esc(state.liters)}" aria-describedby="volume-help"><p id="volume-help" class="small">На АЗС: ${num(s.litersMin)}–${num(s.litersMax)} л за заказ. По деньгам сейчас: до ${num(maxLiters())} л. Проверьте свободное место в баке.</p><div class="spread">`+btn('30 л','liters30','secondary')+btn('50 л','liters50','secondary')+btn('100 л','liters100','secondary')+`</div><div class="card"><div class="small">Будет зарезервировано</div><div class="amount" id="amount">${esc(money(round((Number(String(state.liters).replace(',','.'))||0)*s.prices[state.fuel])))}</div><p class="small">Доступно ${esc(money(state.trip.limitLeft))}. Спишется стоимость фактически залитого.</p></div><div id="validation" role="status"></div>`+btn('Проверить заказ','review','primary',state.busy)+btn('Обновить колонки и цену','refreshStation','secondary',state.busy);
    }
    if(state.screen==='review' && s) {
      const L=Number(String(state.liters).replace(',','.')), amount=round(L*s.prices[state.fuel]);
      html=back('formBack')+header('Проверьте перед запуском','3 / 3 · Подтверждение')+errors+`<div class="card">`+rows([['АЗС',s.name],['Адрес',s.address],['Колонка',pumpName(state.pump)],['Бак',state.purpose],['Топливо',s.fuels.find(x=>x.code===state.fuel)?.name],['Объём',num(L)+' л'],['Цена',money(s.prices[state.fuel])+'/л'],['Резерв',money(amount)],['Останется доступно',money(round(state.trip.limitLeft-amount))]])+`</div><label class="check"><input id="confirm" type="checkbox" ${state.confirmed?'checked':''}>Я у этой колонки, топливо и объём проверены</label>`+notice('После принятия заказа подготовьте пистолет сразу и следуйте указаниям АЗС. Отменить через приложение можно только до начала налива. При ошибке топлива обратитесь к сотруднику АЗС.')+btn('Начать · резерв '+esc(money(amount)),'start','primary',state.busy||!state.confirmed||!navigator.onLine);
    }
    if(state.screen==='pending') html=header('Проверяем заказ')+notice('Ответ не получен. Заказ мог быть принят и деньги могли попасть в резерв. Не создавайте второй заказ.')+errors+`<div class="card">${rows([['АЗС',journal.pending?.stationName||'Уточняем'],['Запрос',journal.pending?.request.clientRequestId||'Уточняем']])}</div><p>Повторная проверка использует тот же номер запроса и восстанавливает прежнюю операцию.</p>`+btn(state.busy?'Проверяем…':'Проверить тот же заказ','resolve','primary',state.busy||!navigator.onLine);
    if(state.screen==='active' && f) {
      const titles={accepted:'АЗС принимает заказ',waiting_nozzle:'Подготовьте пистолет',fueling:'Идёт заправка'};
      html=header(titles[f.status]||'Уточняем статус')+errors+`<p>${esc(f.stationName)} · колонка ${esc(f.pump)}</p><p class="small">${esc(f.fuelName)} · ${esc(journal.purpose||'Бак не указан')}</p>`+notice(f.status==='fueling'?'Налив уже начался. Отмена в приложении недоступна. При проблеме используйте остановку на колонке и обратитесь к сотруднику АЗС.':'Вставьте нужный пистолет и следуйте указаниям АЗС. Не ждите таймера в приложении: точный срок API не сообщает.')+`<div class="card"><div class="small">Последние данные АЗС${state.stale?' · связь потеряна':''}</div><div class="hero">${esc(num(f.currentLiters))} л</div><p>Заказано ${esc(num(f.liters))} л</p><p class="small">Резерв ${esc(money(f.amountHeld))}</p></div><p class="small">При обрыве связи заправка на АЗС может продолжаться. Статус восстановится автоматически.</p>`+btn('Обновить статус','poll','secondary',state.busy||pollBusy)+(['accepted','waiting_nozzle'].includes(f.status)?btn('Отменить до налива','askCancel','danger',state.busy):'');
    }
    if(state.screen==='cancelConfirm' && f) html=header('Отменить заказ?')+'<p>Отмена возможна, пока налив не начался. Окончательный ответ даст АЗС. Во время ожидания налив может начаться.</p>'+errors+btn('Да, запросить отмену','cancel','danger',state.busy)+btn('Продолжить заправку','keep','secondary',state.busy);
    if(state.screen==='result' && f) {
      const complete=f.status==='completed';
      const reasons={DRIVER_CANCELLED:'Заказ отменён по вашему запросу.',PUMP_TIMEOUT:'АЗС не дождалась начала заправки.',STATION_NO_RESPONSE:'АЗС не подтвердила заказ.'};
      html=`<div class="status-icon">${complete?'✓':'—'}</div>`+header(complete?'Заправка завершена':'Заправка отменена')+errors+`<p class="small">${esc(f.stationName)} · колонка ${esc(f.pump)} · ${esc(f.fuelName)}</p>`+notice(complete&&f.factLiters<f.liters?`Залито меньше заказа: ${num(f.factLiters)} из ${num(f.liters)} л. Спишется только факт.`:complete?'Итог подтверждён АЗС.':reasons[f.reason]||'Заказ закрыт АЗС.',complete?'success':'')+`<div class="card">`+rows([['Залито',num(complete?f.factLiters:0)+' л'],['Списано',money(complete?f.factAmount:0)],['Было в резерве',money(f.amountHeld)],['Освобождено из резерва',money(round(f.amountHeld-(f.factAmount||0)))],['Доступно сейчас',state.stale?'Не удалось обновить':money(state.trip.limitLeft)]])+`</div><p class="small">Возврат из резерва подтверждён учебным API. Другие старые резервы могут оставаться. Чек в этом прототипе недоступен — запросите у диспетчера, отправка не подтверждена.</p><details><summary>Номер для обращения</summary><p>${esc(f.id)}</p></details>`+btn('На главную','finishHome','primary',state.busy)+btn('Обновить доступный лимит','resultRefresh','secondary',state.busy);
    }
    root.innerHTML=html;
    if(state.screen==='form') updateAmount();
  }
  function updateAmount() {
    const el=document.getElementById('amount');
    if(el) el.textContent=money(round((Number(String(state.liters).replace(',','.'))||0)*state.station.prices[state.fuel]));
    const hint=document.getElementById('validation');
    if(hint) hint.innerHTML=notice(validation(),'error');
  }
  async function work(fn) {
    if(state.busy)return;
    state.busy=true; state.error=''; render();
    try { await fn(); } catch(e) {state.error=errorText(e);} finally {state.busy=false;render();}
  }
  function errorText(e) {return e?.code==='NETWORK_ERROR'?'Нет связи с сервером. Повторите проверку при появлении сети.':e?.message||'Не удалось получить подтверждение сервера.';}
  async function boot() {
    clearTimeout(timer); state.screen='loading'; render(); loadJournal();
    try {
      state.trip=await api.getTrip();
      // A locally stored request always wins: only its identical replay can resolve an ambiguous POST.
      if(journal.pending) {state.screen='pending'; render();await resolvePending();return;}
      if(journal.activeId) {await acceptFueling(await api.getFueling(journal.activeId));return;}
      const active=await api.getActiveFueling();
      if(active) {saveJournal({...journal,purpose:'Бак не указан'});await acceptFueling(active);return;}
      state.stale=false;state.screen='home';
    }catch(e){state.screen='bootError';state.error=errorText(e);} render();
  }
  async function showStations() {
    const results=await Promise.allSettled([api.getStations(),api.getDriverLocation(),api.getTrip()]);
    if(results[0].status==='rejected')throw results[0].reason;
    if(results[2].status==='rejected')throw results[2].reason;
    state.stations=results[0].value;state.trip=results[2].value;
    state.location=results[1].status==='fulfilled'?results[1].value:null;state.geoError=!state.location;
    setScreen('stations');
  }
  async function chooseStation(id) {
    state.station=await api.getStation(id);state.pump=null;state.liters='50';
    state.fuel=state.station.fuels.some(x=>x.code==='diesel')?'diesel':state.station.fuels[0].code;
    setScreen('form');
  }
  async function refreshStation() {
    state.station=await api.getStation(state.station.id);state.trip=await api.getTrip();
    const p=state.station.pumps.find(x=>x.number===state.pump);
    if(!p||p.status!=='free'||!p.fuels.includes(state.fuel))state.pump=null;
  }
  // Added below: durable start/recovery and polling. All monetary mutations pass through the journal.
  async function acceptFueling(f) {
    state.fueling=f;
    saveJournal({activeId:f.id,purpose:journal.pending?.purpose||journal.purpose||state.purpose});
    state.screen=terminal(f)?'result':'active';state.stale=false;failures=0;
    if(terminal(f)){try{state.trip=await api.getTrip();}catch(_){state.stale=true;}}
    else schedulePoll();
  }
  function schedulePoll(){clearTimeout(timer);timer=setTimeout(()=>poll(),1800);}
  async function poll(){if(!state.fueling||terminal(state.fueling)||pollBusy)return;pollBusy=true;try{await acceptFueling(await api.getFueling(state.fueling.id));}catch(e){state.stale=true;state.error=errorText(e);schedulePoll();}finally{pollBusy=false;render();}}
  async function resolvePending(){throw new Error('Восстановление запроса ещё не подключено');}
  async function start(){throw new Error('Запуск заказа ещё не подключён');}
  async function cancel(){await acceptFueling(await api.cancelFueling(state.fueling.id));}
  const actions={
    boot:()=>boot(),home:()=>setScreen('home'),stations:()=>showStations(),stationsBack:()=>setScreen('stations'),formBack:()=>setScreen('form'),
    refreshHome:async()=>{state.trip=await api.getTrip();},refreshStation,
    review:async()=>{await refreshStation();const error=validation();if(error){state.error=error;return;}setScreen('review');},
    start,resolve:resolvePending,poll,askCancel:()=>{state.screen='cancelConfirm';},keep:()=>{state.screen='active';},cancel,
    finishHome:async()=>{state.trip=await api.getTrip();saveJournal({});state.fueling=null;state.stale=false;setScreen('home');},
    resultRefresh:async()=>{state.trip=await api.getTrip();state.stale=false;},
    liters30:()=>{state.liters='30';},liters50:()=>{state.liters='50';},liters100:()=>{state.liters='100';}
  };
  root.addEventListener('click',e=>{
    const station=e.target.closest('[data-station]');if(station){work(()=>chooseStation(station.dataset.station));return;}
    const pump=e.target.closest('[data-pump]');if(pump&&!pump.disabled){state.pump=Number(pump.dataset.pump);render();return;}
    const el=e.target.closest('[data-action]');if(el&&!el.disabled&&actions[el.dataset.action])work(actions[el.dataset.action]);
  });
  root.addEventListener('input',e=>{
    if(e.target.id==='liters'){state.liters=e.target.value;updateAmount();}
    if(e.target.id==='search'){const pos=e.target.selectionStart;state.search=e.target.value;render();const input=document.getElementById('search');input.focus();input.setSelectionRange(pos,pos);}
  });
  root.addEventListener('change',e=>{
    const el=e.target;
    if(el.id==='fuel'){state.fuel=el.value;state.pump=null;render();}
    if(el.id==='purpose'){state.purpose=el.value;}
    if(el.id==='all'){state.all=el.checked;render();}
    if(el.id==='sort'){state.sort=el.value;render();}
    if(el.id==='confirm'){state.confirmed=el.checked;render();}
  });
  window.addEventListener('offline',()=>render());
  window.addEventListener('online',()=>{render();if(state.screen==='pending')work(resolvePending);else if(state.fueling&&!terminal(state.fueling))poll();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.fueling&&!terminal(state.fueling))poll();});
  boot();
})();
