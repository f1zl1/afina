import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import DatabaseStore from "../src/data/databaseStore.js"
import { schema, addChangeTracking, upgradeToVersion2 } from "../src/data/databaseSchema.js"
import DatabaseEditor from "../src/data/databaseEditor.js"
import TelegramAccountStore from "../src/telegram/telegramAccountStore.js"
import TelegramAccountPool from "../src/resources/telegramAccountPool.js"
import TelegramManager from "../src/telegram/telegramManager.js"
import { detectMinecraftMessage, detectTelegramMessage } from "../src/telegram/messageDetector.js"
import { telegramError } from "../src/telegram/telegramErrors.js"
import EventBus from "../src/eventBus/eventBusMain.js"
import Core from "../src/core/coreMain.js"
import MtprotoClient, { channelDestination } from "../src/telegram/mtprotoClient.js"
import { Api, Button } from "teleproto"
import MessageEvents from "../src/minecraftBot/handlers/botEvents/messageEvents.js"

const config={apiId:123,apiHash:"a".repeat(32)}
const binding="§cПривяжите аккаунт к ВК или Телеграм!\nВведите /vk или /tg"
const login="Подтвердите вход через ВК или ТГ: Проверьте личные сообщения!"
const subscription="[Бот] Подпишитесь на официальный канал, чтобы привязать аккаунт!"
class FakeClient{
    constructor(options={}){this.options=options;this.connected=false;this.valid=true;this.calls=[];this.phone="+4712345678"}
    async connect(){this.connected=true}
    async authorized(){return this.valid}
    async close(){this.connected=false;this.closed=true}
    save(){return "secret-session"}
    async sendCode(){this.calls.push("sendCode");return "secret-code-hash"}
    async signIn(phone, hash, code){
        this.phone=phone
        if(code === "00000") throw {errorMessage:"PHONE_CODE_INVALID"}
        if(code === "22222") throw {errorMessage:"SESSION_PASSWORD_NEEDED"}
    }
    async password(value){if(value !== "private-2fa") throw {errorMessage:"PASSWORD_HASH_INVALID"}}
    async identity(){return {phone:this.phone}}
    async listen(handler){this.handler=handler}
    async sendBinding(nick,password){this.calls.push(["bind",nick,password])}
    async joinChannel(destination,guard){assert.equal(guard(),true);this.calls.push(["join",destination])}
}
async function fixture(t,options={}){
    const dir=await mkdtemp(path.join(tmpdir(),"afina-telegram-"))
    const db=new DatabaseStore({databasePath:path.join(dir,"afina.db")})
    await db.init()
    const store=new TelegramAccountStore(db)
    const events=[],logs=[],clients=[]
    const logger={child(){return this},info(...args){logs.push(args)},warn(...args){logs.push(args)},error(...args){logs.push(args)},debug(){}}
    const eventBus=new EventBus({logger})
    eventBus.onAny(event=>events.push(event))
    const bots=new Map()
    const restarts=[]
    const botManager={getBot:id=>bots.get(id),async restartBot(id){
        assert.equal(manager.pendingOperations.has(`${id}:binding`),false)
        restarts.push(id);bots.get(id).restartRequested=true;bots.get(id).supervisorStatus="stopping"
    }}
    const pool=new TelegramAccountPool({store,logger})
    const manager=new TelegramManager({store,pool,botManager,eventBus,logger,config:{...config,...options},clientFactory:opts=>{
        const client=new FakeClient(opts);clients.push(client);return client
    }})
    t.after(async()=>{await manager.stop();db.close();await rm(dir,{recursive:true,force:true})})
    const account=(id,tg=null)=>{
        db.prepare("INSERT INTO accountsData(accountId,username,password,telegramAccountId) VALUES(?,?,?,?)").run(id,"Player"+id,"minecraft-secret",tg)
        bots.set(id,{accountId:id,workerPid:100+id,desiredState:"running",supervisorStatus:"running",isRunning:()=>true,calls:[],async sendChat(text){this.calls.push(text)}})
    }
    const telegram=async phone=>{
        const id=store.save(phone,"secret-session")
        const client=new FakeClient()
        await client.connect()
        await manager.activate(id,client)
        return {id,client}
    }
    const minecraft=(id,text)=>({type:"bot.chat.message",source:{accountId:id,botId:id,workerPid:100+id},payload:{text,kind:"server"}})
    const message=(nick,type="login_confirmation",extra={})=>({
        id:"msg-"+nick,senderId:"55",chatId:"55",peerId:"55",date:Date.now(),buttons:["Принять","Отклонить","Восстановить","Кикнуть"],
        text:type === "binding" ? `[Бот] Аккаунт ${nick} был привязан к Текущей странице!` :
            type === "login_observed" ? `Успешный вход в аккаунт ${nick} (81.1.1.1). /recovery ${nick}` :
                `Кто-то успешно ввёл пароль от аккаунта ${nick} (81.1.1.1). Подтвердите или отклоните вход`,
        accept:async()=>{throw new Error("Unexpected click")},...extra
    })
    return {dir,db,store,events,logs,clients,logger,eventBus,bots,botManager,pool,manager,account,telegram,minecraft,message,restarts}
}

