import waitForBotMessage from "../../../utils/waitForBotMessage.js"
import SellResultParser from "./seller/sellResultParser.js"

export default class ResellerSeller{
    constructor({
        bot,
        taskData,
        logger,
        eventBus,
        inventory,
        canContinue,
        setState,
        settings,
        server
    }){
        this.bot = bot
        this.taskData = taskData
        this.logger = logger
        this.eventBus = eventBus
        this.inventory = inventory
        this.canContinue = canContinue
        this.setState = setState
        this.settings = settings
        this.server = server

        this.resultParser = new SellResultParser()
    }

    async sellOne(item,economic=null){
        this.setState("preparing_sell")

        const prepared = await this.inventory.prepareOneForSell(item)
        if(!prepared) return "failed"
        if(!this.canContinue()) return "cancelled"

        const bot = this.bot.client
        if(!bot) return "cancelled"

        const sellHotbarIndex = this.#setting("sellHotbarIndex", 0)

        const selected = await this.server.selectHotbar(sellHotbarIndex, {
            client: bot
        })

        if(selected === false) return "cancelled"
        if(!this.canContinue()) return "cancelled"
        if(this.bot.client !== bot) return "cancelled"

        const price = this.taskData.sellPricePerOne

        this.setState("selling")
        this.logger.info(`Bot ${this.bot.botId}: selling item for ${price}`)

        const timeout = this.#setting("sellResponseTimeoutMs", 5000)
        const operation=this.bot.incidents?.begin('sell',bot.heldItem ?? bot.inventory?.slots[this.#setting('sellInventorySlot',36)])
        if(operation)operation.sent=false
        const responseController=new AbortController()
        const signal=operation?AbortSignal.any([responseController.signal,operation.controller.signal,this.bot.incidents.controller.signal]):responseController.signal
        const responsePromise = this.#waitForSellResponse(timeout,signal)
        try{

        const sent = await this.server.chat(`/ah sell ${price}`, {
            client: bot,
            guard:economic?()=>{const held=bot.heldItem??bot.inventory?.slots[this.#setting('sellInventorySlot',36)];return economic.canList?.()!==false&&this.inventory.isTarget(held)&&held.count===1&&(bot.quickBarSlot==null||bot.quickBarSlot===sellHotbarIndex)}:null,
            beforeSend:()=>{economic?.onRequest?.();if(operation){operation.sent=true;operation.timestamp=this.bot.incidents.now()}}
        })

        if(sent === false) return "cancelled"

        const result = await responsePromise
        economic?.onEvidence?.('LISTING_SERVER_RESULT',{outcome:result??'timeout'})
        if(operation?.rejected){
            // Mineflayer's inventory packet handlers are authoritative. Yield to them and
            // discard this attempt; the next cycle must prepare/select the stack again.
            await this.server.delay('inventory')
            return 'failed'
        }
        if(!this.canContinue() || this.bot.client!==bot){this.bot.lifecycleUncertain='SELL_RESULT_UNCERTAIN';return 'cancelled'}

        if(result === "success"){
            economic?.onListed?.()
            this.logger.info(`Bot ${this.bot.botId}: item listed successfully`)

            this.eventBus.emit("bot:itemListed", {
                botId: this.bot.botId,
                itemId: this.taskData.item.itemId,
                price
            })

            return "success"
        }

        if(result === "storage_full"){
            this.logger.warn(`Bot ${this.bot.botId}: auction storage is full`)
            return "storage_full"
        }

        if(result === "afk"){
            this.logger.warn(`Bot ${this.bot.botId}: AFK mode detected while selling`)
            return "afk"
        }

        this.logger.warn(`Bot ${this.bot.botId}: sell response timeout`)
        this.bot.lifecycleUncertain='SELL_RESULT_UNCERTAIN'
        return "timeout"
        }finally{responseController.abort();operation?.controller.abort();if(operation)this.bot.incidents.end(operation)}
    }

    #waitForSellResponse(timeout,signal){
        return waitForBotMessage({
            eventBus: this.eventBus,
            botId: this.bot.botId,
            timeout,
            signal,
            matcher: text => this.resultParser.parse(text)
        })
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}
