export default class AccountPool{
    constructor({
        logger,
        dataBaseManager
    }){
        this.logger = logger.child("AccountPool")
        this.dataBaseManager = dataBaseManager
        this.reserved = new Set()
    }

    async init(){
        await this.dataBaseManager.ensureAccountPoolSchema()
        this.logger.info("AccountPool started")
    }

    async acquire({
        excludeAccountIds = []
    } = {}){
        const accounts = await this.dataBaseManager.getAllAccountsData()
        const states = await this.dataBaseManager.getAllAccountPoolStates()
        const bots = await this.dataBaseManager.getAllBotsData()

        const assigned = new Set(
            bots
                .map(bot => bot.connectedAccountId)
                .filter(accountId => accountId !== null && accountId !== undefined)
                .map(Number)
        )

        const excluded = new Set(excludeAccountIds.map(Number))
        for(const row of this.dataBaseManager.store?.prepare("SELECT resourceKey FROM coreActionResources WHERE resourceKey LIKE 'account:%'").all()??[])excluded.add(Number(row.resourceKey.slice(8)))
        for(const row of this.dataBaseManager.store?.prepare("SELECT replacementAccountId FROM accountReplacements WHERE replacementAccountId IS NOT NULL AND state NOT IN ('completed','cancelled')").all() ?? [])excluded.add(row.replacementAccountId)
        const stateMap = new Map(states.map(state => [Number(state.accountId), state]))
        const now = Date.now()

        for(const account of accounts){
            const accountId = Number(account.accountId)

            if(!Number.isInteger(accountId)) continue
            if(account.banned || account.disabled)continue
            if(assigned.has(accountId)) continue
            if(this.reserved.has(accountId)) continue
            if(excluded.has(accountId)) continue

            const state = stateMap.get(accountId)

            if(state?.status === "blocked" || state?.status === "retired"){
                continue
            }

            if(state?.status === "cooldown"){
                const cooldownUntil = state.cooldownUntil
                    ? new Date(state.cooldownUntil).getTime()
                    : 0

                if(!state.cooldownUntil || !Number.isFinite(cooldownUntil) || cooldownUntil > now) continue

                await this.markAvailable(accountId, "cooldown_expired")
            }

            this.reserved.add(accountId)

            this.logger.info("Account reserved", {
                accountId
            })

            return account
        }

        return null
    }

    releaseReservation(accountId){
        return this.reserved.delete(Number(accountId))
    }

    async getState(accountId){
        const state = await this.dataBaseManager.getAccountPoolState(accountId)

        return state ?? {
            accountId: Number(accountId),
            status: "available",
            reason: null,
            failureCount: 0,
            cooldownUntil: null,
            lastUsedAt: null,
            updatedAt: null
        }
    }

    async isUsable(accountId){
        const account=await this.dataBaseManager.getAccountData(accountId)
        if(!account || account.banned || account.disabled)return false
        const state = await this.getState(accountId)

        if(state.status === "blocked" || state.status === "retired"){
            return false
        }

        if(state.status !== "cooldown"){
            return state.status==='available'
        }

        if(!state.cooldownUntil){
            return false
        }

        if(new Date(state.cooldownUntil).getTime() > Date.now()){
            return false
        }

        await this.markAvailable(accountId, "cooldown_expired")
        return true
    }

    async markAvailable(accountId, reason = null){
        return this.#setState(accountId, {
            status: "available",
            reason,
            cooldownUntil: null
        })
    }

    async markBlocked(accountId, reason = null){
        return this.#setState(accountId, {
            status: "blocked",
            reason,
            cooldownUntil: null,
            incrementFailure: true
        })
    }

    async markRetired(accountId, reason = null){
        return this.#setState(accountId, {
            status: "retired",
            reason,
            cooldownUntil: null
        })
    }

    async markCooldown(accountId, {
        reason = null,
        durationMs
    }){
        const duration = Number(durationMs)

        if(!Number.isFinite(duration) || duration < 1){
            throw new Error("durationMs must be a positive number")
        }

        return this.#setState(accountId, {
            status: "cooldown",
            reason,
            cooldownUntil: new Date(Date.now() + duration).toISOString(),
            incrementFailure: true
        })
    }

    async markUsed(accountId){
        return this.dataBaseManager.updateAccountPoolUsage(
            accountId,
            new Date().toISOString()
        )
    }

    async getStats(){
        const accounts = await this.dataBaseManager.getAllAccountsData()
        const states = await this.dataBaseManager.getAllAccountPoolStates()
        const bots = await this.dataBaseManager.getAllBotsData()

        const assigned = new Set(
            bots
                .map(bot => bot.connectedAccountId)
                .filter(accountId => accountId !== null && accountId !== undefined)
                .map(Number)
        )

        const stateMap = new Map(states.map(state => [Number(state.accountId), state]))
        const result = {
            total: accounts.length,
            available: 0,
            assigned: 0,
            cooldown: 0,
            blocked: 0,
            retired: 0,
            reserved: this.reserved.size
        }

        for(const account of accounts){
            const accountId = Number(account.accountId)
            const state = stateMap.get(accountId)
            const status = state?.status ?? "available"

            if(assigned.has(accountId)){
                result.assigned++
            }else if(status in result){
                result[status]++
            }else{
                result.available++
            }
        }

        return result
    }

    async #setState(accountId, {
        status,
        reason = null,
        cooldownUntil = null,
        incrementFailure = false
    }){
        accountId = Number(accountId)

        if(!Number.isInteger(accountId) || accountId < 1){
            throw new Error("accountId must be a positive integer")
        }

        const account = await this.dataBaseManager.getAccountData(accountId)

        if(!account){
            throw new Error(`Account ${accountId} not found`)
        }

        const result = await this.dataBaseManager.updateAccountPoolState(accountId, {
            status,
            reason,
            cooldownUntil,
            incrementFailure
        })

        this.reserved.delete(accountId)

        this.logger.info("Account pool state changed", {
            accountId,
            status,
            reason,
            cooldownUntil
        })

        return result
    }
}