test("Telegram migration v2 -> v3 preserves accounts, credentials and backups",async t=>{
    const dir=await mkdtemp(path.join(tmpdir(),"afina-tg-v3-"))
    const config={databasePath:path.join(dir,"afina.db")}
    const old=new DatabaseSync(config.databasePath)
    old.exec(schema);addChangeTracking(old);upgradeToVersion2(old)
    old.exec("PRAGMA user_version=2; INSERT INTO schemaMigrations VALUES(1,'before'),(2,'before'); INSERT INTO accountsData(username,password) VALUES('Existing','existing-secret')")
    old.close()
    const store=new DatabaseStore(config)
    t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
    await store.init()
    assert.equal(store.prepare("PRAGMA user_version").get().user_version,16)
    assert.equal(store.prepare("SELECT password FROM accountsData").get().password,"existing-secret")
    assert.equal(store.prepare("SELECT telegramAccountId FROM accountsData").get().telegramAccountId,null)
    assert.equal((await readdir(path.join(dir,"backups"))).length,1)
    assert.deepEqual(store.prepare("PRAGMA foreign_key_check").all(),[])
})

test("atomic first-fit allocation, concurrent capacity, stable assignment and delete protection",async t=>{
    const f=await fixture(t)
    const tg1=await f.telegram("+4711111111"),tg2=await f.telegram("+4722222222")
    for(let i=1;i<=17;i++) f.account(i,i<=7 ? tg1.id : null)
    const results=await Promise.all([8,9,10,11,12,13,14,15,16,17].map(id=>Promise.resolve().then(()=>f.pool.acquireForMinecraftAccount(id,f.manager.availableIds())).catch(error=>error)))
    assert.equal(results[0].telegramAccountId,tg1.id)
    assert.equal(results[1].telegramAccountId,tg2.id)
    assert.equal(results[9].code,"telegram:noAvailableAccount")
    assert.equal(f.store.count(tg1.id),8);assert.equal(f.store.count(tg2.id),8)
    assert.throws(()=>f.db.prepare("UPDATE accountsData SET telegramAccountId=? WHERE accountId=17").run(tg1.id),/CAPACITY/)
    assert.deepEqual(f.pool.acquireForMinecraftAccount(1,new Set()),{telegramAccountId:tg1.id,changed:false})
    await assert.rejects(f.manager.remove(tg1.id),error=>error.code === "TELEGRAM_ACCOUNT_IN_USE")
    assert.equal(f.store.get(tg1.id).session,"secret-session")
    const empty=await f.telegram("+4733333333")
    await f.manager.remove(empty.id)
    assert.equal(f.store.get(empty.id),undefined);assert.equal(empty.client.closed,true)
    assert.equal(tg1.client.connected,true)
})

