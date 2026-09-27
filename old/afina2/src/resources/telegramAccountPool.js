export default class TelegramAccountPool{
    constructor({
        logger,
        store
    }){
        this.logger = logger.child("TelegramAccountPool")
        this.maxMinecraftAccounts = 8
        this.store = store
    }

    acquireForMinecraftAccount(accountId, availableIds){
        return this.store.assign(accountId,availableIds)
    }

    async getBinding(accountId){
        return this.store.account(accountId)?.telegramAccountId ?? null
    }

    async getStats(){
        const accounts = this.store.all()
        const used = accounts.reduce((sum,account)=>sum+this.store.count(account.telegramAccountId),0)
        return {
            configured: accounts.length,
            capacityPerAccount: this.maxMinecraftAccounts,
            usedCapacity: used,
            active:accounts.filter(a=>a.active).length,
            freeCapacity: accounts.filter(a=>a.active).reduce((n,a)=>n+Math.max(0,8-this.store.count(a.telegramAccountId)),0)
        }
    }
}
