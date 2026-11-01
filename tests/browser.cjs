/* Browser acceptance checks. Test tooling is not part of the application runtime.
   node tests/browser.cjs, with PLAYWRIGHT_PATH pointing to an installed playwright package. */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const journalKey = 'cargotech.driver.journal.v1';
const fakeKey = 'fakeApi.zapravka.v1';
const server = http.createServer((req, res) => {
  const file = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/fake-api.js':'fake-api.js'}[req.url];
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');
  res.end(fs.readFileSync(path.join(base,file)));
});
let browser, origin;
const passed=[];
let capture=false;
async function screenshot(page,name){if(capture){fs.mkdirSync(path.join(base,'.qa'),{recursive:true});await page.screenshot({path:path.join(base,'.qa',name+'.png'),fullPage:true});}}
async function check(name, fn){await fn();passed.push(name);console.log('PASS',name);}
async function makePage(context){
  const page=await context.newPage();
  page.on('pageerror',e=>{throw e;});
  await page.addInitScript(()=>{
    const nativeTimeout=window.setTimeout.bind(window);
    window.setTimeout=(fn,delay,...args)=>nativeTimeout(fn,delay>=300&&delay<=1500?1:delay,...args);
    const now=Date.now;window.__time=0;Date.now=()=>now()+window.__time;
    Math.random=()=>window.__random??.5;
    Object.defineProperty(window,'FakeApi',{configurable:true,set(api){
      api.config.networkErrors=false;
      const start=api.startFueling, get=api.getFueling, trip=api.getTrip, loc=api.getDriverLocation;
      api.startFueling=async r=>{
        if(window.__reject){const code=window.__reject;window.__reject=null;throw Object.assign(new Error(code),{code,details:code==='PRICE_CHANGED'?{oldPrice:r.price,newPrice:r.price+1}:{available:100}});}
        const f=await start(r);
        if(window.__lose){window.__lose=false;throw Object.assign(new Error('Lost response'),{code:'NETWORK_ERROR'});}
        return f;
      };
      api.getFueling=id=>window.__getFail?Promise.reject(Object.assign(new Error('Offline'),{code:'NETWORK_ERROR'})):get(id);
      api.getTrip=()=>window.__tripFail?Promise.reject(Object.assign(new Error('Offline'),{code:'NETWORK_ERROR'})):trip();
      api.getDriverLocation=()=>window.__geoFail?Promise.reject(Object.assign(new Error('No GPS'),{code:'NETWORK_ERROR'})):loc();
      Object.defineProperty(window,'FakeApi',{value:api});
    }});
  });
  await page.goto(origin);
  await page.getByRole('button',{name:'Заправиться',exact:true}).waitFor();
  return page;
}
async function click(page,name){await page.getByRole('button',{name,exact:true}).click();}
async function review(page, volume='50'){
  await screenshot(page,'home');
  await click(page,'Заправиться');
  await page.locator('[data-station]').first().waitFor();await screenshot(page,'stations');
  await page.locator('[data-station]').first().click();
  await page.locator('[data-pump]:not([disabled])').first().click();
  await page.locator('#liters').fill(volume);
  await screenshot(page,'form');
  await click(page,'Проверить заказ');
  await page.locator('#confirm').check();
  await screenshot(page,'review');
}
async function start(page){await page.locator('[data-action=start]').click();}
async function active(page){await page.locator('[data-action=askCancel], [data-action=poll]').first().waitFor();}
async function stored(page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),fakeKey);}
async function advance(page,ms){await page.evaluate(v=>{window.__time+=v;},ms);await click(page,'Обновить статус');}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXE?{executablePath:process.env.BROWSER_EXE}:{})});
  async function scenario(fn){const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});let page;try{page=await makePage(context);await fn(page,context);}catch(e){if(page)console.error('SCREEN:',await page.locator('body').innerText());throw e;}finally{await context.close();}}
  await check('happy path: actual amount, restored limit and no overflow',()=>scenario(async page=>{
    capture=true;
    assert((await page.locator('body').innerText()).includes('9 340'));
    await review(page);await start(page);await active(page);await screenshot(page,'active');await advance(page,30000);
    await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();
    const data=await stored(page), f=data.fuelings[0];assert.equal(f.factLiters,50);assert.equal(data.limitLeft,Math.round((9340-f.factAmount)*100)/100);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    fs.mkdirSync(path.join(base,'.qa'),{recursive:true});await page.screenshot({path:path.join(base,'.qa','result.png'),fullPage:true});
    await page.reload();await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();
    capture=false;
  }));
  await check('volume validation: station max, money max, negative and decimal comma',()=>scenario(async page=>{
    await click(page,'Заправиться');await page.locator('[data-station]').first().click();await page.locator('[data-pump]:not([disabled])').first().click();
    for(const volume of ['400','-2','abc','1','30.123']){await page.locator('#liters').fill(volume);await click(page,'Проверить заказ');await page.locator('#liters').waitFor();assert.equal((await stored(page))?.fuelings.length??0,0);}
    await page.locator('#liters').fill('30,5');await click(page,'Проверить заказ');await page.locator('#confirm').waitFor();
  }));
  await check('lost response + double tap + reload: exactly one order and one hold',()=>scenario(async page=>{
    await review(page);await page.evaluate(()=>{window.__lose=true;});await page.locator('[data-action=start]').dblclick();
    await page.getByRole('heading',{name:'Проверяем заказ',exact:true}).waitFor();
    const before=await stored(page);assert.equal(before.fuelings.length,1);
    const key=await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).pending.request.clientRequestId,journalKey);
    await page.reload();await active(page);const after=await stored(page);assert.equal(after.fuelings.length,1);assert.equal(after.fuelings[0].clientRequestId,key);assert.equal(after.limitLeft,before.limitLeft);
  }));
  await check('underfill: charge fact, release unused hold',()=>scenario(async page=>{
    await review(page);await page.evaluate(()=>{window.__random=.7;});await start(page);await active(page);await advance(page,30000);
    await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();const data=await stored(page),f=data.fuelings[0];assert(f.factLiters<50);assert.equal(data.limitLeft,Math.round((9340-f.factAmount)*100)/100);assert((await page.locator('body').innerText()).includes('Залито меньше'));
  }));
  await check('cancel before flow: hold is released once',()=>scenario(async page=>{
    await review(page);await start(page);await active(page);await click(page,'Отменить до налива');await click(page,'Да, запросить отмену');await page.getByRole('heading',{name:'Заправка отменена',exact:true}).waitFor();assert.equal((await stored(page)).limitLeft,9340);
  }));
  await check('cancel race: station rejects after flow begins',()=>scenario(async page=>{
    await review(page);await start(page);await active(page);await click(page,'Отменить до налива');await page.evaluate(()=>{window.__time+=12000;});await click(page,'Да, запросить отмену');await page.getByRole('heading',{name:'Идёт заправка',exact:true}).waitFor();assert.equal(await page.locator('[data-action=askCancel]').count(),0);assert.equal((await stored(page)).fuelings[0].status,'fueling');
  }));
  await check('read failure during fueling: no false success, recover on reconnect',()=>scenario(async page=>{
    await review(page);await start(page);await active(page);await page.evaluate(()=>{window.__getFail=true;});await click(page,'Обновить статус');await page.getByText('Нет подтверждённого обновления.',{exact:false}).waitFor();assert.equal(await page.getByRole('heading',{name:'Заправка завершена',exact:true}).count(),0);
    await page.evaluate(()=>{window.__getFail=false;window.__time+=30000;});await click(page,'Обновить статус');await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();assert.equal((await stored(page)).fuelings.length,1);
  }));
  for(const code of ['PRICE_CHANGED','PUMP_BUSY','LIMIT_EXCEEDED']) await check(code+': visible rejection, no order created',()=>scenario(async page=>{
    await review(page);await page.evaluate(code=>{window.__reject=code;},code);await start(page);await page.locator('#liters').waitFor();assert.equal((await stored(page)).fuelings.length,0);assert.equal(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).pending??null,journalKey),null);assert((await page.locator('body').innerText()).includes('Заказ не создан'));
  }));
  await check('real API price shift requires another explicit confirmation',()=>scenario(async page=>{
    await review(page);await page.evaluate(()=>{let values=[.5,.5,.5,.5,.1,.5];Math.random=()=>values.length?values.shift():.5;});await start(page);await page.locator('#liters').waitFor();assert((await page.locator('body').innerText()).includes('Цена изменилась'));await click(page,'Проверить заказ');assert.equal(await page.locator('#confirm').isChecked(),false);
  }));
  await check('timeout: API closes order and releases hold',()=>scenario(async page=>{
    await review(page);await page.evaluate(()=>{window.__random=.85;});await start(page);await active(page);await advance(page,65000);await page.getByRole('heading',{name:'Заправка отменена',exact:true}).waitFor();assert.equal((await stored(page)).limitLeft,9340);
  }));
  await check('station does not respond: API cancellation and no debit',()=>scenario(async page=>{
    await review(page);await page.evaluate(()=>{window.__random=.99;});await start(page);await active(page);await advance(page,8000);await page.getByRole('heading',{name:'Заправка отменена',exact:true}).waitFor();assert.equal((await stored(page)).limitLeft,9340);
  }));
  await check('second tab blocked by session lock',()=>scenario(async(page,context)=>{
    const other=await context.newPage();await other.goto(origin);await other.getByRole('heading',{name:'Открыта другая вкладка',exact:true}).waitFor();await other.close();
  }));
  await check('GPS failure: search works without invented distance',()=>scenario(async page=>{
    await page.evaluate(()=>{window.__geoFail=true;});await click(page,'Заправиться');await page.getByText('Местоположение недоступно.',{exact:false}).waitFor();await page.locator('#search').fill('Колесо');assert(await page.locator('[data-station]').count()>0);
  }));
  await check('unavailable journal blocks new order',()=>scenario(async page=>{
    await page.evaluate(k=>localStorage.setItem(k,'broken'),journalKey);await page.reload();await page.getByRole('button',{name:'Заправиться',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Заправиться',exact:true}).isDisabled(),true);
  }));
  await check('two tanks: separate orders, shared monetary limit',()=>scenario(async page=>{
    await review(page,'30');await start(page);await active(page);await advance(page,30000);await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();await click(page,'На главную');await click(page,'Заправиться');await page.locator('[data-station]').first().click();await page.locator('#purpose').selectOption('Рефрижератор');await page.locator('[data-pump]:not([disabled])').first().click();await page.locator('#liters').fill('50');await click(page,'Проверить заказ');await page.locator('#confirm').check();await start(page);await active(page);await advance(page,30000);await page.getByRole('heading',{name:'Заправка завершена',exact:true}).waitFor();const data=await stored(page);assert.equal(data.fuelings.length,2);assert.equal(data.limitLeft,Math.round((9340-data.fuelings.reduce((sum,f)=>sum+f.factAmount,0))*100)/100);
  }));
  await check('320px screen: form, review, ambiguous request have no horizontal overflow',()=>scenario(async page=>{
    await page.setViewportSize({width:320,height:720});await review(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>{window.__lose=true;});await start(page);await page.getByRole('heading',{name:'Проверяем заказ',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }));
  console.log(`\n${passed.length} browser checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});