test("database API never exposes or searches sessions/passwords and forbids generic Telegram mutations",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1,tg.id)
    const editor=new DatabaseEditor({store:f.db})
    const request={database:"telegram",table:"telegramAccounts"}
    const read=editor.read(request)
    assert.equal(read.rows[0].values.linkedMinecraftAccounts,1)
    assert.equal(read.columns.some(column=>column.name === "session"),false)
    assert.equal(JSON.stringify([read,editor.catalog()]).includes("secret-session"),false)
    assert.equal(editor.read({...request,search:"secret-session"}).total,0)
    for(const operation of ["insert","update","delete"]) assert.throws(()=>editor.mutate({...request,operation,values:{session:"manual"}}),/read-only/)
    const accounts={database:"accounts",table:"accountsData"}
    const row=editor.read(accounts).rows[0]
    assert.equal(row.values.password,"[redacted]")
    assert.equal(editor.read({...accounts,search:"minecraft-secret"}).total,0)
    assert.throws(()=>editor.mutate({...accounts,operation:"update",rowId:row.rowId,expectedRevision:row.revision,values:{telegramAccountId:null}}),/Unknown column/)
    editor.mutate({...accounts,operation:"update",rowId:row.rowId,expectedRevision:row.revision,values:{username:"UpdatedName"}})
    assert.equal(f.store.account(1).password,"minecraft-secret")
    const history=JSON.stringify(editor.read({database:"history",table:"changeLog",limit:100}))
    assert.equal(history.includes("minecraft-secret"),false);assert.equal(history.includes("secret-session"),false)
})

test("message detectors use fragments and exact extracted nicknames; normal login is passive",()=>{
    assert.equal(detectMinecraftMessage(binding),"binding")
    assert.equal(detectMinecraftMessage(login),"login_confirmation")
    assert.equal(detectMinecraftMessage("random /tg"),null)
    assert.deepEqual(detectTelegramMessage("[Бот] Аккаунт Player1 был привязан к Текущей странице!"),{type:"binding",nickName:"Player1"})
    assert.deepEqual(detectTelegramMessage("Успешный вход в аккаунт Player10 (ip)"),{type:"login_observed",nickName:"Player10"})
})

test("binding sends /tg then /bind once, accepts only correlated success and retains assignment",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1)
    await Promise.all([f.manager.handleMinecraft(f.minecraft(1,binding)),f.manager.handleMinecraft(f.minecraft(1,binding))])
    assert.deepEqual(f.bots.get(1).calls,["/tg"])
    assert.deepEqual(tg.client.calls,[["bind","Player1","minecraft-secret"]])
    await f.manager.handleTelegram(tg.id,f.message("Player10","binding"))
    assert.equal(f.manager.pendingOperations.size,1)
    await f.manager.handleTelegram(tg.id,f.message("Player1","binding"))
    assert.equal(f.manager.pendingOperations.size,0)
    assert.equal(f.events.filter(e=>e.type === "telegram.bindingSuccess").length,1)
    assert.deepEqual(f.restarts,[1])
    await f.manager.handleTelegram(tg.id,f.message("Player1","binding",{id:"duplicate-success"}))
    assert.deepEqual(f.restarts,[1])
    assert.equal(f.store.account(1).telegramAccountId,tg.id)
    assert.equal(JSON.stringify(f.logs).includes("minecraft-secret"),false)
})
test('deactivation preserves an in-flight binding through correlated completion',async t=>{
    const f=await fixture(t),tg=await f.telegram('+4711111111');f.account(1)
    await f.manager.handleMinecraft(f.minecraft(1,binding));const operation=f.manager.pendingOperations.get('1:binding')
    f.store.setActive(tg.id,false);assert.equal(f.manager.pendingOperations.get('1:binding'),operation)
    await f.manager.handleTelegram(tg.id,f.message('Player1','binding'))
    assert.equal(f.manager.pendingOperations.size,0);assert.deepEqual(f.restarts,[1]);assert.equal(f.store.account(1).telegramAccountId,tg.id)
    f.account(2);await assert.rejects(f.manager.handleMinecraft(f.minecraft(2,binding)),error=>error.code==='telegram:noAvailableAccount')
})

test("login confirmation rejects missing pending, wrong peer/account/nick, stale messages and wrong buttons",async t=>{
    const f=await fixture(t),tg1=await f.telegram("+4711111111"),tg2=await f.telegram("+4722222222")
    f.account(1,tg1.id);f.account(2,tg1.id)
    let clicks=0
    const good=f.message("Player1","login_confirmation",{accept:async()=>{clicks++}})
    await f.manager.handleTelegram(tg1.id,good)
    assert.equal(clicks,0)
    await f.manager.handleMinecraft(f.minecraft(1,login))
    await f.manager.handleMinecraft(f.minecraft(2,login))
    await f.manager.handleTelegram(tg2.id,good)
    await f.manager.handleTelegram(tg1.id,{...good,senderId:"999"})
    await f.manager.handleTelegram(tg1.id,{...good,chatId:"999"})
    await f.manager.handleTelegram(tg1.id,f.message("Player10"))
    await f.manager.handleTelegram(tg1.id,{...good,date:Date.now()-10000})
    await f.manager.handleTelegram(tg1.id,{...good,buttons:["Отклонить","Кикнуть","Восстановить"]})
    await f.manager.handleTelegram(tg1.id,f.message("Player1","login_observed",{id:"observed",buttons:["Это не я, восстановить!"],accept:good.accept}))
    assert.equal(clicks,0)
    assert.equal(f.manager.pendingOperations.size,2)
    await Promise.all([f.manager.handleTelegram(tg1.id,good),f.manager.handleTelegram(tg1.id,good)])
    assert.equal(clicks,1)
    assert.equal(f.manager.pendingOperations.size,1)
    assert.equal(f.events.filter(e=>e.type === "telegram.loginConfirmed").length,1)
    assert.equal(f.events.filter(e=>e.type === "telegram.loginObserved").length,1)
})

