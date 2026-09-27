import { randomUUID, createHash } from "node:crypto"
import MtprotoClient from "./mtprotoClient.js"
import { detectMinecraftMessage, detectTelegramMessage } from "./messageDetector.js"
import { telegramError, safeTelegramError } from "./telegramErrors.js"

const credentialsRevision = account => createHash("sha256").update(JSON.stringify([account?.username,account?.password])).digest("hex")

export default class TelegramManager{
    constructor({store, pool, eventBus, botManager, logger, config = {}, clientFactory = options => new MtprotoClient(options)}){
        Object.assign(this, {store,pool,eventBus,botManager,clientFactory})
        this.logger = logger.child("TelegramManager")
        this.config = {operationTimeoutMs:90000,requestTimeoutMs:15000,authorizationTimeoutMs:300000,...config}
        for(const key of ["operationTimeoutMs","requestTimeoutMs","authorizationTimeoutMs"]){
            if(!Number.isFinite(this.config[key]) || this.config[key]<1 || this.config[key]>3600000) throw telegramError("TELEGRAM_CONFIG_INVALID",`Invalid ${key}`)
        }
        this.clients = new Map()
        this.connecting = new Map()
        this.checking = new Set()
        this.activating = new Set()
        this.authorizations = new Map()
        this.pendingOperations = new Map()
        this.recent = new Map()
        this.seen = new Map()
        this.stopped = false
        this.listener = event => {
            if(event.type === "bot.chat.message" && event.payload.kind === "server"){
                this.handleMinecraft(event).catch(error => this.report(error, event.source))
            }else if(["system.worker.exited","bot.disconnected","bot.kicked","bot.desired.state.changed"].includes(event.type)){
                if(event.type !== "bot.desired.state.changed" || event.payload.desiredState === "stopped") this.cancelBot(event.source.botId)
            }
        }
    }
    configured(){return Number.isInteger(this.config.apiId) && this.config.apiId > 0 && /^[a-f0-9]{32}$/i.test(this.config.apiHash ?? "")}
    async start(){
        if(this.timer) return
        this.eventBus.onAny(this.listener)
        for(const account of this.store.all()) this.store.status(account.telegramAccountId, "disconnected")
        this.timer = setInterval(() => this.maintenance(), 1000)
        this.timer.unref?.()
        this.nextReconnect = Date.now() + 30000
        if(this.configured()) await Promise.allSettled(this.store.all().map(account => this.restore(account.telegramAccountId)))
    }
    emit(name, payload = {}){
        const safe = {}
        for(const key of ["telegramAccountId","accountId","botId","nickName","type","code","message"]) if(payload[key] !== undefined) safe[key] = payload[key]
        this.logger.info(`telegram.${name}`, safe)
        this.eventBus.publish(`telegram.${name}`, safe, {kind:"system",botId:safe.botId,accountId:safe.accountId})
    }
    changed(){this.eventBus.publish("system.database.changed", {database:"telegram",table:"telegramAccounts"})}
    report(error, context = {}){
        const safe = safeTelegramError(error)
        this.emit(safe.code === "telegram:noAvailableAccount" ? "noAvailableAccount" : "error", {...context,code:safe.code,message:safe.message})
    }
    async request(client, action){
        let timer
        try{
            return await Promise.race([Promise.resolve().then(action),new Promise((_,reject) => {
                timer = setTimeout(() => {
                    Promise.resolve().then(() => client?.close()).catch(() => {})
                    reject(telegramError("TELEGRAM_REQUEST_TIMEOUT"))
                },this.config.requestTimeoutMs)
            })])
        }catch(error){throw safeTelegramError(error)}
        finally{clearTimeout(timer)}
    }
    availableIds(){return new Set([...this.clients].filter(([,client]) => client.connected).map(([id]) => id))}
    restore(id){
        if(this.activating.has(id)) return Promise.resolve()
        if(this.connecting.has(id)) return this.connecting.get(id)
        const promise = this.restoreAccount(id).finally(() => this.connecting.delete(id))
        this.connecting.set(id,promise)
        return promise
    }
    async restoreAccount(id){
        if(this.stopped || !this.configured()) return
        const account = this.store.get(id)
        if(!account) return
        const old = this.clients.get(id)
        this.clients.delete(id)
        if(old) await this.request(old, () => old.close()).catch(() => {})
        let client
        try{
            if(!account.session) throw telegramError("AUTH_KEY_UNREGISTERED")
            client = this.clientFactory({...this.config,session:account.session})
            await this.request(client, () => client.connect())
            if(!await this.request(client, () => client.authorized())) throw telegramError("AUTH_KEY_UNREGISTERED")
            await this.request(client, () => client.identity())
            await this.activate(id,client)
        }catch(error){
            if(client) await this.request(client, () => client.close()).catch(() => {})
            const safe = safeTelegramError(error)
            if(!this.stopped && this.store.get(id)){
                const status=["AUTH_KEY_UNREGISTERED","SESSION_REVOKED"].includes(safe.code) ? "authorization_required" : "error"
                this.store.status(id,status)
                if(account.status !== status){this.report(safe,{telegramAccountId:id});this.changed()}
            }
        }
    }
    async activate(id, client){
        await this.request(client, () => client.listen(message => {
            if(this.clients.get(id) !== client) return
            return this.handleTelegram(id,message).catch(error => this.report(error,{telegramAccountId:id}))
        }))
        if(this.stopped || !this.store.get(id)) throw telegramError("TELEGRAM_OPERATION_CANCELLED")
        this.clients.set(id,client)
        this.store.session(id,client.save())
        this.store.status(id,"connected")
        this.changed()
    }
    async startAuthorization(phone, owner){
        if(!this.configured()) throw telegramError("TELEGRAM_NOT_CONFIGURED", "Set TELEGRAM_API_ID and TELEGRAM_API_HASH before authorization.")
        if(typeof phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(phone)) throw telegramError("PHONE_NUMBER_INVALID", "Use international phone format, for example +4712345678.")
        if(this.authorizations.size >= 5 || [...this.authorizations.values()].some(auth => auth.phone === phone)) throw telegramError("TELEGRAM_AUTH_ALREADY_PENDING")
        const authRequestId = randomUUID()
        const client = this.clientFactory(this.config)
        const auth = {authRequestId,phone,owner,client,state:"CONNECTING",expiresAt:Date.now()+this.config.authorizationTimeoutMs,busy:true}
        this.authorizations.set(authRequestId,auth)
        try{
            await this.request(client, () => client.connect())
            auth.phoneCodeHash = await this.request(client, () => client.sendCode(phone))
            this.assertAuth(auth)
            auth.state = "CODE_REQUIRED"
            return {authRequestId,state:auth.state,expiresAt:auth.expiresAt}
        }catch(error){await this.cancelAuthorization(authRequestId,owner);throw safeTelegramError(error)}
        finally{auth.busy=false}
    }
    assertAuth(auth){
        if(this.stopped || this.authorizations.get(auth.authRequestId) !== auth || Date.now() >= auth.expiresAt) throw telegramError("TELEGRAM_AUTH_EXPIRED")
    }
    async submitAuthorization(id, value, owner, state){
        const auth = this.authorizations.get(id)
        if(!auth || auth.owner !== owner) throw telegramError("TELEGRAM_AUTH_NOT_FOUND")
        this.assertAuth(auth)
        if(auth.busy || auth.state !== state) throw telegramError("TELEGRAM_AUTH_INVALID_STATE")
        if(typeof value !== "string" || !value || value.length > 256 || (state === "CODE_REQUIRED" && !/^\d{4,8}$/.test(value))) throw telegramError("TELEGRAM_AUTH_INVALID_INPUT")
        auth.busy = true
        try{
            if(state === "CODE_REQUIRED") await this.request(auth.client, () => auth.client.signIn(auth.phone,auth.phoneCodeHash,value))
            else await this.request(auth.client, () => auth.client.password(value))
            this.assertAuth(auth)
            const identity = await this.request(auth.client, () => auth.client.identity())
            this.assertAuth(auth)
            if(identity.phone !== auth.phone) throw telegramError("TELEGRAM_PHONE_MISMATCH")
            const existing=this.store.all().find(account=>account.phone === identity.phone)
            if(existing && this.connecting.has(existing.telegramAccountId)) throw telegramError("TELEGRAM_ACCOUNT_BUSY")
            const id = this.store.save(identity.phone,auth.client.save())
            this.activating.add(id)
            this.authorizations.delete(auth.authRequestId)
            try{
                const previous = this.clients.get(id)
                this.clients.delete(id)
                if(previous) await this.request(previous, () => previous.close()).catch(() => {})
                await this.activate(id,auth.client)
            }
            catch(error){
                await this.request(auth.client, () => auth.client.close()).catch(() => {})
                this.store.status(id,"error")
                this.report(error,{telegramAccountId:id})
                this.changed()
            }finally{this.activating.delete(id)}
            return {state:"AUTHORIZED",telegramAccountId:id,status:this.store.get(id).status}
        }catch(error){
            const safe = safeTelegramError(error)
            if(safe.code === "SESSION_PASSWORD_NEEDED"){
                auth.state = "PASSWORD_REQUIRED"
                delete auth.phoneCodeHash
                return {authRequestId:id,state:auth.state,expiresAt:auth.expiresAt}
            }
            if(!["PHONE_CODE_INVALID","PASSWORD_HASH_INVALID"].includes(safe.code)) await this.cancelAuthorization(id,owner)
            throw safe
        }finally{auth.busy=false;value=null}
    }
    submitCode(id, code, owner){return this.submitAuthorization(id,code,owner,"CODE_REQUIRED")}
    submitPassword(id, password, owner){return this.submitAuthorization(id,password,owner,"PASSWORD_REQUIRED")}
    async cancelAuthorization(id, owner){
        const auth = this.authorizations.get(id)
        if(!auth || auth.owner !== owner) return {state:"CANCELLED"}
        this.authorizations.delete(id)
        delete auth.phoneCodeHash
        await this.request(auth.client, () => auth.client.close()).catch(() => {})
        return {state:"CANCELLED"}
    }
    async remove(id){
        if(!Number.isSafeInteger(id) || id < 1) throw telegramError("TELEGRAM_ACCOUNT_NOT_FOUND")
        if(this.connecting.has(id) || this.checking.has(id) || this.activating.has(id)) throw telegramError("TELEGRAM_ACCOUNT_BUSY")
        this.store.remove(id)
        const client = this.clients.get(id)
        this.clients.delete(id)
        if(client) await this.request(client, () => client.close()).catch(() => {})
        this.changed()
        return {telegramAccountId:id}
    }
    validBot(operation){
        const bot = this.botManager.getBot(operation.botId)
        const account=this.store.account(operation.accountId)
        return bot && bot.isRunning() && bot.accountId === operation.accountId && bot.workerPid === operation.workerPid &&
            account?.telegramAccountId === operation.telegramAccountId && credentialsRevision(account) === operation.credentialsRevision
    }
    async handleMinecraft(event){
        const type = detectMinecraftMessage(event.payload.text)
        if(!type || this.stopped) return
        const {accountId,botId,workerPid} = event.source
        const key = `${accountId}:${type}`
        const recentKey = `${key}:${workerPid}`
        if(this.pendingOperations.has(key) || (this.recent.get(recentKey) ?? 0)>Date.now()) return
        this.recent.set(recentKey,Date.now()+this.config.operationTimeoutMs)
        const account = this.store.account(accountId)
        const bot = this.botManager.getBot(botId)
        if(!account || !bot?.isRunning() || bot.accountId !== accountId || bot.workerPid !== workerPid) return
        if(bot.accountData && credentialsRevision(bot.accountData) !== credentialsRevision(account)) throw telegramError("MINECRAFT_CONFIG_CHANGED", "Restart the Minecraft bot to apply changed credentials before Telegram authorization.")
        this.emit(type === "binding" ? "bindingRequired" : "loginConfirmationRequired",{accountId,botId})
        let telegramAccountId = account.telegramAccountId
        if(type === "binding"){
            const assignment = this.pool.acquireForMinecraftAccount(accountId,this.availableIds())
            telegramAccountId = assignment.telegramAccountId
            if(assignment.changed){this.emit("accountAssigned",{accountId,botId,telegramAccountId});this.changed()}
        }else if(telegramAccountId == null) throw telegramError("TELEGRAM_BINDING_MISSING", "This Minecraft account has no Telegram assignment.")
        const client = this.clients.get(telegramAccountId)
        if(!client?.connected) throw telegramError("TELEGRAM_ACCOUNT_UNAVAILABLE", "The assigned Telegram account is not connected. Reauthorize it in the database tab if necessary.")
        const operation = {type,accountId,botId,workerPid,telegramAccountId,nickName:account.username,credentialsRevision:credentialsRevision(account),createdAt:Date.now(),expiresAt:Date.now()+this.config.operationTimeoutMs}
        this.pendingOperations.set(key,operation)
        try{
            if(type === "binding"){
                if(!/^[A-Za-z0-9_]{3,16}$/.test(account.username) || /\s/.test(account.password)) throw telegramError("MINECRAFT_BIND_CREDENTIALS_INVALID")
                await bot.sendChat("/tg")
                if(!this.active(key,operation)) return
                const sent=await this.request(client, () => client.sendBinding(account.username,account.password))
                operation.bindMessageIds=sent?.id == null ? [] : [String(sent.id)]
                if(this.active(key,operation)) this.emit("bindingStarted",operation)
            }else this.emit("loginConfirmationPending",operation)
        }catch(error){this.pendingOperations.delete(key);throw safeTelegramError(error)}
    }
    active(key, operation){return this.pendingOperations.get(key) === operation && Date.now()<operation.expiresAt && this.validBot(operation)}
    async handleTelegram(telegramAccountId, message){
        if(this.stopped || !this.clients.has(telegramAccountId) || message.senderId !== message.peerId || message.chatId !== message.peerId) return
        const result = detectTelegramMessage(message.text)
        if(!result) return
        const seenKey = `${telegramAccountId}:${message.id}`
        if(this.seen.has(seenKey)) return
        if(result.type === "subscription_required") return this.handleSubscription(telegramAccountId,message,seenKey)
        if(result.type === "login_observed"){
            const account = this.store.store.prepare("SELECT accountId,username FROM accountsData WHERE telegramAccountId=? AND lower(username)=lower(?)").get(telegramAccountId,result.nickName)
            if(account){this.seen.set(seenKey,Date.now()+300000);this.emit("loginObserved",{telegramAccountId,accountId:account.accountId,nickName:account.username})}
            return
        }
        const matches = [...this.pendingOperations.entries()].filter(([,op]) => op.type === result.type && op.telegramAccountId === telegramAccountId && op.nickName.toLowerCase() === result.nickName.toLowerCase())
        if(matches.length !== 1){this.logger.debug("Telegram message ignored: no unique pending operation",{telegramAccountId});return}
        const [key,operation] = matches[0]
        if(!this.active(key,operation) || operation.busy || !Number.isFinite(message.date) || message.date<Math.floor(operation.createdAt/1000)*1000) return
        if(result.type === "login_confirmation" && !message.buttons.includes("Принять")) return
        operation.busy=true
        this.seen.set(seenKey,Date.now()+300000)
        try{
            if(result.type === "login_confirmation") await this.request(this.clients.get(telegramAccountId), () => {
                if(!this.active(key,operation)) throw telegramError("TELEGRAM_OPERATION_CANCELLED")
                return message.accept()
            })
            if(this.active(key,operation)){
                this.pendingOperations.delete(key)
                this.emit(result.type === "binding" ? "bindingSuccess" : "loginConfirmed",operation)
                if(result.type === "binding"){
                    const bot=this.botManager.getBot(operation.botId)
                    if(this.validBot(operation) && bot.desiredState === "running" && !bot.restartRequested &&
                        !["stopping","restarting"].includes(bot.supervisorStatus)){
                        await this.botManager.restartBot(operation.botId,{reason:'binding',incarnationId:bot.incarnationId})
                    }
                }
            }
        }catch(error){this.pendingOperations.delete(key);this.report(error,operation)}
    }
    async handleSubscription(telegramAccountId,message,seenKey){
        const matches=[...this.pendingOperations].filter(([key,op])=>op.type === "binding" && op.telegramAccountId === telegramAccountId &&
            this.active(key,op) && Number.isFinite(message.date) && message.date>=Math.floor(op.createdAt/1000)*1000 &&
            (message.replyToMessageId == null || op.bindMessageIds?.includes(String(message.replyToMessageId))))
        if(matches.length !== 1){
            if(matches.length>1) this.logger.debug("Subscription request ignored: ambiguous binding",{telegramAccountId})
            return
        }
        const [key,operation]=matches[0]
        if(operation.subscriptionAttempted) return
        operation.subscriptionAttempted=true
        this.seen.set(seenKey,Date.now()+300000)
        const client=this.clients.get(telegramAccountId)
        try{
            if(!message.subscriptionDestination) throw telegramError("TELEGRAM_CHANNEL_LINK_MISSING", "Cannot determine one channel from the FunAuthBot subscription request.")
            await this.request(client,()=>client.joinChannel(message.subscriptionDestination,()=>this.active(key,operation) && this.clients.get(telegramAccountId) === client))
            if(!this.active(key,operation)) return
            this.emit("subscriptionJoined",operation)
            // Give FunAuthBot time to send its final response; then retry once.
            operation.retryAt=Date.now()+2000
        }catch(error){
            if(this.pendingOperations.get(key) === operation){this.pendingOperations.delete(key);this.report(error,operation)}
        }
    }
    async retryBinding(key,operation){
        if(operation.bindRetried || !this.active(key,operation)) return
        operation.bindRetried=true
        const client=this.clients.get(operation.telegramAccountId)
        try{
            const sent=await this.request(client,()=>{
                if(!this.active(key,operation) || !client?.connected) throw telegramError("TELEGRAM_OPERATION_CANCELLED")
                const account=this.store.account(operation.accountId)
                return client.sendBinding(account.username,account.password)
            })
            if(sent?.id != null) (operation.bindMessageIds ??= []).push(String(sent.id))
        }catch(error){
            if(this.pendingOperations.get(key) === operation){this.pendingOperations.delete(key);this.report(error,operation)}
        }
    }
    cancelBot(botId){for(const [key,op] of this.pendingOperations) if(op.botId === botId) this.pendingOperations.delete(key)}
    maintenance(){
        if(this.stopped) return
        const now = Date.now()
        for(const [key,op] of this.pendingOperations){
            if(now>=op.expiresAt){this.pendingOperations.delete(key);this.emit("operationTimeout",op)}
            else if(!this.validBot(op)) this.pendingOperations.delete(key)
            else if(op.retryAt && now>=op.retryAt && !op.bindRetried) void this.retryBinding(key,op)
        }
        for(const map of [this.recent,this.seen]) for(const [key,expires] of map) if(now>=expires) map.delete(key)
        for(const auth of this.authorizations.values()) if(now>=auth.expiresAt) void this.cancelAuthorization(auth.authRequestId,auth.owner)
        if(now>=this.nextReconnect){
            this.nextReconnect=now+30000
            for(const account of this.store.all()){
                const client = this.clients.get(account.telegramAccountId)
                if(client?.connected) void this.checkSession(account.telegramAccountId,client)
                else if(account.status !== "authorization_required") void this.restore(account.telegramAccountId)
            }
        }
    }
    async checkSession(id,client){
        if(this.checking.has(id)) return
        this.checking.add(id)
        try{
            if(!await this.request(client,()=>client.authorized())) throw telegramError("AUTH_KEY_UNREGISTERED")
            if(this.stopped || this.clients.get(id)!==client) return
            this.store.status(id,"connected")
            this.store.session(id,client.save())
        }catch(error){
            if(this.stopped || this.clients.get(id)!==client) return
            this.clients.delete(id)
            await this.request(client,()=>client.close()).catch(()=>{})
            if(this.stopped || !this.store.get(id)) return
            const safe=safeTelegramError(error)
            this.store.status(id,["AUTH_KEY_UNREGISTERED","SESSION_REVOKED"].includes(safe.code) ? "authorization_required" : "error")
            this.report(safe,{telegramAccountId:id})
            this.changed()
        }finally{this.checking.delete(id)}
    }
    async stop(){
        this.stopped=true
        clearInterval(this.timer)
        this.eventBus.offAny(this.listener)
        this.pendingOperations.clear()
        await Promise.allSettled([...this.authorizations.values()].map(auth => this.cancelAuthorization(auth.authRequestId,auth.owner)))
        await Promise.allSettled([...this.clients.values()].map(client => this.request(client,()=>client.close())))
        this.clients.clear()
        await Promise.allSettled(this.connecting.values())
    }
}
