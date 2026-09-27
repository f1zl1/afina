import { sleep } from "../resellerUtils.js"

export default class PurchaseVerifier{
    constructor({
        bot,
        inventory,
        canContinue,
        settings
    }){
        this.bot = bot
        this.inventory = inventory
        this.canContinue = canContinue
        this.settings = settings
    }

    countTargetInventory(){
        const bot = this.bot.client
        if(!bot) return 0

        const startSlot = this.#setting("inventoryStartSlot", 9)
        const endSlot = this.#setting("inventoryEndSlot", 44)

        let count = 0

        for(let slot = startSlot; slot <= endSlot; slot++){
            const item = bot.inventory?.slots?.[slot]

            if(!item || !this.inventory.isTarget(item)){
                continue
            }

            count += Number(item.count) || 0
        }

        return count
    }

    async waitForInventoryIncrease({
        beforeCount,
        timeout = null
    }){
        const waitTimeout = timeout ??
            this.#setting("purchaseVerifyTimeoutMs", 5000)

        const startedAt = Date.now()

        while(Date.now() - startedAt < waitTimeout){
            if(!this.canContinue()) return false

            if(this.countTargetInventory() > beforeCount){
                return true
            }

            await sleep(50)
        }

        return false
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}