test("timeout and worker disconnect revoke pending permission; missing assignment never selects",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1,tg.id);f.account(2)
    await assert.rejects(f.manager.handleMinecraft(f.minecraft(2,login)),error=>error.code === "TELEGRAM_BINDING_MISSING")
    assert.equal(f.store.account(2).telegramAccountId,null)
    await f.manager.handleMinecraft(f.minecraft(1,login))
    f.manager.pendingOperations.get("1:login_confirmation").expiresAt=Date.now()-1
    f.manager.maintenance()
    await f.manager.handleTelegram(tg.id,f.message("Player1"))
    assert.equal(f.events.filter(e=>e.type === "telegram.operationTimeout").length,1)
    f.manager.recent.clear()
    await f.manager.handleMinecraft(f.minecraft(1,login))
    f.bots.get(1).workerPid++
    await f.manager.handleTelegram(tg.id,f.message("Player1"))
    f.manager.maintenance()
    assert.equal(f.manager.pendingOperations.size,0)
})

test("authorization code and 2FA, owner isolation, safe failures and persistent reauthorization",async t=>{
    const f=await fixture(t)
    const first=await f.manager.startAuthorization("+4712345678","web1")
    assert.equal(first.state,"CODE_REQUIRED")
    await assert.rejects(f.manager.submitCode(first.authRequestId,"22222","web2"),error=>error.code === "TELEGRAM_AUTH_NOT_FOUND")
    await assert.rejects(f.manager.submitCode(first.authRequestId,"00000","web1"),error=>error.code === "PHONE_CODE_INVALID")
    const password=await f.manager.submitCode(first.authRequestId,"22222","web1")
    assert.equal(password.state,"PASSWORD_REQUIRED")
    await assert.rejects(f.manager.submitPassword(first.authRequestId,"wrong","web1"),error=>error.code === "PASSWORD_HASH_INVALID")
    const done=await f.manager.submitPassword(first.authRequestId,"private-2fa","web1")
    assert.equal(done.state,"AUTHORIZED");assert.equal(done.status,"connected")
    assert.equal(f.store.all().length,1)
    f.account(1,done.telegramAccountId)
    const second=await f.manager.startAuthorization("+4712345678","web1")
    const again=await f.manager.submitCode(second.authRequestId,"12345","web1")
    assert.equal(again.telegramAccountId,done.telegramAccountId)
    assert.equal(f.store.count(again.telegramAccountId),1)
    assert.equal(f.manager.authorizations.size,0)
    assert.equal(JSON.stringify(f.store.all()).includes("private-2fa"),false)
    assert.equal(JSON.stringify(f.logs).includes("secret-session"),false)
})

test("startup restores sessions, isolates invalid sessions and does not send verification codes",async t=>{
    const f=await fixture(t)
    const one=f.store.save("+4711111111","valid-session")
    const two=f.store.save("+4722222222","invalid-session")
    f.manager.clientFactory=options=>{
        const client=new FakeClient(options);client.valid=options.session !== "invalid-session";f.clients.push(client);return client
    }
    await f.manager.start()
    assert.equal(f.store.get(one).status,"connected")
    assert.equal(f.store.get(two).status,"authorization_required")
    assert.equal(f.clients.flatMap(c=>c.calls).length,0)
    assert.equal(f.clients[0].options.session,"valid-session")
    assert.equal(f.clients[1].closed,true)
})

