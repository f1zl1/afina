import DatabaseStore from "./databaseStore.js"
import { generateCredentials } from "../accounts/accountCredentials.js"

const botSelect = "SELECT b.*, COALESCE(t.type,'test') AS type FROM botData b LEFT JOIN tasksData t ON t.botId=b.botId"
export function parseSettingValue(value, type){
    if(type === "integer" || type === "float"){
        const number = Number(value)
        if(String(value).trim() === "" || !Number.isFinite(number) || (type === "integer" && !Number.isInteger(number))) throw new Error(`Invalid ${type} setting`)
        return number
    }
    if(type === "boolean"){
        if(!["true", "false"].includes(value)) throw new Error("Invalid boolean setting")
        return value === "true"
    }
    if(type === "json") return JSON.parse(value)
    if(type !== "string") throw new Error(`Unknown setting type: ${type}`)
    return value
}

export default class DataBaseManager{
    constructor({config, logger, eventBus = null}){
        this.config = config
        this.logger = logger.child("DataBaseManager")
        this.eventBus = eventBus
        this.store = new DatabaseStore(config)
        this.cachedSnapshot = null
    }
    async init(){await this.store.init()}
    close(){this.store.close()}
    async ensureAccountPoolSchema(){}
    query(sql){return this.store.prepare(sql)}
    async getServerData(id){return this.query("SELECT * FROM serverData WHERE serverId=?").get(id)}
    async getTasksData(botId){return this.query("SELECT * FROM tasksData WHERE botId=?").get(botId)}
    async getAccountData(id){return this.query("SELECT * FROM accountsData WHERE accountId=?").get(id)}
    async getAllAccountsData(){return this.query("SELECT * FROM accountsData ORDER BY accountId").all()}
    createGeneratedAccounts(count = 1, credentials = generateCredentials, onCreated = null, requestId = null){
        if(!Number.isInteger(count) || count < 1 || count > 100){
            throw new Error("Кількість акаунтів має бути цілим числом від 1 до 100.")
        }
        return this.store.transaction(() => {
            if(requestId){
                const result=this.query('SELECT quantity,accountIds FROM coreGenerationResults WHERE requestId=?').get(requestId)
                if(result){
                    if(result.quantity!==count)throw new Error('GENERATION_REQUEST_CONFLICT')
                    return JSON.parse(result.accountIds).map(accountId=>({accountId,status:'available'}))
                }
                const action=this.query('SELECT state,deadlineAt FROM coreActions WHERE actionId=?').get(requestId)
                if(!action||!['DISPATCHED','RUNNING'].includes(action.state)||action.deadlineAt<=Date.now())throw new Error('ACTION_NOT_ACTIVE')
            }
            const used = new Set(this.query("SELECT username FROM accountsData").all().map(row => row.username.toLowerCase()))
            const accounts = []
            for(let index = 0; index < count; index++){
                let candidate = null
                for(let attempt = 0; attempt < 100; attempt++){
                    const value = credentials()
                    if(!/^[A-Za-z0-9_]{3,16}$/.test(value.username) || !/^[A-Za-z0-9]{24}$/.test(value.password)){
                        throw new Error("Invalid generated credentials")
                    }
                    if(!used.has(value.username.toLowerCase())){candidate = value; break}
                }
                if(!candidate) throw new Error("Не вдалося підібрати унікальний нік. Спробуйте ще раз.")
                const result = this.query("INSERT INTO accountsData(username,password) VALUES(?,?)").run(candidate.username,candidate.password)
                const accountId = Number(result.lastInsertRowid)
                this.query("INSERT INTO accountPoolState(accountId,status,failureCount,updatedAt) VALUES(?,'available',0,?)").run(accountId,new Date().toISOString())
                used.add(candidate.username.toLowerCase())
                accounts.push({accountId,username:candidate.username,status:"available"})
            }
            onCreated?.(accounts)
            if(requestId)this.query('INSERT INTO coreGenerationResults VALUES(?,?,?,?)').run(requestId,count,JSON.stringify(accounts.map(a=>a.accountId)),Date.now())
            return accounts
        })
    }
    async getAllAccountPoolStates(){return this.query("SELECT * FROM accountPoolState ORDER BY accountId").all()}
    async getAccountPoolState(id){return this.query("SELECT * FROM accountPoolState WHERE accountId=?").get(id) ?? null}
    async getAllBotsData(){return this.query(botSelect + " WHERE b.archived=0 ORDER BY b.botId").all()}
    async getBotData(id){return this.query(botSelect + " WHERE b.botId=? AND b.archived=0").get(id) ?? null}
    async getAllItemsData(){return this.query("SELECT * FROM itemsData").all().map(row => ({...row, matcher: JSON.parse(row.matcher)}))}
    async getItemData(id){const row=this.query("SELECT * FROM itemsData WHERE itemId=?").get(id);return row ? {...row,matcher:JSON.parse(row.matcher)} : null}

