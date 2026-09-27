import {
    sleep,
    waitForWindow
} from "./resellerUtils.js"

import AuctionPriceParser from "./buyer/auctionPriceParser.js"
import AuctionScanner from "./buyer/auctionScanner.js"
import PurchaseVerifier from "./buyer/purchaseVerifier.js"

export default class ResellerBuyer{
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

        this.priceParser = new AuctionPriceParser()

        this.scanner = new AuctionScanner({
            bot,
            inventory,
            logger,
            settings,
            priceParser: this.priceParser
        })

        this.purchaseVerifier = new PurchaseVerifier({
            bot,
            inventory,
            canContinue,
            settings
        })
    }

    async buyUntilSuccess(economic=null){
        this.economic=economic
        while(this.canContinue()){
            if(this.bot.lifecycleQuiescing)return 'quiesced'
            const bot = this.bot.client
            if(!bot) return "cancelled"

            if(this.inventory.findTarget()) return "already_have_item"

            const auctionWindow = await this.#openSearch()

            if(!auctionWindow){
                if(economic)return 'search_unavailable'
                if(!this.canContinue()) return "cancelled"
                await sleep(this.#setting("auctionSearchRetryDelayMs", 1000))
                continue
            }

            const result = await this.#searchWindowLoop(auctionWindow)
            if(economic)return result

            if(
                result === "success" ||
                result === "already_have_item" ||
                result === "insufficient_balance"
            ){
                return result
            }

            if(result === "cancelled"||result==='quiesced') return result

            await sleep(this.#setting("buyerRetryDelayMs", 250))
        }

        return "cancelled"
    }

    async #openSearch(){
        if(!this.canContinue()) return null

        const bot = this.bot.client
        if(!bot) return null

        const searchQuery = this.taskData?.item?.searchQuery

        if(!searchQuery || typeof searchQuery !== "string"){
            this.logger.error(`Bot ${this.bot.botId}: reseller buyer searchQuery is missing`, {
                item: this.taskData?.item ?? null
            })
            return null
        }

        this.setState("opening_buy_search")

        if(bot.currentWindow){
            try{
                await this.server.closeWindow(bot.currentWindow, {
                    client: bot
                })
            }catch{}
        }

        if(!this.canContinue() || this.bot.client !== bot) return null

        this.logger.info(`Bot ${this.bot.botId}: opening auction search`, {
            searchQuery
        })

        const sent = await this.server.chat(`/ah search ${searchQuery}`, {
            client: bot
        })

        if(sent === false) return null

        const window = await waitForWindow({
            bot: () => this.bot.client,
            predicate: currentWindow => this.#isAuctionWindow(currentWindow),
            canContinue: this.canContinue,
            timeout: this.#setting("auctionOpenTimeoutMs", 5000)
        })

        if(!window){
            this.economic?.onEvidence?.('BUY_SEARCH_RESULT',{outcome:'MISSING'})
            this.logger.warn(`Bot ${this.bot.botId}: auction search window did not open`)
            return null
        }

        this.server.rememberWindow(bot,window)
        this.economic?.onEvidence?.('BUY_SEARCH_RESULT',{outcome:'OPENED',windowId:window.id})

        if(!this.canContinue() || this.bot.client !== bot) return null

        return bot.currentWindow
    }

    async #searchWindowLoop(initialWindow){
        let expectedWindowId = initialWindow?.id
        let scans = 0

        const maxPricePerOne = Number(this.taskData?.buyPricePerOne)
        const balanceAtCycleStart = Number(this.bot.balance)
        const configuredMinimumLotSize = this.#setting("minimumLotSize", 21)
        const lowBalance = (
            Number.isFinite(maxPricePerOne) &&
            Number.isFinite(balanceAtCycleStart) &&
            balanceAtCycleStart < maxPricePerOne
        )

        const minimumLotSize = (
            Number.isFinite(maxPricePerOne) &&
            Number.isFinite(balanceAtCycleStart) &&
            balanceAtCycleStart < maxPricePerOne * configuredMinimumLotSize
        )
            ? 1
            : configuredMinimumLotSize

        const lowBalanceMaxScans = this.#setting("lowBalanceBuyScans", 3)

        if(minimumLotSize !== configuredMinimumLotSize){
            this.logger.info(`Bot ${this.bot.botId}: lowering minimum buy lot size`, {
                configuredMinimumLotSize,
                minimumLotSize,
                maxPricePerOne,
                balance: balanceAtCycleStart
            })
        }

        while(this.canContinue()){
            if(this.bot.lifecycleQuiescing)return 'quiesced'
            const bot = this.bot.client
            if(!bot) return "cancelled"

            if(this.inventory.findTarget()) return "already_have_item"

            const window = bot.currentWindow

            if(!window || !this.#isAuctionWindow(window)) return "reopen"

            expectedWindowId = window.id
            this.setState("scanning_buy_lots")

            const candidate = this.scanner.findBestCandidate({
                window,
                maxPricePerOne,
                balance: Number(this.bot.balance),
                minimumLotSize:this.economic?1:minimumLotSize,
                maximumLotSize:this.economic?.remainingQuantity??Infinity
            })

            scans++

            if(candidate){
                this.logger.info(`Bot ${this.bot.botId}: suitable auction lot found`, {
                    slot: candidate.slot,
                    count: candidate.count,
                    totalPrice: candidate.totalPrice,
                    pricePerOne: candidate.pricePerOne,
                    maxBuyPricePerOne: this.taskData.buyPricePerOne,
                    minimumLotSize,
                    balance: this.bot.balance
                })

                const result = await this.#tryBuyCandidate({
                    windowId: expectedWindowId,
                    candidate,
                    minimumLotSize:this.economic?1:minimumLotSize
                })

                if(result === "success") return "success"
                if(result === "cancelled") return "cancelled"

                return this.economic?result:"reopen"
            }

            if(this.economic)return 'price_unavailable'
            if(lowBalance && scans >= lowBalanceMaxScans){
                this.logger.info(`Bot ${this.bot.botId}: no affordable auction lots found`, {
                    balance: this.bot.balance,
                    maxBuyPricePerOne: maxPricePerOne,
                    scans
                })

                return "insufficient_balance"
            }

            const refreshed = await this.#refreshAuction(expectedWindowId)
            if(!refreshed) return "reopen"
        }

        return "cancelled"
    }

    async #tryBuyCandidate({
        windowId,
        candidate,
        minimumLotSize
    }){
        if(!this.canContinue()) return "cancelled"

        const bot = this.bot.client
        if(!bot) return "cancelled"

        const auctionWindow = bot.currentWindow

        if(!auctionWindow || auctionWindow.id !== windowId) return "gone"

        const currentItem = auctionWindow.slots?.[candidate.slot]

        if(!currentItem || !this.inventory.isTarget(currentItem)) return "gone"

        const currentCount = Number(currentItem.count)
        const currentPrice = this.priceParser.extractTotalPrice(currentItem)

        if(
            !Number.isFinite(currentCount) ||
            currentCount < minimumLotSize || currentCount>(this.economic?.remainingQuantity??Infinity) ||
            currentPrice === null
        ){
            return "gone"
        }

        const maxPricePerOne = Number(this.taskData.buyPricePerOne)
        const currentPricePerOne = currentPrice / currentCount
        const balance = Number(this.bot.balance)

        if(currentPricePerOne > maxPricePerOne || currentPrice > balance){
            return "gone"
        }

        const beforeCount = this.purchaseVerifier.countTargetInventory()
        this.economic?.onEvidence?.('BUY_LOT_SELECTED',{slot:candidate.slot,count:currentCount,totalPrice:currentPrice,beforeCount})

        this.setState("opening_buy_confirmation")

        this.logger.info(`Bot ${this.bot.botId}: clicking auction lot`, {
            slot: candidate.slot,
            count: currentCount,
            totalPrice: currentPrice,
            pricePerOne: currentPricePerOne
        })

        try{
            const clicked = await this.server.clickWindow(
                candidate.slot,
                0,
                0,
                {client: bot}
            )

            if(clicked === false) return "gone"
        }catch(error){
            this.logger.warn(`Bot ${this.bot.botId}: auction lot click failed`, {
                code:'BUY_LOT_CLICK_FAILED'
            })
            return "gone"
        }

        if(!this.canContinue()) return "cancelled"

        const confirmationWindow = await waitForWindow({
            bot: () => this.bot.client,
            predicate: window => Boolean(window && window.id !== windowId),
            canContinue: this.canContinue,
            timeout: this.#setting("purchaseConfirmationTimeoutMs", 3000)
        })

        if(!confirmationWindow){
            this.economic?.onEvidence?.('BUY_CONFIRMATION_RESULT',{outcome:'CONFIRMATION_MISSING'})
            if(this.economic)this.bot.lifecycleUncertain='PURCHASE_RESULT_UNCERTAIN'
            this.logger.info(
                `Bot ${this.bot.botId}: buy confirmation did not open; lot probably disappeared`
            )
            return "gone"
        }

        const confirmationWindowId = confirmationWindow.id
        this.economic?.onEvidence?.('BUY_CONFIRMATION_RESULT',{outcome:'OPENED',windowId:confirmationWindowId})
        const confirmationSlot = this.#setting("purchaseConfirmSlot", 0)

        const confirmationItem = await this.#waitForWindowSlot({
            windowId: confirmationWindowId,
            slot: confirmationSlot,
            timeout: this.#setting("purchaseConfirmationSlotTimeoutMs", 2000)
        })

        if(!confirmationItem){
            this.economic?.onEvidence?.('BUY_CONFIRMATION_RESULT',{outcome:'SLOT_MISSING'})
            if(this.economic)this.bot.lifecycleUncertain='PURCHASE_RESULT_UNCERTAIN'
            this.logger.warn(`Bot ${this.bot.botId}: buy confirmation slot did not appear`, {
                windowId: confirmationWindowId,
                slot: confirmationSlot
            })
            return "failed"
        }

        if(!this.canContinue()) return "cancelled"
        if(bot.currentWindow?.id !== confirmationWindowId) return "gone"

        this.setState("confirming_purchase")

        this.logger.info(`Bot ${this.bot.botId}: confirming auction purchase`, {
            windowId: confirmationWindowId,
            slot: confirmationSlot,
            expectedCount: currentCount,
            totalPrice: currentPrice
        })

        try{
            const clicked = await this.server.clickWindow(
                confirmationSlot,
                0,
                0,
                {client: bot,beforeSend:()=>this.economic?.onRequest?.()}
            )

            if(clicked === false) return "cancelled"
        }catch(error){
            this.logger.warn(`Bot ${this.bot.botId}: purchase confirmation click failed`, {
                code:'BUY_CONFIRMATION_CLICK_FAILED'
            })
            return "failed"
        }

        this.setState("verifying_purchase")

        const received = await this.purchaseVerifier.waitForInventoryIncrease({
            beforeCount,
            timeout: this.#setting("purchaseVerifyTimeoutMs", 5000)
        })

        if(!received){
            this.economic?.onEvidence?.('BUY_INVENTORY_RESULT',{outcome:'INVENTORY_UNCONFIRMED',beforeCount,afterCount:this.purchaseVerifier.countTargetInventory()})
            this.bot.lifecycleUncertain='PURCHASE_RESULT_UNCERTAIN'
            this.logger.warn(`Bot ${this.bot.botId}: purchase was not confirmed by inventory`, {
                beforeCount,
                expectedLotCount: currentCount,
                totalPrice: currentPrice
            })

            this.eventBus.emit("bot:itemPurchaseFailed", {
                botId: this.bot.botId,
                itemId: this.taskData?.item?.itemId ?? null,
                expectedCount: currentCount,
                totalPrice: currentPrice
            })

            return "failed"
        }

        const afterCount = this.purchaseVerifier.countTargetInventory()
        const receivedCount = Math.max(0, afterCount - beforeCount)
        this.economic?.onEvidence?.('BUY_INVENTORY_RESULT',{beforeCount,afterCount,receivedCount})
        if(this.economic){
            if(receivedCount!==currentCount){this.bot.lifecycleUncertain='PURCHASE_RESULT_UNCERTAIN';return 'failed'}
            this.economic.onPurchase(receivedCount,currentPrice)
        }

        this.logger.info(`Bot ${this.bot.botId}: auction purchase successful`, {
            beforeCount,
            afterCount,
            receivedCount,
            expectedLotCount: currentCount,
            totalPrice: currentPrice,
            pricePerOne: currentPricePerOne
        })

        this.eventBus.emit("bot:itemPurchased", {
            botId: this.bot.botId,
            itemId: this.taskData?.item?.itemId ?? null,
            count: receivedCount,
            totalPrice: currentPrice,
            pricePerOne: currentPricePerOne
        })

        if(bot.currentWindow){
            try{
                await this.server.closeWindow(bot.currentWindow, {
                    client: bot
                })
            }catch{}
        }

        return "success"
    }

    async #refreshAuction(windowId){
        if(!this.canContinue()) return false

        const bot = this.bot.client
        if(!bot) return false

        const window = bot.currentWindow

        if(
            !window ||
            window.id !== windowId ||
            !this.#isAuctionWindow(window)
        ){
            return false
        }

        const refreshSlot = this.#setting("auctionRefreshSlot", 45)

        const refreshButton = await this.#waitForWindowSlot({
            windowId,
            slot: refreshSlot,
            timeout: this.#setting("auctionRefreshButtonTimeoutMs", 2000)
        })

        if(!refreshButton){
            this.logger.warn(`Bot ${this.bot.botId}: auction refresh button did not appear`)
            return false
        }

        this.setState("refreshing_buy_search")

        try{
            const clicked = await this.server.clickWindow(
                refreshSlot,
                0,
                0,
                {client: bot}
            )

            if(clicked === false) return false
        }catch(error){
            this.logger.warn(`Bot ${this.bot.botId}: auction refresh click failed`, {
                code:'BUY_REFRESH_FAILED'
            })
            return false
        }

        await this.server.delay("refresh")

        if(!this.canContinue()) return false

        const currentWindow = bot.currentWindow

        return Boolean(
            currentWindow &&
            this.#isAuctionWindow(currentWindow)
        )
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
            if(!window || window.id !== windowId) return null

            const item = window.slots?.[slot]
            if(item) return item

            await sleep(50)
        }

        return null
    }

    #isAuctionWindow(window){
        if(!window) return false

        const type = String(window.type ?? "").toLowerCase()

        return type.includes("generic_9x6")
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}
