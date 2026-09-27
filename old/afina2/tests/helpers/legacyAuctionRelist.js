// TEST ONLY: retired configured trading mechanics, never imported by production.
import { sleep, waitForWindow } from "../../src/minecraftBot/taskRunner/modes/reseller/resellerUtils.js"
import waitForBotMessage from "../../src/minecraftBot/utils/waitForBotMessage.js"
import RelistResultParser from "../../src/minecraftBot/taskRunner/modes/reseller/auction/relistResultParser.js"

export default class AuctionRelist{
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
        this.resultParser = new RelistResultParser()
        this.lastStorageState = null
    }

    getLastStorageState(){
        return this.lastStorageState
    }

    async inspectStorage(){
        const opened = await this.#openStorage()
        if(!opened) return null

        const {bot, window} = opened
        const state = this.#readStorageState(window)

        this.lastStorageState = state

        this.logger.info(`Bot ${this.bot.botId}: auction storage inspected`, state)

        if(bot.currentWindow){
            try{
                await this.server.closeWindow(bot.currentWindow, {
                    client: bot
                })
            }catch{}
        }

        return state
    }

    async relistItems(){
        const opened = await this.#openStorage()

        if(!opened){
            return {
                success: false,
                storage: null
            }
        }

        const {bot, window: storageWindow} = opened
        const storageState = this.#readStorageState(storageWindow)

        this.lastStorageState = storageState

        if(storageState.targetCount <= 0){
            if(bot.currentWindow){
                try{
                    await this.server.closeWindow(bot.currentWindow, {
                        client: bot
                    })
                }catch{}
            }

            return {
                success: false,
                storage: storageState
            }
        }

        const storageWindowId = storageWindow.id
        const relistSlot = this.#setting("auctionRelistSlot", 52)

        this.setState("waiting_storage")

        const relistButton = await this.#waitForWindowSlot({
            windowId: storageWindowId,
            slot: relistSlot,
            timeout: this.#setting("relistButtonTimeoutMs", 5000)
        })

        if(!relistButton){
            this.logger.warn(`Bot ${this.bot.botId}: relist button did not appear`, {
                windowId: storageWindowId,
                slot: relistSlot
            })

            return {
                success: false,
                storage: storageState
            }
        }

        if(!this.#validClient(bot)){
            return {
                success: false,
                storage: storageState
            }
        }

        if(bot.currentWindow?.id !== storageWindowId){
            this.logger.warn(
                `Bot ${this.bot.botId}: storage window changed before relist click`,
                {
                    expectedWindowId: storageWindowId,
                    currentWindowId: bot.currentWindow?.id ?? null
                }
            )

            return {
                success: false,
                storage: storageState
            }
        }

        this.setState("relisting")

        const responsePromise = waitForBotMessage({
            eventBus: this.eventBus,
            botId: this.bot.botId,
            matcher: text => this.resultParser.parse(text),
            timeout: this.#setting("relistResponseTimeoutMs", 5000)
        })

        this.logger.info(`Bot ${this.bot.botId}: clicking relist button`, {
            windowId: storageWindowId,
            slot: relistSlot,
            targetCount: storageState.targetCount
        })

        try{
            const clicked = await this.server.clickWindow(
                relistSlot,
                0,
                0,
                {client: bot}
            )

            if(clicked === false){
                return {
                    success: false,
                    storage: storageState
                }
            }
        }catch(error){
            this.logger.warn(
                `Bot ${this.bot.botId}: relist click failed`,
                {error: error?.message ?? String(error)}
            )

            return {
                success: false,
                storage: storageState
            }
        }

        const result = await responsePromise

        if(result !== "success"){
            this.bot.lifecycleUncertain='RELIST_RESULT_UNCERTAIN'
            this.logger.warn(
                `Bot ${this.bot.botId}: relist confirmation failed`,
                {result: result ?? "timeout"}
            )

            return {
                success: false,
                storage: storageState
            }
        }

        if(bot.currentWindow){
            try{
                await this.server.closeWindow(bot.currentWindow, {
                    client: bot
                })
            }catch{}
        }

        return {
            success: true,
            storage: storageState
        }
    }

    async #openStorage(){
        const bot = this.bot.client
        if(!bot) return null

        this.setState("opening_auction")

        if(bot.currentWindow){
            try{
                await this.server.closeWindow(bot.currentWindow, {
                    client: bot
                })
            }catch(error){
                this.logger.warn(
                    `Bot ${this.bot.botId}: failed to close current window before storage`,
                    {error: error?.message ?? String(error)}
                )
            }
        }

        if(!this.#validClient(bot)) return null

        this.logger.info(`Bot ${this.bot.botId}: opening auction storage`)

        const opened = await this.server.chat("/ah", {
            client: bot
        })

        if(opened === false) return null

        const auctionWindow = await waitForWindow({
            bot: () => this.bot.client,
            predicate: window => this.#isAuctionWindow(window),
            canContinue: this.canContinue,
            timeout: this.#setting("auctionOpenTimeoutMs", 5000)
        })

        if(!auctionWindow){
            this.logger.warn(`Bot ${this.bot.botId}: auction window did not open`)
            return null
        }

        this.server.rememberWindow(bot,auctionWindow)

        if(!this.#validClient(bot)) return null

        const storageSlot = this.#setting("auctionStorageSlot", 46)
        const previousWindowId = bot.currentWindow?.id

        if(previousWindowId === undefined || previousWindowId === null){
            this.logger.warn(`Bot ${this.bot.botId}: auction window id is missing`)
            return null
        }

        this.setState("opening_storage")

        const storageButton = bot.currentWindow?.slots?.[storageSlot]

        this.logger.info(`Bot ${this.bot.botId}: opening auction storage`, {
            windowId: previousWindowId,
            slot: storageSlot,
            button: this.#serializeItem(storageButton)
        })

        if(!this.#validClient(bot)) return null

        try{
            const clicked = await this.server.clickWindow(
                storageSlot,
                0,
                0,
                {client: bot}
            )

            if(clicked === false) return null
        }catch(error){
            this.logger.warn(
                `Bot ${this.bot.botId}: failed to click auction storage button`,
                {error: error?.message ?? String(error)}
            )

            return null
        }

        const storageWindow = await waitForWindow({
            bot: () => this.bot.client,
            predicate: window => Boolean(
                window &&
                window.id !== previousWindowId
            ),
            canContinue: this.canContinue,
            timeout: this.#setting("storageOpenTimeoutMs", 5000)
        })

        if(!storageWindow){
            this.logger.warn(
                `Bot ${this.bot.botId}: window did not change after storage click`
            )

            return null
        }

        this.server.rememberWindow(bot,storageWindow)

        this.logger.info(`Bot ${this.bot.botId}: auction storage window opened`, {
            previousWindowId,
            storageWindowId: storageWindow.id
        })

        if(!this.#validClient(bot)) return null

        return {
            bot,
            window: storageWindow
        }
    }

    #readStorageState(window){
        const startSlot = this.#setting("storageItemsStartSlot", 0)
        const endSlot = this.#setting("storageItemsEndSlot", 44)

        let totalLots = 0
        let totalCount = 0
        let targetLots = 0
        let targetCount = 0

        for(let slot = startSlot; slot <= endSlot; slot++){
            const item = window?.slots?.[slot]
            if(!item) continue

            const count = Number(item.count)
            const amount = Number.isFinite(count) && count > 0 ? count : 1

            totalLots++
            totalCount += amount

            if(!this.inventory.isTarget(item)) continue

            targetLots++
            targetCount += amount
        }

        return {
            targetLots,
            targetCount,
            totalLots,
            totalCount,
            checkedAt: Date.now()
        }
    }

    async #waitForWindowSlot({
        windowId,
        slot,
        timeout
    }){
        const startedAt = Date.now()

        while(Date.now() - startedAt < timeout){
            if(!this.canContinue()) return null

            const bot = this.bot.client
            if(!bot) return null

            const window = bot.currentWindow

            if(window && window.id !== windowId){
                return null
            }

            const item = window?.slots?.[slot]
            if(item) return item

            await sleep(50)
        }

        return null
    }

    #validClient(client){
        return Boolean(
            this.canContinue() &&
            this.bot.client === client
        )
    }

    #serializeItem(item){
        if(!item) return null

        return {
            slot: item.slot,
            type: item.type,
            name: item.name,
            displayName: item.displayName,
            count: item.count
        }
    }

    #isAuctionWindow(window){
        const type = String(window?.type ?? "").toLowerCase()
        return type.includes("generic_9x6")
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}