    async createBotData({name = null, type = "test", connectedAccountId = null, serverId = null, realm = null} = {}){
        if(!["test","afk"].includes(type)) throw new Error("Create the bot in test or afk mode, then configure its trading task")
        return this.store.transaction(() => {
            const result = this.query("INSERT INTO botData(name,connectedAccountId,serverId,realm) VALUES(?,?,?,?)").run(name?.trim() || "New bot",connectedAccountId,serverId,realm)
            const botId = Number(result.lastInsertRowid)
            this.query("INSERT INTO tasksData(botId,type) VALUES(?,?)").run(botId,type)
            return this.query(botSelect + " WHERE b.botId=?").get(botId)
        })
    }
    async archiveBotData(id){return this.query("UPDATE botData SET archived=1,connectedAccountId=NULL,updatedAt=? WHERE botId=? AND archived=0").run(new Date().toISOString(),id).changes > 0}
    async updateBotAccount(id, accountId){return this.query("UPDATE botData SET connectedAccountId=?,updatedAt=? WHERE botId=? AND archived=0").run(accountId,new Date().toISOString(),id).changes > 0}

    assignAvailableAccount(botId, {rotate = false, oldAccountAction = "available", reason = "account_rotation", cooldownMs = 1800000,excludeAccountIds=[],actionId=null} = {}){
        return this.store.transaction(() => {
            const bot=this.query("SELECT * FROM botData WHERE botId=? AND archived=0").get(botId)
            if(!bot) throw new Error(`Bot ${botId} not found`)
            const previousAccountId=bot.connectedAccountId
            const now=new Date().toISOString()
            const usable=state => !state || state.status === "available" || (state.status === "cooldown" && state.cooldownUntil && state.cooldownUntil <= now)
            const oldState=previousAccountId == null ? null : this.query("SELECT * FROM accountPoolState WHERE accountId=?").get(previousAccountId)
            const oldAccount=previousAccountId==null?null:this.query('SELECT banned,disabled FROM accountsData WHERE accountId=?').get(previousAccountId)
            if(!rotate && previousAccountId != null && !oldAccount?.banned && !oldAccount?.disabled && usable(oldState)){
                return {changed:false,previousAccountId,accountId:previousAccountId,account:this.query("SELECT * FROM accountsData WHERE accountId=?").get(previousAccountId)}
            }
            const account=this.query(`SELECT a.* FROM accountsData a LEFT JOIN accountPoolState s ON s.accountId=a.accountId
                WHERE a.accountId!=? AND a.banned=0 AND a.disabled=0 AND NOT EXISTS(SELECT 1 FROM botData b WHERE b.connectedAccountId=a.accountId AND b.archived=0)
                AND (s.status IS NULL OR s.status='available' OR (s.status='cooldown' AND s.cooldownUntil<=?))
                AND a.accountId NOT IN (SELECT value FROM json_each(?))
                AND NOT EXISTS(SELECT 1 FROM coreActionResources r WHERE r.resourceKey='account:'||a.accountId AND r.actionId!=COALESCE(?,''))
                AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM coreActionResources r WHERE r.actionId=? AND r.resourceKey LIKE 'account:%') OR EXISTS(SELECT 1 FROM coreActionResources r WHERE r.actionId=? AND r.resourceKey='account:'||a.accountId))
                AND NOT EXISTS(SELECT 1 FROM accountReplacements r WHERE r.replacementAccountId=a.accountId AND r.botId!=? AND r.state NOT IN ('completed','cancelled'))
                ORDER BY COALESCE(s.lastUsedAt,''),a.accountId LIMIT 1`).get(previousAccountId ?? -1,now,JSON.stringify(excludeAccountIds),actionId,actionId,actionId,actionId,botId)
            if(!account) throw new Error("No available Minecraft accounts; existing assignment unchanged")
            if(rotate && previousAccountId != null){
                if(!["available","cooldown","blocked","retired"].includes(oldAccountAction)) throw new Error("Invalid account action")
                const until=oldAccountAction === "cooldown" ? new Date(Date.now()+cooldownMs).toISOString() : null
                this.query(`INSERT INTO accountPoolState(accountId,status,reason,cooldownUntil,updatedAt) VALUES(?,?,?,?,?)
                    ON CONFLICT(accountId) DO UPDATE SET status=excluded.status,reason=excluded.reason,cooldownUntil=excluded.cooldownUntil,updatedAt=excluded.updatedAt`).run(previousAccountId,oldAccountAction,reason,until,now)
            }
            this.query("UPDATE botData SET connectedAccountId=?,updatedAt=? WHERE botId=?").run(account.accountId,now,botId)
            this.query(`INSERT INTO accountPoolState(accountId,status,lastUsedAt,updatedAt) VALUES(?,'available',?,?)
                ON CONFLICT(accountId) DO UPDATE SET status='available',cooldownUntil=NULL,lastUsedAt=excluded.lastUsedAt,updatedAt=excluded.updatedAt`).run(account.accountId,now,now)
            return {changed:true,previousAccountId,accountId:account.accountId,account,reason}
        })
    }