test("hung restore is bounded; cancelled authorization cannot persist a late success",async t=>{
    const f=await fixture(t,{requestTimeoutMs:20})
    const id=f.store.save("+4711111111","session")
    f.manager.clientFactory=()=>{const client=new FakeClient();client.connect=()=>new Promise(()=>{});return client}
    await f.manager.start()
    assert.equal(f.store.get(id).status,"error")
    f.manager.clientFactory=()=>new FakeClient()
    const auth=await f.manager.startAuthorization("+4712345678","owner")
    let finish
    f.manager.authorizations.get(auth.authRequestId).client.signIn=()=>new Promise(resolve=>{finish=resolve})
    const pending=f.manager.submitCode(auth.authRequestId,"12345","owner")
    await Promise.resolve()
    await f.manager.cancelAuthorization(auth.authRequestId,"owner")
    finish()
    await assert.rejects(pending,error=>error.code === "TELEGRAM_AUTH_EXPIRED")
    assert.equal(f.store.all().length,1)
})

test("Core accepts Telegram authorization only from web actors and redacts input and raw errors",async()=>{
    const logs=[]
    const logger={child(){return this},info(...args){logs.push(args)},warn(...args){logs.push(args)},error(...args){logs.push(args)}}
    const core=new Core({logger,telegramManager:{async submitPassword(){throw new Error("private-2fa secret-session")}}})
    const request={command:"telegram.submitPassword",payload:{authRequestId:"id",password:"private-2fa"}}
    assert.equal((await core.executeCommand({...request,actor:{type:"internal",id:"core"}})).error.code,"WEB_PANEL_REQUIRED")
    const result=await core.executeCommand({...request,actor:{type:"web",id:"one"}})
    assert.equal(result.error.code,"TELEGRAM_REQUEST_FAILED")
    assert.equal(JSON.stringify([logs,result]).includes("private-2fa"),false)
})

test("MTProto boundary resolves the actual bot peer and clicks only its callback accept button",async()=>{
    const transport=new MtprotoClient(config)
    await transport.close()
    let handler,request,received
    const peer={bot:true,username:"FunAuthBot",id:55n}
    transport.client={
        async getEntity(name){assert.equal(name,"FunAuthBot");return peer},
        addEventHandler(callback){handler=callback},
        async invoke(value){request=value},
        async sendMessage(destination,options){assert.equal(destination,peer);return options}
    }
    await transport.listen(message=>{received=message})
    const message={id:10,senderId:55n,chatId:55n,isPrivate:true,out:false,date:Math.floor(Date.now()/1000),message:"test",replyMarkup:{rows:[{buttons:[
        Button.inline("Отклонить",Buffer.from("reject")),
        Button.url("Принять","https://example.com"),
        Button.inline("Принять",Buffer.from("server-provided-callback"))
    ]}]}}
    await handler({message:{...message,senderId:66n}})
    assert.equal(received,undefined)
    await handler({message:{...message,chatId:66n}})
    assert.equal(received,undefined)
    await handler({message})
    assert.deepEqual(received.buttons,["Отклонить","Принять"])
    await received.accept()
    assert.ok(request instanceof Api.messages.GetBotCallbackAnswer)
    assert.equal(request.msgId,10)
    assert.equal(request.data.toString(),"server-provided-callback")
    const sent=await transport.sendBinding("Player1","mc-password")
    assert.equal(sent.message,"/bind Player1 mc-password")
    assert.equal(sent.parseMode,false)
    transport.client.invoke=async()=>{throw new Error("temporary network outage")}
    await assert.rejects(transport.authorized(),/temporary network outage/)
    transport.client.invoke=async()=>new Api.auth.AuthorizationSignUpRequired({})
    await assert.rejects(transport.signIn("+4711111111","hash","12345"),error=>error.code === "TELEGRAM_EXISTING_ACCOUNT_REQUIRED")
})

test("Minecraft integration distinguishes player chat from server messages and redacts password echoes",async()=>{
    const messages=[],logs=[]
    const handler=new MessageEvents({botId:1,botActions:{bot:{accountData:{password:"mc-secret"}}},logger:{info:value=>logs.push(value)},eventBus:{emit:(type,payload)=>messages.push({type,payload})}})
    await handler.acceptMessage({message:binding,position:"chat",sender:"11111111-1111-1111-1111-111111111111"})
    assert.equal(messages.at(-1).payload.kind,"chat")
    await handler.acceptMessage({message:binding,position:"chat",sender:"00000000-0000-0000-0000-000000000000"})
    assert.equal(messages.at(-1).payload.kind,"server")
    await handler.acceptMessage({message:"echo mc-secret",position:"system"})
    assert.equal(JSON.stringify([logs,messages]).includes("mc-secret"),false)
})

