// TEST ONLY: retired configured trading mechanics, never imported by production.
import AuctionRelist from "./legacyAuctionRelist.js"

export default class ResellerAuction{
    constructor({
        bot,
        inventory,
        logger,
        eventBus,
        canContinue,
        setState,
        settings,
        server
    }){
        this.bot = bot
        this.inventory = inventory
        this.logger = logger
        this.eventBus = eventBus
        this.canContinue = canContinue
        this.setState = setState
        this.settings = settings
        this.server = server

        this.storageFull = false
        this.lastRelistAttemptAt = 0
        this.lastCapacityProbeAt = 0
        this.forceCapacityProbe = false
        this.lastStorageCheckAt = 0
        this.lastStorageState = null
        this.outOfFundsNotified = false

        this.relist = new AuctionRelist({
            bot: this.bot,
            inventory: this.inventory,
            logger: this.logger,
            eventBus: this.eventBus,
            canContinue: this.canContinue,
            setState: this.setState,
            settings: this.settings,
            server: this.server
        })
    }

    isStorageFull(){
        return this.storageFull
    }

    markStorageFull(){
        const wasFull = this.storageFull
        this.storageFull = true

        if(wasFull) return

        this.lastCapacityProbeAt = Date.now()

        this.logger.info(`Bot ${this.bot.botId}: auction marked as full`)

        this.eventBus.emit("bot:auctionStorageFull", {
            botId: this.bot.botId
        })
    }

    markStorageAvailable(){
        if(!this.storageFull){
            this.forceCapacityProbe = false
            return
        }

        this.storageFull = false
        this.forceCapacityProbe = false

        this.logger.info(`Bot ${this.bot.botId}: auction has free capacity`)

        this.eventBus.emit("bot:auctionStorageAvailable", {
            botId: this.bot.botId
        })
    }

    requestCapacityProbe(){
        if(!this.storageFull) return

        this.forceCapacityProbe = true
    }

    resetOutOfFunds(){
        this.outOfFundsNotified = false
    }

    canProbeCapacity(){
        if(!this.storageFull) return false
        if(this.forceCapacityProbe) return true

        return (
            Date.now() - this.lastCapacityProbeAt >=
            this.#setting("capacityProbeCooldownMs", 5000)
        )
    }

    markCapacityProbeStarted(){
        this.lastCapacityProbeAt = Date.now()
        this.forceCapacityProbe = false
    }

    getCapacityProbeRemainingTime(){
        if(this.forceCapacityProbe) return 0

        return Math.max(
            0,
            this.#setting("capacityProbeCooldownMs", 5000) -
            (Date.now() - this.lastCapacityProbeAt)
        )
    }

    canRelist(){
        return (
            Date.now() - this.lastRelistAttemptAt >=
            this.#setting("relistCooldownMs", 60_000)
        )
    }

    async handleStorageFull(){
        if(!this.storageFull) return false
        if(!this.canContinue()) return false
        if(!this.canRelist()) return false

        return this.relistItems()
    }

    async handleLowBalance(){
        if(!this.canContinue()) return "cancelled"

        let storageState = null

        if(this.canRelist()){
            await this.relistItems({
                requireStorageFull: false
            })

            storageState = this.lastStorageState
        }else{
            storageState = await this.inspectStorage()
        }

        if(!storageState) return "unknown"

        if(storageState.targetCount > 0){
            this.outOfFundsNotified = false

            this.eventBus.emit("bot:resellerWaitingForSale", {
                botId: this.bot.botId,
                balance: this.bot.balance,
                itemId: this.bot.taskData?.item?.itemId ?? null,
                storageTargetCount: storageState.targetCount
            })

            return "waiting_for_sale"
        }

        if(!this.outOfFundsNotified){
            this.outOfFundsNotified = true

            this.logger.warn(`Bot ${this.bot.botId}: reseller is out of funds`, {
                balance: this.bot.balance,
                storageTargetCount: 0
            })

            this.eventBus.emit("bot:resellerOutOfFunds", {
                botId: this.bot.botId,
                balance: this.bot.balance,
                itemId: this.bot.taskData?.item?.itemId ?? null,
                storageTargetCount: 0
            })
        }

        return "out_of_funds"
    }

    async inspectStorage({
        force = false
    } = {}){
        const cooldown = this.#setting("storageCheckCooldownMs", 15_000)

        if(
            !force &&
            this.lastStorageState &&
            Date.now() - this.lastStorageCheckAt < cooldown
        ){
            return this.lastStorageState
        }

        const state = await this.relist.inspectStorage()
        if(!state) return null

        this.#updateStorageState(state)

        return state
    }

    async relistItems({
        requireStorageFull = true
    } = {}){
        if(requireStorageFull && !this.storageFull) return false
        if(!this.canRelist()) return false
        if(!this.canContinue()) return false

        this.lastRelistAttemptAt = Date.now()

        const result = await this.relist.relistItems()

        if(result?.storage){
            this.#updateStorageState(result.storage)
        }

        if(!result?.success) return false

        const relistedAt = Date.now()

        this.logger.info(`Bot ${this.bot.botId}: items relisted`, {
            at: relistedAt,
            storageStillConsideredFull: this.storageFull,
            targetCount: result.storage?.targetCount ?? null
        })

        this.eventBus.emit("bot:itemsRelisted", {
            botId: this.bot.botId,
            at: relistedAt,
            targetCount: result.storage?.targetCount ?? null
        })

        return true
    }

    #updateStorageState(state){
        this.lastStorageState = state
        this.lastStorageCheckAt = Date.now()

        if(state.targetCount > 0){
            this.outOfFundsNotified = false
        }
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}