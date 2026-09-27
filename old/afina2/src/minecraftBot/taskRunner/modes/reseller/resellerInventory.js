import InventoryMatcher from "./inventory/inventoryMatcher.js"
import InventoryActions from "./inventory/inventoryActions.js"

export default class ResellerInventory{
    constructor({
        bot,
        taskData,
        logger,
        eventBus,
        canContinue,
        setState,
        settings,
        server
    }){
        this.bot = bot
        this.taskData = taskData
        this.logger = logger
        this.eventBus = eventBus
        this.canContinue = canContinue
        this.setState = setState
        this.settings = settings
        this.server = server

        this.matcher = new InventoryMatcher({
            taskData: this.taskData
        })

        this.actions = new InventoryActions({
            preserveUnrelated:taskData.manualEconomic===true,
            bot: this.bot,
            logger: this.logger,
            eventBus: this.eventBus,
            canContinue: this.canContinue,
            matcher: this.matcher,
            settings: this.settings,
            server: this.server
        })
    }

    async cleanup(){
        const client = this.bot.client
        if(!client) return

        this.setState("cleaning_inventory")

        const startSlot = this.#setting("inventoryStartSlot", 9)
        const endSlot = this.#setting("inventoryEndSlot", 44)

        for(let slot = startSlot; slot <= endSlot; slot++){
            if(!this.canContinue()) return

            const unlocked = await this.bot.waitForInventoryUnlock({
                canContinue: this.canContinue,
                pollInterval: 50
            })

            if(!unlocked) return

            const currentClient = this.bot.client

            if(!currentClient || currentClient !== client){
                return
            }

            const item = currentClient.inventory.slots[slot]

            if(!item || this.isTarget(item) || this.bot.incidents?.ignoredItem(item)){
                continue
            }

            await this.dropItem(item)
        }
        const items=client.inventory.slots.slice(startSlot,endSlot+1)
        if(items.every(Boolean) && !this.findTarget() && items.some(item=>this.bot.incidents?.ignoredItem(item))){
            this.bot.incidents.blockInventory(items.filter(item=>this.bot.incidents.ignoredItem(item)))
        }
    }

    dropItem(item){
        return this.actions.dropItem(item)
    }

    findTarget(){
        return this.actions.findTarget()
    }

    isTarget(item){
        return !this.bot.incidents?.ignoredItem(item) && this.matcher.isTarget(item)
    }

    prepareOneForSell(item){
        return this.actions.prepareOneForSell(item)
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}
