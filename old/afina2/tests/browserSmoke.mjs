// Standalone UI smoke test: serves the real frontend with an in-memory API.
// No live databases, Minecraft connections or existing browser profiles are used.
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { once } from "node:events"
import assert from "node:assert/strict"
import WebSocket from "ws"
import {policyFields,overrideFields} from "../src/core/corePolicy.js"
import {defaultOperationsPolicy} from '../src/core/operationsPolicy.js'
import {coreCapabilities,policySettingMetadata} from '../src/core/coreCapabilities.js'

const browser = process.env.AFINA_TEST_BROWSER ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const root = path.resolve("src/webTerminal/public")
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "afina-browser-"))
const mockApi = `
const coreFields=${JSON.stringify({policy:policyFields,override:overrideFields})};
const capabilities=${JSON.stringify(coreCapabilities({lifecycleAvailable:true}))};
const policyMetadata=${JSON.stringify(policySettingMetadata(policyFields,overrideFields,defaultOperationsPolicy))};
let testIncidents={},testReplacements=[],testProxies=[];
let corePolicy=JSON.parse(localStorage.getItem('corePolicy')||'null')||Object.fromEntries(Object.entries(coreFields.policy).map(([k,f])=>[k,f.type==='boolean'?false:f.min]));
let coreOverrides=JSON.parse(localStorage.getItem('coreOverrides')||'[]');
let decisions=JSON.parse(localStorage.getItem('coreDecisions')||'[]');
let coreRevision=1;
let operationsRevision=1;
let operationsPolicy=JSON.parse(localStorage.getItem('operationsPolicy')||'null')||${JSON.stringify({...defaultOperationsPolicy,capacity:{minimum:1,target:3,maximum:5},roles:{reseller:{enabled:true,minimum:0,target:2,maximum:4,priority:80,autoStart:true,autoReplace:true,stopMode:'finishCurrentCycle'},analyst:{enabled:true,minimum:1,target:1,maximum:2,priority:100,autoStart:true,autoReplace:true,stopMode:'graceful'}},schedules:[{id:'reseller-night',role:'reseller',weekdays:[1,2,3,4,5],start:'23:00',end:'07:00',enabled:true,roleEnabled:null,capacity:null}]})};
let market=JSON.parse(localStorage.getItem('testMarket')||'null')||{status:'observed',revision:1,items:[{itemId:1,name:'Apple',serverId:1,realm:101,lastObservedAt:Date.now(),dataAgeMs:12000,confidence:72,observationCount:5,independentLotCount:5,ownLotCount:2,excludedHighOutlierCount:1,invalidLotCount:0,independentSupply:100,ownSupply:64,sellerCount:3,medianPricePerItem:1000,minPricePerItem:400,p10:500,p25:750,p50:1000,p75:1100,p90:1200,retail:{lotCount:3,supply:7,medianPricePerItem:1180},medium:{lotCount:0,supply:0,medianPricePerItem:null},bulk:{lotCount:2,supply:128,medianPricePerItem:775},volatility:.04,freshness:'fresh',potentialWholesaleOpportunities:[{seller:'OtherUser',amount:64,pricePerItem:400,potentialSpread:780}]}]};
const analysis={analysts:[{botId:3,serverId:1,realm:101,state:'busy'}],activeSessions:[{analysisId:'test-analysis',botId:3,itemId:1,completedObservations:3,requestedObservations:5,startedAt:Date.now()-18000,nextRefreshAt:Date.now()+5000}],priorities:[{itemId:1,name:'Apple',serverId:1,realm:101,priority:82,eligible:false,reserved:true,reasons:[{code:'DATA_STALE',data:{contribution:35}}]}]};
let liveFuse={state:'UNARMED',generation:0};
const livePreflight=()=>({policy:operationsPolicy.liveValidation,fuse:{...liveFuse,state:window.testLiveConsumed?'CONSUMED':liveFuse.state},ready:false,blockers:['TRADING_EXECUTION_DISABLED'],checks:[{code:'QUANTITY_ONE',ok:true},{code:'PROXY_CONNECTED',ok:true}],preview:{itemId:1,itemName:'Apple',botId:1,botName:'Bot 1',incarnationId:'live-incarnation',serverId:1,realm:101,targetQuantity:1,planQuantity:4,quantityReduced:true,maxBuyPricePerItem:10,targetSellPricePerItem:20,maximumPurchaseCommitment:10,planId:'live-smoke-plan',proxy:{proxyId:1,label:'Safe validation proxy',host:'127.0.0.1',port:1080,reservationState:'RUNNING',transportConnected:true}},execution:window.testLiveConsumed?{workloadId:'live-smoke-workload',planId:'live-smoke-plan',botId:1,incarnationId:'live-incarnation',status:'UNCERTAIN',effectiveTerms:{targetQuantity:1},liveValidation:{planQuantity:4},timeline:[{at:Date.now(),code:'VALIDATION_FUSE_CONSUMED',sequence:null,data:{generation:1}},{at:Date.now(),code:'BUY_ATTEMPT_STARTED',sequence:3,data:{}}]}:null});
const coreSnapshot=()=>({proxyResources:{maximumBotsPerProxy:operationsPolicy.maximumBotsPerProxy??4,configured:testProxies.length,active:testProxies.filter(p=>p.active).length,used:0,available:testProxies.filter(p=>p.active).length*4,proxies:testProxies},policy:{...corePolicy,enabled:operationsPolicy.automationEnabled,targetResellers:operationsPolicy.roles.reseller.target,targetAnalysts:operationsPolicy.roles.analyst.target,autoReplaceBannedAccounts:operationsPolicy.recovery.autoReplaceBannedAccounts},overrides:coreOverrides,inputRevision:coreRevision,fields:coreFields,capabilities,policyMetadata,
 trading:{liveValidation:livePreflight(),executionEnabled:operationsPolicy.autonomousTradingEnabled,mode:operationsPolicy.autonomousTradingEnabled?'AUTONOMOUS':'SHADOW',executionBlocker:operationsPolicy.autonomousTradingEnabled?null:'TRADING_EXECUTION_DISABLED',plans:window.testTradingPlans??[{itemId:1,serverId:1,realm:101,decision:'BUY_RESELL',maxBuyPricePerItem:500,targetSellPricePerItem:1000,expectedProfitPerItem:500,expectedMargin:1,targetQuantity:4,confidence:80,sourceTimestamp:Date.now(),expiresAt:Date.now()+60000,reasons:['PROFITABLE_SPREAD'],execution:window.testTradingExecution}]},market,analysis,accountReplacements:testReplacements,economic:{eligibleBots:[{botId:1,name:'Bot 1'}],botReadiness:[{botId:1,name:'Bot 1',eligible:false,workerSafe:false,message:'Перевірте залишок товару',reason:'RESIDUAL_INVENTORY_REVIEW_REQUIRED'}],workloads:window.testEconomicRows??[]},
 workloads:[{botId:3,role:'analyst',type:'analysis',workloadId:'workload-smoke',state:'DRAINING',owner:'core',incarnationId:'workload-incarnation',startedAt:Date.now()-10000,updatedAt:Date.now(),draining:true,safe:false,uncertain:false,operation:'auction_analysis',reason:'LIFECYCLE_OWNED'},{botId:1,role:'reseller',type:'reseller_cycle',workloadId:'uncertain-smoke',state:'UNCERTAIN',owner:'configured_role',incarnationId:'reseller-incarnation',draining:true,safe:false,uncertain:true,reason:'PURCHASE_RESULT_UNCERTAIN'}],
 operationsPolicy:{...operationsPolicy,revision:operationsRevision,updatedAt:Date.now()},effectiveOperationsPolicy:{...operationsPolicy,roles:Object.fromEntries(Object.entries(operationsPolicy.roles).map(([id,r])=>[id,{...r,configuredTarget:r.target,scheduledTarget:r.target,executable:id==='analyst',blocker:id==='reseller'?'TRADING_EXECUTION_DISABLED':null}])),automationActive:operationsPolicy.automationEnabled&&!operationsPolicy.maintenanceMode,currentScheduleProfile:[],nextTransition:null},accountReserve:{ready:2,target:operationsPolicy.reserve.targetReadyAccounts},
 status:{status:corePolicy.enabled?'degraded':'disabled',actualResellers:0,desiredResellers:corePolicy.targetResellers,actualAnalysts:0,desiredAnalysts:corePolicy.targetAnalysts,pendingActions:0,blockedActions:1},
 lifecycle:[{botId:1,owner:'manual',intent:'running',failures:2,retryAt:Date.now()+5000,requestReason:'worker_crash',blockedReason:'MANUAL_OWNERSHIP',stopEvidence:{state:'unsafe'},nextTransition:'Очікування дозволу',incarnationId:'test-incarnation'}],
 cycle:{cycleId:42,startedAt:Date.now()-120,endedAt:Date.now(),durationMs:120,outcome:'deferred',stage:'SETTLE_WAIT',inputRevision:3,dataRevision:8,observationAt:Date.now(),candidatesConsidered:12,selected:8,reserved:7,dispatched:7,deferred:4,blocked:1,conflicts:1,failures:[],triggerCount:100,anotherCycleRequested:true,budgetReason:'ACTION_LIMIT'},
 observationCounts:{processes:3,connected:1,realmReady:1,workReady:1,uncertain:2},observation:{lastAuthoritativeAt:Date.now(),metrics:{queried:3,refreshed:1,timeouts:2,durationMs:1001}},
 transitionAccounting:{roles:{analyst:{desired:3,workReady:1,inProgress:1,uncovered:1,overshoot:0}}},activeActions:[{type:'START',botId:2,accountId:2,role:'analyst',state:'RUNNING',createdAt:Date.now(),deadlineAt:Date.now()+60000,attempt:1,policyRevision:1,quantity:1,created:0}],recentActions:[{type:'GENERATE',state:'FAILED',createdAt:Date.now(),deadlineAt:Date.now(),attempt:1,policyRevision:1,quantity:2,created:0,reason:'ACCOUNT_GENERATION_FAILED'}],
 actualState:{items:[{itemId:1,name:'Apple'}],bots:['FRESH','STALE','UNAVAILABLE'].map((quality,i)=>({botId:i+1,processAlive:true,minecraftConnected:i===0,realmReady:i===0,roleReady:i===0,workReady:i===0,positionStatus:i===0?'realm':'unknown',observationQuality:quality,lastObservedAt:Date.now()-i*20000,lastEventAt:null,lastProgressAt:Date.now()-60000,factSource:'worker_query',incarnationId:'test-incarnation-'+i,blocker:i?'WORKER_FACTS_TIMEOUT':null}))},desiredState:{revision:coreRevision},
 allocations:[{itemId:1,name:'Apple',desiredBots:corePolicy.targetResellers,actualBots:0,deficit:corePolicy.targetResellers,excess:0,status:'deficit'}],
 assessment:[{code:'CORE_DISABLED',message:'Core observes the system.'}],recentDecisions:decisions});
const persistCore=()=>{localStorage.setItem('corePolicy',JSON.stringify(corePolicy));localStorage.setItem('operationsPolicy',JSON.stringify(operationsPolicy));localStorage.setItem('coreOverrides',JSON.stringify(coreOverrides));localStorage.setItem('coreDecisions',JSON.stringify(decisions))};
const columns = [{name:'accountId',type:'INTEGER',pk:1,notnull:1,dflt_value:null},{name:'username',type:'TEXT',pk:0,notnull:1,dflt_value:null},{name:'password',type:'TEXT',pk:0,notnull:1,dflt_value:null,writeOnly:true}];
let row = {rowId:1,revision:'one',values:{accountId:1,username:'TestBot',password:'[redacted]'}};
const tgColumns=['telegramAccountId','phone','status','active','createdAt','linkedMinecraftAccounts'].map(name=>({name,type:'TEXT'}));
let tgRows=[];
let generatedRows=[];
let changed=false;
const bots=()=>[1,2,3].map(id=>({proxy:window.testBotProxy??null,definition:{botId:id,name:'Bot #'+id},snapshot:{botId:id,accountId:id,desiredState:id===1?'running':'stopped',supervisor:{status:id===1?'running':'offline'},runtime:{status:id===1?'running':'offline',position:'realm',balance:10000}},runtime:{desiredState:id===1?'running':'stopped',configuration:{restartRequired:changed&&id===1,changes:['акаунт'],autoRestart:false}}}));
export default class Api {
 setHandlers(handlers){this.handlers=handlers;window.coreTestEvent=record=>{decisions.unshift(record);persistCore();handlers.event({type:'core.decision.created',payload:record})};window.coreTestMarket=()=>{market.revision++;market.items[0].medianPricePerItem=1337;localStorage.setItem('testMarket',JSON.stringify(market));handlers.event({type:'core.market.updated',payload:{revision:market.revision,itemId:1,serverId:1,realm:101}})}}
 connect(){
   window.coreTestConflict=()=>{operationsRevision++};
   window.incidentTest=(id,incident)=>{testIncidents[id]=incident;this.handlers.event({id:'incident-'+Math.random(),type:'bot.runtime.incident',timestamp:Date.now(),source:{botId:id},payload:incident})};
   window.replacementTest=state=>{testReplacements=[{botId:1,bannedAccountId:1,replacementAccountId:4,state,reason:null}];this.handlers.event({type:'core.account.incident',payload:{type:state==='completed'?'ACCOUNT_REPLACED':'ACCOUNT_REPLACEMENT_SELECTED'}})};
   this.handlers.connection('connected');this.handlers.connected()
 }
 isConnected(){return true}
 async subscribeBot(){return {ok:true}}
 async unsubscribeBot(){return {ok:true}}
 async request(type,name,payload={}){
  let data;
  if(name==='core.getSnapshot') data=coreSnapshot();
  else if(name==='core.proxy.save'){const old=testProxies.find(p=>p.proxyId===payload.proxyId),clean={...payload};delete clean.password;delete clean.username;const row={proxyId:old?.proxyId??1,active:true,used:0,capacity:4,available:4,allocations:[],status:'SOCKS5',...old,...clean};testProxies=[row];data=row;}
  else if(name==='core.proxy.delete'){testProxies=[];data={};}
  else if(name==='core.liveValidation.arm'){liveFuse.state='ARMED';liveFuse.generation++;data=liveFuse;}
  else if(name==='core.liveValidation.disable'){operationsPolicy.liveValidation.enabled=false;operationsPolicy.autonomousTradingEnabled=false;operationsRevision++;data={};}
  else if(name==='core.economic.submit'){
    window.lastEconomicRequest=payload;
    if(payload.maxBuyPricePerItem===13)return {ok:false,error:{message:'INVALID_PRICE'}};
    const row={...payload,workloadId:'economic-smoke',status:'RUNNING',botId:1,progress:{boughtQuantity:4,listedQuantity:2,purchaseValue:40,remainingInventory:2,certainty:'KNOWN'}};
    window.testEconomicRows=[row];data=row;
  }
  else if(name==='core.economic.cancel'){window.testEconomicRows[0].status='CANCELLED';data=window.testEconomicRows[0]}
  else if(name==='core.economic.resolve'){const r=window.testEconomicRows[0];r.status='CANCELLED';r.result='OPERATOR_ACKNOWLEDGED_UNKNOWN';r.residualReview={at:Date.now(),note:payload.note,actorId:'operator'};r.operator.reviewRequired=false;r.operator.guidance='Історичну невизначеність збережено';data=r}
  else if(name==='core.market.details') data={lots:[{seller:'OurBot',amount:64,totalPrice:64000,pricePerItem:1000,classification:'OWN_LISTING',exclusionReason:'OWN_LISTING'},{seller:'StorageUser',amount:1,totalPrice:100000000,pricePerItem:100000000,classification:'HIGH_PRICE_OUTLIER',exclusionReason:'HIGH_PRICE_OUTLIER'}]};
  else if(name.startsWith('core.')){
    if(payload.expectedRevision!==(name==='core.operations.update'?operationsRevision:coreRevision)) return {ok:false,error:{message:'CORE_CONFLICT'}};
    if(name==='core.policy.update') {window.lastCorePolicyValues=payload.values;corePolicy={...corePolicy,...payload.values};operationsRevision++}
    if(name==='core.operations.update'){operationsPolicy=payload.values;operationsRevision++}
    if(name==='core.override.set') coreOverrides=[{itemId:payload.itemId,...payload.values}];
    if(name==='core.override.delete') coreOverrides=[];
    coreRevision++;
    window.coreTestEvent({decisionId:'decision-'+coreRevision,timestamp:Date.now(),action:name,result:'applied',trigger:{type:'USER_POLICY_UPDATED'},target:{},before:{},after:payload.values,reasons:[{code:'USER_POLICY_UPDATED',message:'Policy updated'}]});
    persistCore();data={inputRevision:coreRevision};
  }
  else if(['bot.start','bot.stop','bot.restart'].includes(name)){window.lastBotLifecycle={name,payload};data={accepted:true};}
  else if(name==='bots.get') data=bots().map(b=>({...b,runtime:{...b.runtime,incident:testIncidents[b.snapshot.botId]}}));
  else if(name==='bot.get') {data=bots().find(b=>b.snapshot.botId===payload.botId);data.runtime.incident=testIncidents[payload.botId]}
  else if(name.endsWith('history.get')) data={events:[]};
  else if(name==='database.catalog') data=[{database:'accounts',tables:[{table:'accountsData',columns}]},{database:'telegram',tables:[{table:'telegramAccounts',columns:tgColumns,readOnly:true}]},{database:'history',tables:[{table:'changeLog',readOnly:true}]}];
  else if(name==='database.read' && payload.table==='telegramAccounts') data={database:'telegram',table:'telegramAccounts',columns:tgColumns,readOnly:true,total:tgRows.length,offset:0,limit:50,rows:tgRows};
  else if(name==='database.read') data=payload.table==='changeLog' ? {database:'history',table:'changeLog',readOnly:true,columns:[{name:'operation',type:'TEXT'}],total:1,offset:0,limit:50,rows:[{rowId:1,values:{operation:'UPDATE'}}]} : {database:'accounts',table:'accountsData',columns,total:1+generatedRows.length,offset:0,limit:50,rows:[row,...generatedRows]};
  else if(name==='accounts.generate'){
    const accounts=Array.from({length:payload.count},(_,i)=>({accountId:i+2,username:'MiloRiver'+(i+2),status:'available'}));
    generatedRows=accounts.map(account=>({rowId:account.accountId,revision:'generated',values:{accountId:account.accountId,username:account.username,password:'hidden-test-password'}}));
    data={accounts,count:accounts.length};
  }
  else if(name==='database.mutate'){row={...row,revision:'two',values:{...row.values,...payload.values}};changed=true;data={changes:1};}
  else if(name==='telegram.startAuthorization') {if(payload.phone!=='+4712345678') throw new Error('Phone missing');data={state:'CODE_REQUIRED',authRequestId:'test-auth'};}
  else if(name==='telegram.submitCode') {if(payload.code!=='12345') return {ok:false,error:{message:'PHONE_CODE_INVALID'}};data={state:'PASSWORD_REQUIRED',authRequestId:'test-auth'};}
  else if(name==='telegram.submitPassword') {if(payload.password!=='test-2fa') throw new Error('Password missing');tgRows=[{rowId:1,values:{telegramAccountId:1,phone:'+4712345678',status:'connected',active:1,createdAt:'2026-09-17',linkedMinecraftAccounts:0}}];data={state:'AUTHORIZED',telegramAccountId:1,status:'connected'};}
  else if(name==='telegram.setActive'){tgRows=tgRows.map(r=>({...r,values:{...r.values,active:Number(payload.active)}}));data={};}
  else if(name==='telegram.delete') {tgRows=[];data={telegramAccountId:1};}
  return {ok:true,data};
 }
}`
const server = http.createServer(async (req, res) => {
    try{
        const url = new URL(req.url, "http://localhost")
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
        const file = path.resolve(root, relative)
        if(!file.startsWith(root + path.sep)) throw new Error("Invalid path")
        const content = relative === "js/webSocketApi.js" ? mockApi : await fs.readFile(file)
        res.setHeader("Content-Type", relative.endsWith(".js") ? "application/javascript; charset=utf-8" : relative.endsWith(".css") ? "text/css" : "text/html; charset=utf-8")
        res.end(content)
    }catch{res.writeHead(404);res.end()}
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
let child
let socket
try{
    child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {windowsHide: true, stdio: ["ignore", "ignore", "pipe"]})
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Browser startup timed out")), 15000)
        let output = ""
        child.on("error", error => {clearTimeout(timer);reject(error)})
        child.stderr.on("data", data => {
            output += data
            const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
            if(match){clearTimeout(timer);resolve(match[1])}
        })
    })
    socket = new WebSocket(endpoint)
    await once(socket, "open")
    let nextId = 1
    const pending = new Map()
    const errors = []
    socket.on("message", raw => {
        const message = JSON.parse(raw)
        if(message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text)
        const request = pending.get(message.id)
        if(request){pending.delete(message.id);clearTimeout(request.timer);message.error ? request.reject(message.error) : request.resolve(message.result)}
    })
    function send(method, params = {}, sessionId){
        return new Promise((resolve, reject) => {
            const id = nextId++
            const timer = setTimeout(() => {pending.delete(id);reject(new Error(method + " timed out"))}, 10000)
            pending.set(id, {resolve, reject, timer})
            socket.send(JSON.stringify({id, method, params, sessionId}))
        })
    }
    const {targetId} = await send("Target.createTarget", {url: "about:blank"})
    const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true})
    const command = (method, params) => send(method, params, sessionId)
    await command("Runtime.enable")
    await command("Page.enable")
    const evaluate = async expression => {
        const result = await command("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true})
        if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
        return result.result.value
    }
    const waitFor = expression => evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true)}else if(++n>100){clearInterval(timer);reject(new Error('UI timeout'))}},50)})`)
    await command("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false})
    await command("Page.navigate", {url: `http://127.0.0.1:${server.address().port}`})
    await waitFor("document.querySelectorAll('.bot-item').length===3")
    await evaluate("document.querySelectorAll('.bot-item')[1].click()")
    await waitFor("document.getElementById('botProxy')?.textContent.includes('не призначено')")
    await evaluate("document.getElementById('startButton').click()")
    await waitFor("window.lastBotLifecycle?.name==='bot.start'&&window.lastBotLifecycle.payload.botId===2")
    await evaluate("window.testBotProxy={proxyId:1,label:'Panel proxy',host:'127.0.0.1',port:1080,protocol:'socks5',active:true,reservationState:'RESERVED',currentIncarnation:true,transportConnected:false};document.querySelector('.bot-item').click()")
    await waitFor("document.getElementById('botProxy').textContent.includes('зарезервовано для запуску')")
    assert.equal(await evaluate("document.getElementById('botProxy').textContent.includes('з’єднання встановлено')"),false)
    await evaluate("window.testBotProxy={...window.testBotProxy,reservationState:'RUNNING'};document.querySelector('.bot-item').click()")
    await waitFor("document.getElementById('botProxy').textContent.includes('процес запущено через SOCKS5')")
    await evaluate("document.getElementById('stopButton').click()")
    await waitFor("window.lastBotLifecycle?.name==='bot.stop'&&!window.lastBotLifecycle.payload.force")
    await evaluate("document.getElementById('restartButton').click()")
    await waitFor("window.lastBotLifecycle?.name==='bot.restart'")
    await evaluate("window.testBotProxy={...window.testBotProxy,active:false,transportConnected:true,transportConnectedAt:Date.now()};document.querySelector('.bot-item').click()")
    await waitFor("document.getElementById('botProxy').textContent.includes('Вимкнений для нових запусків')&&document.getElementById('botProxy').textContent.includes('SOCKS5 з’єднання встановлено')")
    assert.equal(await evaluate("document.getElementById('botProxy').textContent.includes('127.0.0.1:1080')"),true)
    await evaluate("window.testBotProxy=null;document.querySelector('.bot-item').click()")
    await waitFor("document.getElementById('botProxy').textContent.includes('не призначено')")
    await evaluate("document.getElementById('databasePageTab').click()")
    await waitFor("document.querySelectorAll('#databaseRows tr').length===1")
    await evaluate("document.querySelector('#databaseRows button').click()")
    await waitFor("document.getElementById('databaseDialog').open")
    assert.equal(await evaluate("document.querySelector('#databaseFields input[type=password]').value"),"")
    await evaluate("document.querySelectorAll('#databaseFields input')[1].value='RenamedBot';document.getElementById('databaseForm').requestSubmit()")
    await waitFor("!document.getElementById('databaseDialog').open && document.getElementById('databaseRows').textContent.includes('RenamedBot')")
    assert.equal(await evaluate("document.getElementById('databaseRows').textContent.includes('test-secret')"),false)
    assert.equal(await evaluate("document.getElementById('generateAccountsForm').classList.contains('hidden')"),false)
    await evaluate("document.getElementById('generateAccountsCount').value='2';document.getElementById('generateAccountsForm').requestSubmit()")
    await waitFor("document.querySelectorAll('#databaseRows tr').length===3 && document.getElementById('databaseMessage').textContent.includes('available') && !document.getElementById('generateAccountsButton').disabled")
    await evaluate("document.querySelector('[data-table=changeLog]').click()")
    await waitFor("document.getElementById('databaseTitle').textContent==='changeLog'")
    assert.equal(await evaluate("document.getElementById('databaseAdd').disabled && !document.querySelector('#databaseRows button')"),true)
    await evaluate("document.querySelector('[data-table=accountsData]').click()")
    await waitFor("document.getElementById('databaseTitle').textContent==='accountsData'")
    await evaluate("document.getElementById('botsPageTab').click()")
    await waitFor("document.querySelectorAll('.configuration-badge').length===1")
    assert.equal(await evaluate("document.getElementById('configurationNotice').classList.contains('hidden')"), false)
    await evaluate("document.getElementById('addBotButton').click()")
    assert.equal(await evaluate("document.getElementById('newBotType').value==='test' && document.getElementById('newBotServerId').required && document.getElementById('newBotRealm').required"),true)
    await evaluate("document.getElementById('cancelAddBotButton').click()")
    await evaluate("document.getElementById('databasePageTab').click()")
    await evaluate("document.querySelector('[data-table=telegramAccounts]').click()")
    await waitFor("document.getElementById('databaseTitle').textContent==='telegramAccounts'")
    assert.equal(await evaluate("document.getElementById('databaseAdd').disabled"),false)
    await evaluate("document.getElementById('databaseAdd').click();document.getElementById('telegramAuthValue').value='+4712345678';document.getElementById('telegramAuthForm').requestSubmit()")
    await waitFor("document.getElementById('telegramAuthLabel').textContent.includes('Код')")
    await evaluate("document.getElementById('telegramAuthValue').value='00000';document.getElementById('telegramAuthForm').requestSubmit()")
    await waitFor("document.getElementById('telegramAuthError').textContent==='PHONE_CODE_INVALID'")
    assert.equal(await evaluate("document.getElementById('telegramAuthValue').value"),"")
    await evaluate("document.getElementById('telegramAuthValue').value='12345';document.getElementById('telegramAuthForm').requestSubmit()")
    await waitFor("document.getElementById('telegramAuthLabel').textContent.includes('2FA')")
    await evaluate("document.getElementById('telegramAuthValue').value='test-2fa';document.getElementById('telegramAuthForm').requestSubmit()")
    await waitFor("!document.getElementById('telegramAuthDialog').open && document.getElementById('databaseRows').textContent.includes('0 / 8')")
    assert.equal(await evaluate("document.getElementById('telegramAuthValue').value"),"")
    assert.equal(await evaluate("document.getElementById('databaseRows').textContent.includes('Змінити')"),false)
    await evaluate("[...document.querySelectorAll('#databaseRows button')].find(b=>b.textContent==='Вимкнути').click()")
    await waitFor("document.getElementById('databaseRows').textContent.includes('нові прив’язки заборонено')")
    await evaluate("[...document.querySelectorAll('#databaseRows button')].find(b=>b.textContent==='Увімкнути').click()")
    await waitFor("document.getElementById('databaseRows').textContent.includes('доступний для нових призначень')")
    const desktop = await command("Page.captureScreenshot", {format: "png"})
    await fs.mkdir("artifacts", {recursive: true})
    await fs.writeFile("artifacts/database-desktop.png", Buffer.from(desktop.data, "base64"))
    await command("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true})
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
    const mobile = await command("Page.captureScreenshot", {format: "png"})
    await fs.writeFile("artifacts/database-mobile.png", Buffer.from(mobile.data, "base64"))
    await command("Emulation.setDeviceMetricsOverride", {width:1440,height:1000,deviceScaleFactor:1,mobile:false})
    await evaluate("document.getElementById('corePageTab').click()")
    await waitFor("document.getElementById('corePolicy_targetResellers')")
    await evaluate("const f=document.getElementById('proxyForm');f.elements.name.value='Smoke proxy';f.elements.host.value='localhost';f.elements.port.value='1080';f.elements.username.value='secret-user';f.elements.password.value='secret-pass';f.requestSubmit()")
    await waitFor("document.getElementById('proxyRows').textContent.includes('Smoke proxy')")
    assert.equal(await evaluate("document.getElementById('proxyForm').elements.password.value"),'')
    assert.equal(await evaluate("document.getElementById('proxyRows').textContent.includes('secret-pass')"),false)
    await evaluate("[...document.querySelectorAll('#proxyRows button')].find(b=>b.textContent==='Вимкнути').click()")
    await waitFor("[...document.querySelectorAll('#proxyRows button')].some(b=>b.textContent==='Увімкнути')")
    await evaluate("[...document.querySelectorAll('#proxyRows button')].find(b=>b.textContent==='Видалити').click()")
    await waitFor("!document.getElementById('proxyRows').textContent.includes('Smoke proxy')")
    await waitFor("document.querySelector('.derived-capacity')")
    assert.equal(await evaluate("Boolean(document.getElementById('coreOperationsJson'))"),false)
    assert.equal(await evaluate("document.getElementById('coreOperationsFields').textContent.includes('Автоматизація') && document.getElementById('coreOperationsFields').textContent.includes('Кількість ботів')"),true)
    assert.equal(await evaluate("document.querySelector('.derived-capacity').textContent"),'3')
    assert.equal(await evaluate("document.getElementById('coreAutomationDiagnostic').textContent.includes('Очікується перша синхронізація')"),true)
    assert.equal(await evaluate("document.getElementById('operations_roles_reseller_autoStart').checked && document.getElementById('operations_roles_reseller_autoStart').disabled && Boolean(document.getElementById('operations_roles_reseller_autoStart').closest('[data-compatibility]'))"),true)
    assert.equal(await evaluate("document.getElementById('coreCapabilities').textContent.includes('налаштована ціль 2') && document.getElementById('coreCapabilities').textContent.includes('ефективна ціль 2') && document.getElementById('coreCapabilities').textContent.includes('TRADING_EXECUTION_DISABLED')"),true)
    assert.equal(await evaluate("['enabled','targetResellers','targetAnalysts','autoReplaceBannedAccounts','allowAutomaticAccountGeneration','maxAccounts','autoAllocateBots'].every(k=>document.getElementById('corePolicy_'+k).disabled)"),true)
    assert.equal(await evaluate("document.getElementById('operations_roles_reseller_stopMode').selectedOptions[0].textContent"),'Завершити поточний цикл')
    assert.equal(await evaluate("document.getElementById('operations_schedules_0_start').value+'-'+document.getElementById('operations_schedules_0_end').value"),'23:00-07:00')
    assert.equal(await evaluate("document.querySelector('[data-schedule-capacity=\"0\"]').checked"),false)
    assert.equal(await evaluate("document.querySelector('[data-duration-path=\"transitions.startIntervalMs\"]').value+' '+document.querySelector('[data-duration-unit=\"transitions.startIntervalMs\"]').selectedOptions[0].textContent"),'10 секунд')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.help-popover')).display"),'none')
    await evaluate("document.querySelector('.help-button').focus()")
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.help-popover')).display"),'none')
    await evaluate("document.getElementById('operations_roles_reseller_target').value='6';document.getElementById('operations_roles_reseller_target').dispatchEvent(new Event('input',{bubbles:true}))")
    assert.equal(await evaluate("document.getElementById('coreOperationsValidation').textContent.includes('ціль не може перевищувати максимум')"),true)
    assert.equal(await evaluate("document.getElementById('coreOperationsDirty').textContent.includes('незбережені') && !document.getElementById('coreOperationsCancel').disabled"),true)
    await evaluate("document.getElementById('coreOperationsCancel').click()")
    assert.equal(await evaluate("document.querySelector('[data-duration-path=\"transitions.startIntervalMs\"]').value+' '+document.querySelector('[data-duration-unit=\"transitions.startIntervalMs\"]').value"),'10 1000')
    await evaluate("document.getElementById('operations_maintenanceMode').checked=true;document.getElementById('operations_maintenanceMode').dispatchEvent(new Event('input',{bubbles:true}))")
    assert.equal(await evaluate("document.getElementById('coreOperationsImpact').textContent.includes('запитує безпечну зупинку')"),true)
    await evaluate("document.getElementById('coreOperationsForm').requestSubmit()")
    await waitFor("document.getElementById('coreOperationsRevision').textContent.includes('2') && document.getElementById('coreOperationsDirty').textContent==='' ")
    await evaluate("window.coreTestConflict();document.getElementById('operations_allocationEnabled').checked=false;document.getElementById('operations_allocationEnabled').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('coreOperationsForm').requestSubmit()")
    await waitFor("document.getElementById('coreOperationsValidation').textContent.includes('Політику вже змінено')")
    assert.equal(await evaluate("document.getElementById('coreOperationsDirty').textContent.includes('незбережені')"),true)
    await evaluate("document.getElementById('coreOperationsCancel').click();document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreOperationsRevision').textContent.includes('3')")
    assert.equal(await evaluate("document.getElementById('corePolicy_targetResellers').value"),'2')
    assert.equal(await evaluate("document.getElementById('corePolicy_autoReplaceBannedAccounts').checked || document.getElementById('corePolicy_allowAutomaticAccountGeneration').checked"),false)
    assert.equal(await evaluate("document.getElementById('corePolicy_maxAccounts').value"),'0')
    assert.equal(await evaluate("document.getElementById('corePolicy_autoReplaceBannedAccounts').closest('details').dataset.group"),'legacy')
    await evaluate("document.getElementById('corePolicy_autoReplaceBannedAccounts').checked=true")
    assert.equal(await evaluate("document.getElementById('corePolicy_antiAfkEnabled').closest('details').querySelector('summary').textContent"),'Виконання ботів · Anti-AFK та готовність')
    assert.equal(await evaluate("document.getElementById('corePolicy_analysisRealmReadyDelayMs').closest('details').dataset.group"),'runtime')
    await evaluate("document.getElementById('corePolicy_antiAfkEnabled').checked=true;document.getElementById('corePolicy_antiAfkMinIntervalMs').value='35000';document.getElementById('corePolicy_antiAfkMaxIntervalMs').value='50000';document.getElementById('corePolicy_analysisRealmReadyDelayMs').value='15000';document.getElementById('corePolicy_analysisRealmReadyDelayJitterMs').value='3000'")
    assert.equal(await evaluate("document.getElementById('coreOverview').textContent.includes('Ядро вимкнено')"),true)
    assert.equal(await evaluate("document.getElementById('coreOverview').textContent.includes('Процеси / готові до роботи3 / 1')"),true)
    assert.equal(await evaluate("['Свіже','Застаріле','Недоступне','WORKER_FACTS_TIMEOUT'].every(text=>document.getElementById('coreObservationRows').textContent.includes(text))"),true)
    assert.equal(await evaluate("document.querySelectorAll('#coreObservationRows tbody tr').length"),3)
    assert.equal(await evaluate("document.getElementById('coreObservation').textContent.includes('невизначені: 2')"),true)
    assert.equal(await evaluate("document.getElementById('coreActions').textContent.includes('Автономні дії та переходи')"),true)
    assert.equal(await evaluate("['Цикл №42','Відкладено','вибрано: 8','зарезервовано: 7','відкладено: 4','конфліктів: 1','Сигналів об’єднано: 100','наступний цикл запитано: Так','Ліміт дій'].every(text=>document.getElementById('coreCycle').textContent.includes(text))"),true)
    assert.equal(await evaluate("document.getElementById('operations_controller_maxActionsPerCycle').disabled"),false)
    assert.equal(await evaluate("document.getElementById('operations_controller_maxActionsPerCycle').value"),'8')
    assert.equal(await evaluate("document.querySelector('[data-duration-path=\"controller.yieldBudgetMs\"]').value"),'0.01')
    assert.equal(await evaluate("['Запуск','Виконується','Помилка','ACCOUNT_GENERATION_FAILED'].every(text=>document.getElementById('coreActionRows').textContent.includes(text))"),true)
    assert.equal(await evaluate("['Оператор','Зупинка небезпечна','MANUAL_OWNERSHIP','Очікування дозволу','test-incarnation'].every(text=>document.getElementById('coreLifecycleRows').textContent.includes(text))"),true)
    assert.equal(await evaluate("['Аналітик','Перепродажник','workload-smoke','Завершує поточну роботу','Результат непідтверджений','Налаштована роль','workload-incarnation','Не підтверджено','Невизначено','PURCHASE_RESULT_UNCERTAIN'].every(text=>document.getElementById('coreWorkloadRows').textContent.includes(text))"),true)
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#coreTransitionCoverage tbody tr:first-child td')).map(td=>td.textContent)"),['analyst','3','1','1','1','0'])
    await evaluate("document.getElementById('corePolicy_targetResellers').value='99';document.getElementById('corePolicyForm').dispatchEvent(new Event('input'));document.getElementById('corePolicyForm').requestSubmit()")
    await waitFor("window.lastCorePolicyValues && !document.getElementById('corePolicySave').disabled")
    assert.equal(await evaluate("Object.keys(window.lastCorePolicyValues).every(k=>k.startsWith('antiAfk')||k.startsWith('analysisRealmReady'))"),true)
    assert.equal(await evaluate("document.getElementById('corePolicy_targetResellers').value"),'2')
    assert.equal(await evaluate("document.getElementById('coreAllocations').textContent.includes('Apple')"),true)
    await evaluate("document.getElementById('coreOverride_maxBots').value='1';document.getElementById('coreOverrideForm').requestSubmit()")
    await waitFor("document.querySelectorAll('#coreOverrides tbody tr').length===1 && !document.getElementById('coreOverrideDelete').disabled")
    await evaluate("document.getElementById('coreOverrideDelete').click()")
    await waitFor("document.querySelectorAll('#coreOverrides tbody tr').length===0")
    await evaluate("window.coreTestEvent({decisionId:'live-test',timestamp:Date.now(),action:'LIVE_DECISION',result:'blocked',trigger:{type:'TEST'},target:{botId:1},reasons:[{code:'SAFE_TRANSITION_UNAVAILABLE',message:'Waiting for a safe transition'}]})")
    await waitFor("document.getElementById('coreDecisions').textContent.includes('LIVE_DECISION')")
    await command('Page.reload')
    await waitFor("document.querySelectorAll('.bot-item').length===3")
    await evaluate("document.getElementById('corePageTab').click()")
    await waitFor("document.getElementById('corePolicy_targetResellers')?.value==='2' && document.getElementById('coreDecisions').textContent.includes('LIVE_DECISION')")
    assert.equal(await evaluate("document.getElementById('corePolicy_antiAfkEnabled').checked"),true)
    assert.equal(await evaluate("document.getElementById('corePolicy_autoReplaceBannedAccounts').checked"),false)
    assert.equal(await evaluate("document.getElementById('corePolicy_antiAfkMinIntervalMs').value"),'35000')
    assert.equal(await evaluate("document.getElementById('corePolicy_analysisRealmReadyDelayMs').value"),'15000')
    assert.equal(await evaluate("document.getElementById('corePolicy_analysisRealmReadyDelayJitterMs').value"),'3000')
    await evaluate("document.getElementById('coreEconomicBuy').value='13';document.getElementById('coreEconomicSell').value='20';document.getElementById('coreEconomicQuantity').value='10';document.getElementById('coreEconomicForm').requestSubmit()")
    await waitFor("document.getElementById('coreEconomicMessage').textContent.includes('INVALID_PRICE')")
    await evaluate("document.getElementById('coreEconomicBuy').value='10';document.getElementById('coreEconomicForm').dispatchEvent(new Event('input'));document.getElementById('coreEconomicForm').requestSubmit()")
    await waitFor("document.getElementById('coreEconomicRows').textContent.includes('Куплено 4/10')")
    assert.equal(await evaluate("window.lastEconomicRequest.itemId===1&&window.lastEconomicRequest.maxBuyPricePerItem===10&&window.lastEconomicRequest.targetSellPricePerItem===20&&window.lastEconomicRequest.targetQuantity===10&&typeof window.lastEconomicRequest.requestId==='string'"),true)
    await evaluate("document.querySelector('#coreEconomicRows button[data-workload-id]').click()")
    await waitFor("document.getElementById('coreEconomicRows').textContent.includes('Скасовано')")
    await evaluate("window.testEconomicRows[0].status='UNCERTAIN';window.testEconomicRows[0].progress.certainty='UNCERTAIN';document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreEconomicRows').textContent.includes('Облік непідтверджений')")
    await evaluate("window.testEconomicRows[0].operator={reviewRequired:true,reviewKind:'UNCERTAIN',canResolve:false,workerSafe:false,workerUncertain:true,admissionReason:'WORKLOAD_UNCERTAIN',observedMatchingInventory:2,attributedRemainingQuantity:null,confirmedOperation:'listing_acknowledged',guidance:'Зупиніть старий процес і перевірте інвентар'};document.getElementById('coreRefresh').click()")
    await waitFor("document.querySelector('[data-resolve-workload]')?.disabled===true")
    assert.equal(await evaluate("document.getElementById('coreEconomicReadiness').textContent.includes('RESIDUAL_INVENTORY_REVIEW_REQUIRED')"),true)
    await evaluate("window.testEconomicRows[0].operator.canResolve=true;document.getElementById('coreRefresh').click()")
    await waitFor("document.querySelector('[data-resolve-workload]')?.disabled===false")
    await evaluate("document.querySelector('[data-resolution-note]').value='Inventory and listings checked externally';document.querySelector('[data-resolve-workload]').click()")
    await waitFor("document.getElementById('coreEconomicRows').textContent.includes('Inventory and listings checked externally')")
    assert.equal(await evaluate("window.testEconomicRows[0].progress.certainty==='UNCERTAIN'&&window.testEconomicRows[0].operator.workerUncertain"),true)
    await evaluate("window.testEconomicRows[0].status='FAILED';window.testEconomicRows[0].operator={...window.testEconomicRows[0].operator,reviewRequired:true,reviewKind:'RESIDUAL',canResolve:true,attributedRemainingQuantity:2};document.getElementById('coreRefresh').click()")
    await waitFor("document.querySelector('[data-resolve-workload]')?.textContent.includes('перевірку залишку')")
    await waitFor("document.getElementById('coreMarketRows').textContent.includes('Apple')")
    assert.equal(await evaluate("document.getElementById('coreMarketDetails').textContent.includes('Наші лоти2')"),true)
    assert.equal(await evaluate("document.getElementById('coreMarketDetails').textContent.includes('Виключені high outliers1')"),true)
    assert.equal(await evaluate("document.getElementById('coreAnalysts').textContent.includes('3 / 5')"),true)
    assert.equal(await evaluate("document.getElementById('coreAnalysisPriorities').textContent.includes('DATA_STALE')"),true)
    await evaluate("document.getElementById('coreMarketDiagnostics').open=true")
    await waitFor("document.getElementById('coreMarketLots').textContent.includes('OWN_LISTING') && document.getElementById('coreMarketLots').textContent.includes('HIGH_PRICE_OUTLIER')")
    assert.equal(await evaluate("document.getElementById('coreTradingRows').textContent.includes('PROFITABLE_SPREAD')"),true)
    assert.equal(await evaluate("document.getElementById('coreTradingRows').textContent.includes('100.0%')"),true)
    assert.equal(await evaluate("document.getElementById('coreTradingRows').querySelector('button')===null"),true)
    await evaluate("window.testTradingPlans=[{itemId:1,decision:'HOLD',targetQuantity:0,confidence:0,sourceTimestamp:null,expiresAt:Date.now(),reasons:['DATA_STALE','LOW_CONFIDENCE']}];window.coreTestMarket()")
    await waitFor("document.getElementById('coreTradingRows').textContent.includes('DATA_STALE')")
    await waitFor("document.getElementById('coreMarketDetails').textContent.includes('780') && document.getElementById('coreMarketStatus').textContent.includes('revision 2')")
    await command('Page.reload')
    await waitFor("document.querySelectorAll('.bot-item').length===3")
    await evaluate("document.getElementById('corePageTab').click()")
    await waitFor("document.getElementById('coreMarketStatus').textContent.includes('revision 2')")
    assert.equal(await evaluate("document.getElementById('coreMarketRows').textContent.replace(/[\\s,]/g,'').includes('1337')"),true)
    assert.equal(await evaluate("/test-secret|hidden-test-password|test-2fa/.test(document.getElementById('corePage').textContent)"),false)
    assert.equal(await evaluate("document.getElementById('coreTradingExecutionStatus').textContent.includes('Вимкнено')"),true)
    assert.equal(await evaluate("document.getElementById('operations_autonomousTradingEnabled').disabled"),false)
    assert.equal(await evaluate("document.getElementById('operations_autonomousTradingMaxConcurrentWorkloads').value"),'1')
    await evaluate("const input=document.getElementById('operations_autonomousTradingEnabled');input.checked=true;input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('coreOperationsForm').requestSubmit()")
    await waitFor("document.getElementById('coreTradingExecutionStatus').textContent.includes('Увімкнено')")
    assert.equal(await evaluate("document.getElementById('coreTradingExecutionStatus').textContent.includes('TRADING_EXECUTION_DISABLED')"),false)
    await evaluate("window.testTradingExecution={status:'RUNNING',source:'AUTONOMOUS_TRADING',workloadId:'auto-smoke-workload',botId:1,reason:null};document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreTradingRows').textContent.includes('auto-smoke-workload') && document.getElementById('coreTradingRows').textContent.includes('виконується')")
    await evaluate("window.testTradingExecution.status='UNCERTAIN';window.testTradingExecution.reason='ITEM_ECONOMIC_UNCERTAIN';document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreTradingRows').textContent.includes('невизначено')")
    await evaluate("const disableTradingInput=document.getElementById('operations_autonomousTradingEnabled');disableTradingInput.checked=false;disableTradingInput.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('coreOperationsForm').requestSubmit()")
    await waitFor("document.getElementById('coreTradingExecutionStatus').textContent.includes('Вимкнено')")
    assert.equal(await evaluate("document.getElementById('coreLiveValidation').textContent.includes('Fuse: UNARMED')"),true)
    await evaluate("document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreLiveValidation').textContent.includes('Fuse: UNARMED')")
    await evaluate("for(const [id,value] of [['operations_liveValidation_enabled',true],['operations_liveValidation_itemId',1],['operations_liveValidation_maxPurchaseCommitment',10]]){const input=document.getElementById(id);if(typeof value==='boolean')input.checked=value;else input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))}document.getElementById('coreOperationsForm').requestSubmit()")
    await waitFor("document.getElementById('coreLiveValidation').textContent.includes('Live validation: Увімкнено')")
    await evaluate("[...document.querySelectorAll('#coreLiveValidation button')].find(b=>b.textContent.includes('Озброїти')).click()")
    await waitFor("document.getElementById('coreLiveValidation').textContent.includes('Fuse: ARMED')")
    assert.equal(await evaluate("document.getElementById('coreLiveValidation').textContent.includes('зменшено з 4') && document.getElementById('coreLiveValidation').textContent.includes('Safe validation proxy') && document.getElementById('coreLiveValidation').textContent.includes('live-smoke-plan')"),true)
    await evaluate("window.testLiveConsumed=true;document.getElementById('coreRefresh').click()")
    await waitFor("document.getElementById('coreLiveValidation').textContent.includes('Fuse: CONSUMED') && document.getElementById('coreLiveValidation').textContent.includes('BUY_ATTEMPT_STARTED')")
    await evaluate("[...document.querySelectorAll('#coreLiveValidation button')].find(b=>b.textContent.includes('Вимкнути validation')).click()")
    await waitFor("document.getElementById('coreLiveValidation').textContent.includes('Live validation: Вимкнено')")
    assert.equal(await evaluate("document.getElementById('coreLiveValidation').textContent.includes('Fuse: CONSUMED')"),true)
    const coreDesktop=await command('Page.captureScreenshot',{format:'png'})
    await fs.writeFile('artifacts/core-desktop.png',Buffer.from(coreDesktop.data,'base64'))
    await command("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true})
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true)
    const coreMobile=await command('Page.captureScreenshot',{format:'png'})
    await fs.writeFile('artifacts/core-mobile.png',Buffer.from(coreMobile.data,'base64'))
    await evaluate("document.getElementById('coreMarketStatus').scrollIntoView()")
    const marketMobile=await command('Page.captureScreenshot',{format:'png'})
    await fs.writeFile('artifacts/market-mobile.png',Buffer.from(marketMobile.data,'base64'))
    await command("Emulation.setDeviceMetricsOverride", {width:1440,height:1000,deviceScaleFactor:1,mobile:false})
    await evaluate("document.getElementById('coreMarketStatus').scrollIntoView()")
    const marketDesktop=await command('Page.captureScreenshot',{format:'png'})
    await fs.writeFile('artifacts/market-desktop.png',Buffer.from(marketDesktop.data,'base64'))
    await evaluate("window.replacementTest('initializing')")
    await waitFor("document.getElementById('coreAccountReplacements').textContent.includes('Реєстрація / вхід / готовність')")
    assert.equal(await evaluate("document.getElementById('coreAccountReplacements').textContent.includes('Роботу відновлено')"),false)
    await evaluate("window.replacementTest('completed')")
    await waitFor("document.getElementById('coreAccountReplacements').textContent.includes('Роботу відновлено')")
    await evaluate("document.getElementById('botsPageTab').click();window.incidentTest(1,{type:'ACCOUNT_BANNED',banReason:'bot',banDetectedAt:Date.now(),banIssuedAtRaw:'19.09.2026 04:05:42',banDurationRaw:'1 д',punishmentId:'20030647',rawMessage:'<script>test</script> ВЫ ЗАБАНЕНЫ!'})")
    await waitFor("document.getElementById('runtimeIncidentNotice')?.textContent.includes('20030647') && document.querySelector('.bot-item-state').textContent.includes('Banned')")
    assert.equal(await evaluate("document.getElementById('runtimeIncidentNotice').querySelector('script')"),null)
    assert.equal(await evaluate("document.getElementById('runtimeIncidentNotice').querySelector('details').open"),false)
    assert.equal(await evaluate("document.getElementById('botList').textContent.includes('ВЫ ЗАБАНЕНЫ')"),false)
    await evaluate("window.incidentTest(1,{type:'INVENTORY_BLOCKED_BY_IGNORED_ITEMS',affectedSlots:[36],itemSummaries:[{name:'stone',slot:36,amount:1}]})")
    await waitFor("document.getElementById('runtimeIncidentNotice').textContent.includes('слот 36') && document.querySelector('.bot-item-state').textContent.includes('Blocked')")
    await command("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true})
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true)
    const incidentMobile=await command('Page.captureScreenshot',{format:'png'})
    await fs.writeFile('artifacts/incidents-mobile.png',Buffer.from(incidentMobile.data,'base64'))
    assert.deepEqual(errors, [])
    console.log("PASS: database/Telegram/Core UI; Market rows, details, own/outlier diagnostics, Analyst progress, priorities, live updates, reload persistence, responsive layout and no JS exceptions.")
    await send("Browser.close").catch(() => {})
}finally{
    socket?.close()
    child?.kill()
    server.closeAllConnections()
    server.close()
    // Chrome may still hold profile files briefly on Windows.
    await fs.rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => {})
}
