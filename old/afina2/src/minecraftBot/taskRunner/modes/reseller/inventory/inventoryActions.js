export default class InventoryActions{
    constructor({
        bot,
        logger,
        eventBus,
        canContinue,
        matcher,
        settings,
        server,
        preserveUnrelated=false
    }){
        this.bot = bot
        this.logger = logger
        this.eventBus = eventBus
        this.canContinue = canContinue
        this.matcher = matcher
        this.settings = settings
        this.server = server
        this.preserveUnrelated=preserveUnrelated
    }

    async dropItem(item){
        if(!item || this.bot.incidents?.ignoredItem(item)) return false

        const unlocked = await this.#waitForInventory()
        if(!unlocked) return false

        const client = this.bot.client
        if(!client) return false

        this.bot.beginInventoryOperation()

        try{
            if(this.bot.client !== client) return false
            return await this.#dropStack(client, item)
        }finally{
            this.bot.endInventoryOperation()
        }
    }

    async prepareOneForSell(item){
        if(!item || this.bot.incidents?.ignoredItem(item)) return false

        const unlocked = await this.#waitForInventory()
        if(!unlocked) return false

        const client = this.bot.client
        if(!client) return false

        this.bot.beginInventoryOperation()

        try{
            if(this.bot.client !== client) return false

            if(client.currentWindow){
                await this.server.closeWindow(client.currentWindow, {
                    client,
                    category: "window"
                })
            }

            if(!this.#validClient(client)) return false

            let source = client.inventory.slots[item.slot]

            if(!source || this.bot.incidents?.ignoredItem(source) || !this.matcher.isTarget(source)){
                source = this.findTarget()
            }

            if(!source) return false

            const sellInventorySlot = this.#setting("sellInventorySlot", 36)
            const hotbarItem = client.inventory.slots[sellInventorySlot]
            if(this.preserveUnrelated&&hotbarItem&&(this.bot.incidents?.ignoredItem(hotbarItem)||!this.matcher.isTarget(hotbarItem)))return false
            if(hotbarItem && this.bot.incidents?.ignoredItem(hotbarItem)){
                const empty=this.#findEmptyMainSlot()
                if(empty===null){this.bot.incidents.blockInventory(client.inventory.slots.filter(i=>i && this.bot.incidents.ignoredItem(i)));return false}
                await this.server.moveSlotItem(sellInventorySlot,empty,{client})
                if(!this.#validClient(client))return false
                if(client.inventory.slots[sellInventorySlot] || !this.bot.incidents.ignoredItem(client.inventory.slots[empty]))return false
                return false // Re-read the inventory on the next safe cycle.
            }

            if(
                hotbarItem &&
                this.matcher.isTarget(hotbarItem) &&
                hotbarItem.count === 1
            ){
                return true
            }

            if(hotbarItem){
                if(this.matcher.isTarget(hotbarItem)){
                    const emptySlot = this.#findEmptyMainSlot()
                    if(emptySlot === null) return false

                    await this.server.moveSlotItem(
                        sellInventorySlot,
                        emptySlot,
                        {client}
                    )
                }else{
                    const dropped = await this.#dropStack(client, hotbarItem)
                    if(!dropped) return false
                }
            }

            if(!this.#validClient(client)) return false

            source = this.findTarget()
            if(!source) return false

            if(source.count === 1){
                if(source.slot !== sellInventorySlot){
                    await this.server.moveSlotItem(
                        source.slot,
                        sellInventorySlot,
                        {client}
                    )
                }

                await this.server.delay("inventory")

                const preparedItem = client.inventory.slots[sellInventorySlot]

                return Boolean(
                    preparedItem &&
                    preparedItem.count === 1 &&
                    this.matcher.isTarget(preparedItem)
                )
            }

            await this.server.clickWindow(
                source.slot,
                0,
                0,
                {client, category: "inventory"}
            )

            await this.server.clickWindow(
                sellInventorySlot,
                1,
                0,
                {client, category: "inventory"}
            )

            await this.server.clickWindow(
                source.slot,
                0,
                0,
                {client, category: "inventory"}
            )

            await this.server.delay("inventory")

            const preparedItem = client.inventory.slots[sellInventorySlot]

            return Boolean(
                preparedItem &&
                preparedItem.count === 1 &&
                this.matcher.isTarget(preparedItem)
            )
        }catch(error){
            this.#handleError("prepare_one_for_sell", error)
            return false
        }finally{
            this.bot.endInventoryOperation()
        }
    }

    findTarget(){
        const client = this.bot.client
        if(!client) return null

        const startSlot = this.#setting("inventoryStartSlot", 9)
        const endSlot = this.#setting("inventoryEndSlot", 44)

        for(let slot = startSlot; slot <= endSlot; slot++){
            const item = client.inventory.slots[slot]
            if(item && !this.bot.incidents?.ignoredItem(item) && this.matcher.isTarget(item)) return item
        }

        return null
    }

    async #dropStack(client, item){
        const data = {
            botId: this.bot.botId,
            itemId: item.type,
            minecraftName: item.name,
            displayName: item.displayName,
            count: item.count
        }

        this.logger.info(`Bot ${this.bot.botId}: dropping trash`, data)

        try{
            const result = await this.server.tossStack(item, {
                client,
                category: "inventory"
            })

            if(result === false) return false

            this.eventBus.emit("bot:trashDropped", data)
            return true
        }catch(error){
            this.#handleError("drop_item", error)
            return false
        }
    }

    #findEmptyMainSlot(){
        const client = this.bot.client
        if(!client) return null

        const startSlot = Math.max(9,this.#setting("inventoryStartSlot", 9))

        for(let slot = startSlot; slot <= 35; slot++){
            if(slot===this.#setting('sellInventorySlot',36))continue
            if(!client.inventory.slots[slot]) return slot
        }

        return null
    }

    async #waitForInventory(){
        return this.bot.waitForInventoryUnlock({
            canContinue: this.canContinue,
            pollInterval: 50
        })
    }

    #validClient(client){
        return Boolean(
            this.canContinue() &&
            this.bot.client === client
        )
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }

    #handleError(stage, error){
        const message = error?.message ?? String(error)

        this.logger.error(
            `Bot ${this.bot.botId}: reseller error at ${stage}`,
            {error: message}
        )

        this.eventBus.emit("bot:resellerError", {
            botId: this.bot.botId,
            stage,
            error: message
        })
    }
}