    async updateAccountPoolState(accountId, {status, reason = null, cooldownUntil = null, incrementFailure = false}){
        this.query(`INSERT INTO accountPoolState(accountId,status,reason,cooldownUntil,failureCount,updatedAt) VALUES(?,?,?,?,?,?)
            ON CONFLICT(accountId) DO UPDATE SET status=excluded.status,reason=excluded.reason,cooldownUntil=excluded.cooldownUntil,
            failureCount=accountPoolState.failureCount+excluded.failureCount,updatedAt=excluded.updatedAt`).run(accountId,status,reason,cooldownUntil,incrementFailure ? 1 : 0,new Date().toISOString())
        return this.getAccountPoolState(accountId)
    }
    async updateAccountPoolUsage(accountId,lastUsedAt){
        const previous=this.query("SELECT lastUsedAt FROM accountPoolState WHERE accountId=?").get(accountId)
        this.query(`INSERT INTO accountPoolState(accountId,lastUsedAt,updatedAt) VALUES(?,?,?)
            ON CONFLICT(accountId) DO UPDATE SET lastUsedAt=excluded.lastUsedAt,updatedAt=excluded.updatedAt`).run(accountId,lastUsedAt,new Date().toISOString())
        return {accountId,lastUsedAt,previousLastUsedAt:previous?.lastUsedAt ?? null}
    }
    async getResellerSettings(){return this.query("SELECT * FROM resellerSettings ORDER BY id").all().map(row => ({...row,value:parseSettingValue(row.settingValue,row.settingType)}))}
    async getResellerSetting(name){const row=this.query("SELECT * FROM resellerSettings WHERE settingName=?").get(name);return row ? {...row,value:parseSettingValue(row.settingValue,row.settingType)} : null}
    async updateResellerSetting(name,value){
        const current=await this.getResellerSetting(name)
        if(!current) throw new Error(`Unknown setting: ${name}`)
        const raw=current.settingType === "json" ? JSON.stringify(value) : String(value)
        const parsed=parseSettingValue(raw,current.settingType)
        this.query("UPDATE resellerSettings SET settingValue=?,updatedAt=? WHERE settingName=?").run(raw,new Date().toISOString(),name)
        const result={settingName:name,oldValue:current.value,value:parsed,settingType:current.settingType}
        this.eventBus?.publish("system.database.changed", {database:"reseller",table:"resellerSettings"})
        return result
    }

    getConfigurationSnapshot(){
        const revision=this.store.revision()
        if(this.cachedSnapshot?.revision === revision) return this.cachedSnapshot
        this.store.db.exec("BEGIN")
        try{
            const readRevision=this.store.revision()
            const definitions=this.query(botSelect + " WHERE b.archived=0 ORDER BY b.botId").all()
            const map=(table,key) => new Map(this.query(`SELECT * FROM ${table}`).all().map(row=>[row[key],row]))
            const accounts=map("accountsData","accountId"), tasks=map("tasksData","botId")
            const items=map("itemsData","itemId"), servers=map("serverData","serverId")
            const globalSettings=map("resellerSettings","settingName")
            const grouped=(table,key) => {
                const result=new Map()
                for(const row of this.query(`SELECT * FROM ${table}`).all()){
                    if(!result.has(row[key])) result.set(row[key],[])
                    result.get(row[key]).push(row)
                }
                return result
            }
            const profiles=grouped("profileSettings","profileId"), overrides=grouped("botSettings","botId")
            const configurations=new Map()
            for(const definition of definitions){
                try{
                    const account=accounts.get(definition.connectedAccountId)
                    // Worker compatibility view: target is owned by the bot, never by the account.
                    const accountData=account ? {...account,realm:definition.realm,serverId:definition.serverId} : null
                    const task=tasks.get(definition.botId), item=task ? items.get(task.itemId) : null
                    if(task?.type === "reseller" && (!item || !(task.buyPricePerOne > 0) || !(task.sellPricePerOne > 0))){
                        throw new Error("Reseller task requires an item and positive buy/sell prices")
                    }
                    const taskData=task ? {...task,item:item ? {...item,matcher:JSON.parse(item.matcher)} : null} : null
                    const settings={}
                    for(const row of globalSettings.values()) settings[row.settingName]=parseSettingValue(row.settingValue,row.settingType)
                    for(const row of [...(profiles.get(definition.settingsProfileId) ?? []), ...(overrides.get(definition.botId) ?? [])]){
                        settings[row.settingName]=parseSettingValue(row.settingValue,globalSettings.get(row.settingName)?.settingType)
                    }
                    configurations.set(definition.botId,{definition,accountData,taskData,serverData:servers.get(definition.serverId) ?? null,settings})
                }catch(error){configurations.set(definition.botId,{error:error.message})}
            }
            this.store.db.exec("COMMIT")
            return this.cachedSnapshot={revision:readRevision,definitions,configurations}
        }catch(error){this.store.db.exec("ROLLBACK");throw error}
    }
}
