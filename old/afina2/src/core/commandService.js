import { success, failure } from "./coreResult.js"
import { executeBotConsole } from "./botConsole.js"
import { safeTelegramError } from "../telegram/telegramErrors.js"

export default class CommandService{
    constructor({
        logger,
        botManager,
        accountAssignmentService,
        accountPool,
        databaseEditor,
        configurationService,
        eventBus,
        dataBaseManager,
        telegramManager,
        autonomy
    }){
        this.logger = logger.child("CommandService")
        this.botManager = botManager
        this.accountAssignmentService = accountAssignmentService
        this.accountPool = accountPool
        this.autonomy = autonomy

        this.handlers = new Map([
            ['core.proxy.save',({payload,actor})=>{if(actor.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED');const result=autonomy.proxies.save(payload);autonomy.schedule({type:'PROXY_CHANGED',source:'manual'});return success(result)}],
            ['core.proxy.delete',({payload,actor})=>{if(actor.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED');return success(autonomy.proxies.remove(payload.proxyId))}],
            ['telegram.setActive',({payload,actor})=>{if(actor.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED');const result=telegramManager.store.setActive(payload.telegramAccountId,payload.active);eventBus.publish('system.database.changed',{});return success(result)}],
            ['core.liveValidation.arm',({payload,actor})=>success(autonomy.liveValidation.arm(payload,actor))],
            ['core.liveValidation.disable',({payload,actor})=>success(autonomy.liveValidation.disable(payload,actor))],
            ['core.economic.submit',({payload,actor})=>success(autonomy.economic.submit(payload,actor))],
            ['core.economic.resolve',({payload,actor})=>success(autonomy.economic.resolve(payload,actor))],
            ['core.economic.cancel',({payload,actor})=>{if(actor.type!=='web'||!actor.id)return failure('MANUAL_OPERATOR_REQUIRED','Потрібен оператор вебпанелі.');return success(autonomy.economic.cancel(payload.workloadId))}],
            ["core.policy.update",({payload})=>success(autonomy.updatePolicy(payload))],
            ["core.operations.update",({payload})=>success(autonomy.updateOperationsPolicy(payload))],
            ["core.override.set",({payload})=>success(autonomy.setOverride(payload))],
            ["core.override.delete",({payload})=>success(autonomy.deleteOverride(payload))],
            ["core.bot.release",({payload})=>success(autonomy.releaseBot(payload))],
            ...["startAuthorization","submitCode","submitPassword","cancelAuthorization","delete"].map(action => [
                `telegram.${action}`, async ({payload,actor}) => {
                    if(actor.type !== "web" || !actor.id) return failure("WEB_PANEL_REQUIRED","Use the Web Panel to manage Telegram accounts.")
                    if(!telegramManager) return failure("TELEGRAM_UNAVAILABLE","Telegram manager is unavailable.")
                    const owner = actor.id
                    let result
                    if(action === "startAuthorization") result = await telegramManager.startAuthorization(payload.phone,owner)
                    else if(action === "submitCode") result = await telegramManager.submitCode(payload.authRequestId,payload.code,owner)
                    else if(action === "submitPassword") result = await telegramManager.submitPassword(payload.authRequestId,payload.password,owner)
                    else if(action === "cancelAuthorization") result = await telegramManager.cancelAuthorization(payload.authRequestId,owner)
                    else result = await telegramManager.remove(payload.telegramAccountId)
                    return success(result)
                }
            ]),
            ["accounts.generate", ({payload,executionGuard,actionId}) => {
                executionGuard?.()
                const accounts = dataBaseManager.createGeneratedAccounts(payload.count ?? 1,undefined,null,actionId)
                eventBus.publish("system.database.changed", {database:"accounts",table:"accountsData"})
                eventBus.publish("system.database.changed", {database:"accounts",table:"accountPoolState"})
                return success({accounts,count:accounts.length})
            }],
            ["database.mutate", async ({payload}) => {
                const previousBot=autonomy && payload.table === "tasksData" && payload.rowId ? dataBaseManager.store.prepare("SELECT botId FROM tasksData WHERE taskId=?").get(payload.rowId)?.botId : null
                if(autonomy && payload.operation==='delete'){
                    if(payload.table==='botData') autonomy.analysis.cancelForUser({botId:Number(payload.rowId)})
                    if(payload.table==='itemsData') autonomy.analysis.cancelForUser({itemId:Number(payload.rowId)})
                }
                const result = databaseEditor.mutate(payload)
                if(autonomy){
                    if(previousBot) autonomy.userControlsBot(previousBot)
                    if(payload.table === "tasksData" && payload.values?.botId) autonomy.userControlsBot(payload.values.botId)
                    if(payload.table === "botData") autonomy.userControlsBot(payload.values?.botId ?? payload.rowId)
                }
                let syncError = null
                try{
                    await configurationService.sync()
                }catch(error){
                    syncError = error.message
                }
                eventBus.publish("system.database.changed", {database: payload.database, table: payload.table})
                return success({...result, syncError})
            }],
            ["bot.console", context => this.#console(context)],
            ["bot.start", context => this.#startBot(context)],
            ["bot.stop", context => this.#stopBot(context)],
            ["bot.restart", context => this.#restartBot(context)],
            ["bot.create", context => this.#createBot(context)],
            ["bot.archive", context => this.#archiveBot(context)],
            ["bot.account.rotate", context => this.#rotateAccount(context)],
            ["bot.account.release", context => this.#releaseAccount(context)],
            ["bot.account.block", context => this.#blockAccount(context)],
            ["bot.account.cooldown", context => this.#cooldownAccount(context)]
        ])

        this.logger.info("CommandService started")
    }

    async execute({
        command,
        payload = {},
        actor = null,
        executionGuard = null,
        actionId = null
    }){
        if(typeof command !== "string" || !command){
            return failure(
                "INVALID_COMMAND",
                "Command must be a non-empty string"
            )
        }

        const handler = this.handlers.get(command)

        if(!handler){
            return failure(
                "COMMAND_NOT_FOUND",
                `Unknown command: ${command}`
            )
        }

        const normalizedActor = this.#normalizeActor(actor)

        this.logger.info("Command requested", {
            command,
            actor: normalizedActor,
            payload: command.startsWith("core.proxy.") || command.startsWith("telegram.") || command === "bot.console" ? {} : command === "database.mutate"
                ? {database: payload.database, table: payload.table, operation: payload.operation, rowId: payload.rowId}
                : payload
        })

        try{
            if(normalizedActor.type!=='internal'&&['bot.start','bot.stop','bot.restart'].includes(command)&&!this.autonomy?.lifecycle)return failure('LIFECYCLE_UNAVAILABLE','Core lifecycle is unavailable; process commands are blocked.')
            if(this.autonomy && normalizedActor.type !== "internal" && ["bot.start","bot.stop","bot.restart","bot.archive","bot.account.rotate","bot.account.release"].includes(command)){
                this.autonomy.userControlsBot(Number(payload.botId))
            }
            if(this.autonomy?.lifecycle&&normalizedActor.type!=='internal'&&['bot.start','bot.stop','bot.restart'].includes(command))return success(await this.autonomy.lifecycle.manual(command,payload))
            const result = await handler({
                payload,
                actor: normalizedActor,
                actionId:normalizedActor.type==='internal'?actionId:null,
                executionGuard: normalizedActor.type === "internal" && typeof executionGuard === "function" ? executionGuard : null
            })

            if(result.ok){
                this.logger.info("Command completed", {
                    command,
                    actor: normalizedActor
                })
            }else{
                this.logger.warn("Command rejected", {
                    command,
                    actor: normalizedActor,
                    error: result.error
                })
            }

            return result
        }catch(error){
            if(command.startsWith("telegram.")){
                const safe = safeTelegramError(error)
                this.logger.warn("Telegram command failed",{command,code:safe.code})
                return failure(safe.code,safe.message)
            }
            this.logger.error("Command failed", {
                command,
                actor: normalizedActor,
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })

            return failure(
                "COMMAND_FAILED",
                error?.message ?? String(error)
            )
        }
    }

    async #console({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)
        return executeBotConsole({
            botId,
            text: payload.text,
            botManager: this.botManager
        })
    }

    async #startBot({payload,executionGuard,actionId}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        const runtime = this.botManager.getBotRuntimeState(botId)

        if(runtime?.desiredState === "running"&&!actionId){
            return failure(
                "BOT_ALREADY_RUNNING",
                `Bot ${botId} is already running`
            )
        }

        executionGuard?.()
        const assignment = await this.accountAssignmentService.ensureAccount(botId,{executionGuard,actionId})
        executionGuard?.()
        const accountId=assignment.accountId??assignment.account?.accountId
        if(actionId&&accountId!=null&&this.autonomy?.lifecycle)this.autonomy.actions.ledger.claim(actionId,'account:'+accountId)
        await this.botManager.startBot(botId,executionGuard,actionId)

        return success({
            botId,
            accountId: assignment.accountId ?? assignment.account?.accountId ?? null,
            accountChanged: assignment.changed,
            command: "bot.start",
            accepted: true
        })
    }

    async #stopBot({payload,executionGuard,actionId}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        const runtime = this.botManager.getBotRuntimeState(botId)

        if(runtime?.desiredState === "stopped"){
            return failure(
                "BOT_ALREADY_STOPPED",
                `Bot ${botId} is already stopped`
            )
        }

        executionGuard?.()
        if(this.autonomy?.lifecycle){const a=this.autonomy.actions.ledger.get(actionId);await this.botManager.stopOwned(botId,{actionId,deadlineAt:a.deadlineAt,valid:()=>this.autonomy.lifecycle.valid(actionId)})}
        else await this.botManager.stopBot(botId)

        return success({
            botId,
            command: "bot.stop",
            accepted: true
        })
    }

    async #restartBot({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        await this.accountAssignmentService.ensureAccount(botId)
        await this.botManager.restartBot(botId)

        return success({
            botId,
            command: "bot.restart",
            accepted: true
        })
    }

    async #createBot({payload}){
        const type =
            typeof payload?.type === "string" && payload.type.trim()
                ? payload.type.trim()
                : "test"

        const name =
            typeof payload?.name === "string" && payload.name.trim()
                ? payload.name.trim()
                : null

        const bot = await this.botManager.createBotDefinition({
            name,
            type,
            connectedAccountId: payload.connectedAccountId ?? null,
            serverId: payload.serverId ?? null,
            realm: payload.realm ?? null
        })

        return success({
            bot,
            command: "bot.create",
            accepted: true
        })
    }

    async #archiveBot({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        await this.botManager.archiveBot(botId)

        return success({
            botId,
            command: "bot.archive",
            accepted: true
        })
    }

    async #rotateAccount({payload,executionGuard,actionId}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        const allowedActions = new Set([
            "available",
            "cooldown",
            "blocked",
            "retired"
        ])

        const oldAccountAction =
            allowedActions.has(payload?.oldAccountAction)
                ? payload.oldAccountAction
                : "available"

        const cooldownMs = Number(payload?.cooldownMs ?? 30 * 60_000)

        if(!Number.isFinite(cooldownMs) || cooldownMs < 1){
            return failure(
                "INVALID_COOLDOWN",
                "cooldownMs must be a positive number"
            )
        }

        const result = await this.accountAssignmentService.rotateAccount(botId, {
            executionGuard,actionId,
            reason:
                typeof payload?.reason === "string" && payload.reason
                    ? payload.reason
                    : "manual_rotation",
            oldAccountAction,
            cooldownMs
        })

        return success({
            botId,
            ...result,
            account: result.account ? {accountId:result.account.accountId,username:result.account.username,telegramAccountId:result.account.telegramAccountId} : undefined,
            command: "bot.account.rotate",
            accepted: true
        })
    }

    async #releaseAccount({payload}){
        const botId = this.#botId(payload)
        if(botId === null) return this.#invalidBotId()
        if(!this.botManager.hasBot(botId)) return this.#botNotFound(botId)

        const result = await this.accountAssignmentService.releaseAccount(botId)

        return success({
            botId,
            ...result,
            command: "bot.account.release",
            accepted: true
        })
    }

    async #blockAccount({payload}){
        const accountId = this.#accountId(payload)
        if(accountId === null) return this.#invalidAccountId()

        const state = await this.accountPool.markBlocked(
            accountId,
            typeof payload?.reason === "string"
                ? payload.reason
                : "manual_block"
        )

        return success({
            accountId,
            state,
            command: "bot.account.block",
            accepted: true
        })
    }

    async #cooldownAccount({payload}){
        const accountId = this.#accountId(payload)
        if(accountId === null) return this.#invalidAccountId()

        const durationMs = Number(payload?.durationMs)

        if(!Number.isFinite(durationMs) || durationMs < 1){
            return failure(
                "INVALID_COOLDOWN",
                "durationMs must be a positive number"
            )
        }

        const state = await this.accountPool.markCooldown(accountId, {
            reason:
                typeof payload?.reason === "string"
                    ? payload.reason
                    : "manual_cooldown",
            durationMs
        })

        return success({
            accountId,
            state,
            command: "bot.account.cooldown",
            accepted: true
        })
    }

    #botId(payload){
        const botId = Number(payload?.botId)
        return Number.isInteger(botId) && botId > 0 ? botId : null
    }

    #accountId(payload){
        const accountId = Number(payload?.accountId)
        return Number.isInteger(accountId) && accountId > 0 ? accountId : null
    }

    #invalidBotId(){
        return failure(
            "INVALID_BOT_ID",
            "botId must be a positive integer"
        )
    }

    #invalidAccountId(){
        return failure(
            "INVALID_ACCOUNT_ID",
            "accountId must be a positive integer"
        )
    }

    #botNotFound(botId){
        return failure(
            "BOT_NOT_FOUND",
            `Bot ${botId} not found`
        )
    }

    #normalizeActor(actor){
        if(!actor || typeof actor !== "object"){
            return {
                type: "internal",
                id: null
            }
        }

        return {
            type:
                typeof actor.type === "string" && actor.type
                    ? actor.type
                    : "unknown",
            id:
                actor.id === null ||
                actor.id === undefined
                    ? null
                    : String(actor.id)
        }
    }
}