test("a stop in the same turn and credential changes both revoke an imminent callback",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1,tg.id)
    await f.manager.handleMinecraft(f.minecraft(1,login))
    let clicked=false
    const pending=f.manager.handleTelegram(tg.id,f.message("Player1","login_confirmation",{accept:async()=>{clicked=true}}))
    f.manager.cancelBot(1)
    await pending
    assert.equal(clicked,false)
    f.manager.recent.clear()
    await f.manager.handleMinecraft(f.minecraft(1,login))
    f.db.prepare("UPDATE accountsData SET username='Changed' WHERE accountId=1").run()
    await f.manager.handleTelegram(tg.id,f.message("Player1","login_confirmation",{id:"new",accept:async()=>{clicked=true}}))
    assert.equal(clicked,false)
})

test("session activation cannot race the reconnect loop or deletion",async t=>{
    const f=await fixture(t)
    const auth=await f.manager.startAuthorization("+4712345678","owner")
    const client=f.manager.authorizations.get(auth.authRequestId).client
    let finish
    client.listen=()=>new Promise(resolve=>{finish=resolve})
    const completing=f.manager.submitCode(auth.authRequestId,"12345","owner")
    // Wait for the activation phase, without starting any network transport.
    for(let i=0;i<30 && !finish;i++) await Promise.resolve()
    assert.equal(typeof finish,"function")
    const id=f.store.all()[0].telegramAccountId
    await f.manager.restore(id)
    assert.equal(f.clients.length,1)
    await assert.rejects(f.manager.remove(id),error=>error.code === "TELEGRAM_ACCOUNT_BUSY")
    finish()
    assert.equal((await completing).status,"connected")
    assert.equal(f.manager.activating.size,0)
})

test("subscription joins once, retries bind at most once and waits for final nick success before restart",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1)
    await f.manager.handleMinecraft(f.minecraft(1,binding))
    const message=f.message("Player1","binding",{id:"subscribe",text:subscription,subscriptionDestination:{kind:"public",value:"official_channel"}})
    await Promise.all([f.manager.handleTelegram(tg.id,message),f.manager.handleTelegram(tg.id,{...message,id:"repeat"})])
    assert.equal(tg.client.calls.filter(c=>c[0] === "join").length,1)
    assert.equal(f.manager.pendingOperations.size,1)
    assert.deepEqual(f.restarts,[])
    assert.equal(f.events.some(e=>e.type === "telegram.bindingSuccess"),false)
    const op=f.manager.pendingOperations.get("1:binding")
    op.retryAt=Date.now()-1
    await Promise.all([f.manager.retryBinding("1:binding",op),f.manager.retryBinding("1:binding",op)])
    assert.equal(tg.client.calls.filter(c=>c[0] === "bind").length,2)
    await f.manager.handleTelegram(tg.id,{...message,id:"third"})
    await f.manager.handleTelegram(tg.id,f.message("Player1","binding"))
    assert.deepEqual(f.restarts,[1])
    assert.equal(f.manager.pendingOperations.size,0)
    // A new process cannot inherit the old operation or restart from its reply.
    const bot=f.bots.get(1)
    bot.workerPid++;bot.restartRequested=false;bot.supervisorStatus="running"
    await f.manager.handleTelegram(tg.id,f.message("Player1","binding",{id:"late"}))
    assert.deepEqual(f.restarts,[1])
    assert.equal(JSON.stringify(f.logs).includes("minecraft-secret"),false)
})

test("subscription is ignored without pending binding, for another account/sender, stale or ambiguous requests",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111"),other=await f.telegram("+4722222222")
    const message=f.message("Player1","binding",{id:"subscribe",text:subscription,subscriptionDestination:{kind:"public",value:"official_channel"}})
    await f.manager.handleTelegram(tg.id,message)
    assert.equal(tg.client.calls.length,0)
    f.account(1,tg.id);f.account(2,tg.id)
    await f.manager.handleMinecraft(f.minecraft(1,login))
    await f.manager.handleTelegram(tg.id,message)
    assert.equal(tg.client.calls.length,0)
    await f.manager.handleMinecraft(f.minecraft(1,binding))
    await f.manager.handleTelegram(tg.id,{...message,senderId:"999"})
    await f.manager.handleTelegram(other.id,message)
    await f.manager.handleTelegram(tg.id,{...message,date:Date.now()-10000})
    assert.equal(tg.client.calls.filter(c=>c[0] === "join").length,0)
    await f.manager.handleMinecraft(f.minecraft(2,binding))
    await f.manager.handleTelegram(tg.id,message)
    assert.equal(tg.client.calls.filter(c=>c[0] === "join").length,0)
    f.manager.pendingOperations.get("1:binding").bindMessageIds=["bind-1"]
    await f.manager.handleTelegram(tg.id,{...message,replyToMessageId:"bind-1"})
    assert.equal(tg.client.calls.filter(c=>c[0] === "join").length,1)
    assert.deepEqual(f.restarts,[])
})

test("binding errors and timeout never restart; stopped or already restarting bots stay untouched",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    for(let id=1;id<=5;id++){f.account(id,tg.id);await f.manager.handleMinecraft(f.minecraft(id,binding))}
    f.bots.get(1).desiredState="stopped"
    f.bots.get(2).supervisorStatus="stopping"
    f.bots.get(3).restartRequested=true
    for(const id of [1,2,3]) await f.manager.handleTelegram(tg.id,f.message("Player"+id,"binding"))
    f.manager.pendingOperations.get("4:binding").expiresAt=Date.now()-1
    f.manager.maintenance()
    await f.manager.handleTelegram(tg.id,f.message("Player4","binding"))
    tg.client.joinChannel=async()=>{throw {errorMessage:"INVITE_HASH_EXPIRED",message:"secret-data"}}
    await f.manager.handleTelegram(tg.id,f.message("Player5","binding",{text:subscription,subscriptionDestination:{kind:"invite",value:"expired"}}))
    assert.deepEqual(f.restarts,[])
    assert.equal(f.bots.get(1).desiredState,"stopped")
    assert.equal(f.manager.pendingOperations.has("5:binding"),false)
    assert.ok(f.events.some(e=>e.payload.code === "INVITE_HASH_EXPIRED"))
    assert.equal(JSON.stringify(f.logs).includes("secret-data"),false)
    await f.manager.handleTelegram(tg.id,f.message("Player5","binding",{id:"too-late"}))
    assert.deepEqual(f.restarts,[])
})

test("final success during join cancels the scheduled bind retry",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1,tg.id)
    await f.manager.handleMinecraft(f.minecraft(1,binding))
    tg.client.joinChannel=async()=>{await f.manager.handleTelegram(tg.id,f.message("Player1","binding"))}
    await f.manager.handleTelegram(tg.id,f.message("Player1","binding",{id:"subscribe",text:subscription,subscriptionDestination:{kind:"public",value:"official_channel"}}))
    assert.deepEqual(f.restarts,[1])
    f.manager.maintenance()
    assert.equal(tg.client.calls.filter(c=>c[0] === "bind").length,1)
})

test("channel metadata accepts Telegram links only and transport extracts VIEW CHANNEL and preview",async()=>{
    assert.deepEqual(channelDestination("https://t.me/Official_Channel"),{kind:"public",value:"official_channel"})
    assert.deepEqual(channelDestination("https://t.me/+Abc_123"),{kind:"invite",value:"Abc_123"})
    assert.deepEqual(channelDestination("tg://join?invite=Abc_123"),{kind:"invite",value:"Abc_123"})
    for(const url of ["https://example.com/channel","https://t.me.evil.com/channel","https://t.me@evil.com/channel","javascript:alert(1)","https://t.me/share/url?url=test"]){assert.equal(channelDestination(url),null)}
    const transport=new MtprotoClient(config);await transport.close()
    let handler,received
    transport.client={async getEntity(){return {id:55n,bot:true,username:"FunAuthBot"}},addEventHandler(callback){handler=callback}}
    await transport.listen(value=>{received=value})
    const message={id:1,message:subscription,isPrivate:true,senderId:55n,chatId:55n,date:Math.floor(Date.now()/1000),replyMarkup:{rows:[{buttons:[Button.url("VIEW CHANNEL","https://t.me/official_channel")]}]}}
    await handler({message})
    assert.deepEqual(received.subscriptionDestination,{kind:"public",value:"official_channel"})
    await handler({message:{...message,replyMarkup:null,media:{webpage:{url:"https://t.me/+Invite_123"}}}})
    assert.deepEqual(received.subscriptionDestination,{kind:"invite",value:"Invite_123"})
    await handler({message:{...message,media:{webpage:{url:"https://t.me/different_channel"}}}})
    assert.equal(received.subscriptionDestination,null)
})

test("MTProto join validates channels, handles existing membership and private invites without browser",async()=>{
    const transport=new MtprotoClient(config);await transport.close()
    const channel=new Api.Channel({id:123n,title:"Official",broadcast:true,left:true})
    const requests=[]
    transport.client={async getEntity(){return channel},async invoke(request){requests.push(request);return new Api.messages.ChatInviteJoinResultOk({})}}
    await transport.joinChannel({kind:"public",value:"official_channel"})
    assert.ok(requests[0] instanceof Api.channels.JoinChannel)
    channel.left=false
    await transport.joinChannel({kind:"public",value:"official_channel"})
    assert.equal(requests.length,1)
    channel.left=true
    transport.client.invoke=async()=>{throw {errorMessage:"USER_ALREADY_PARTICIPANT"}}
    await transport.joinChannel({kind:"public",value:"official_channel"})
    transport.client.invoke=async request=>{
        requests.push(request)
        if(request instanceof Api.messages.CheckChatInvite) return new Api.ChatInvite({broadcast:true,channel:true})
        return new Api.messages.ChatInviteJoinResultOk({})
    }
    await transport.joinChannel({kind:"invite",value:"Invite_123"})
    assert.ok(requests.at(-1) instanceof Api.messages.ImportChatInvite)
    transport.client.invoke=async()=>new Api.ChatInviteAlready({chat:channel})
    await transport.joinChannel({kind:"invite",value:"Invite_123"})
    channel.broadcast=false;channel.megagroup=true
    await assert.rejects(transport.joinChannel({kind:"public",value:"official_channel"}),error=>error.code === "TELEGRAM_DESTINATION_NOT_CHANNEL")
})

test("invite/access/flood/network errors finish binding safely without retry or restart",async t=>{
    const f=await fixture(t),tg=await f.telegram("+4711111111")
    f.account(1,tg.id)
    for(const [rpc,expected] of [["INVITE_HASH_INVALID","INVITE_HASH_INVALID"],["INVITE_HASH_EXPIRED","INVITE_HASH_EXPIRED"],
        ["CHANNEL_PRIVATE","CHANNEL_PRIVATE"],["FLOOD_WAIT_60","TELEGRAM_FLOOD_WAIT"],["FLOOD_WAIT","TELEGRAM_FLOOD_WAIT"],["NETWORK_SECRET","TELEGRAM_REQUEST_FAILED"]]){
        f.manager.recent.clear()
        await f.manager.handleMinecraft(f.minecraft(1,binding))
        tg.client.joinChannel=async()=>{throw {errorMessage:rpc,message:"session-secret"}}
        await f.manager.handleTelegram(tg.id,f.message("Player1","binding",{id:rpc,text:subscription,subscriptionDestination:{kind:"invite",value:"Invite_123"}}))
        assert.equal(f.manager.pendingOperations.size,0)
        assert.equal(f.events.at(-1).payload.code,expected)
        assert.deepEqual(f.restarts,[])
    }
    assert.equal(JSON.stringify(f.logs).includes("session-secret"),false)
    f.manager.recent.clear()
    tg.client.sendBinding=async()=>{throw new Error("binding transport error")}
    await assert.rejects(f.manager.handleMinecraft(f.minecraft(1,binding)))
    assert.equal(f.manager.pendingOperations.size,0)
    assert.deepEqual(f.restarts,[])
})

test("timeout during channel resolution prevents the join side effect",async()=>{
    const transport=new MtprotoClient(config);await transport.close()
    let active=true,calls=0
    transport.client={
        async getEntity(){active=false;return new Api.Channel({id:123n,broadcast:true,left:true,title:"Official"})},
        async invoke(){calls++}
    }
    await assert.rejects(transport.joinChannel({kind:"public",value:"official_channel"},()=>active),error=>error.code === "TELEGRAM_OPERATION_CANCELLED")
    assert.equal(calls,0)
})
