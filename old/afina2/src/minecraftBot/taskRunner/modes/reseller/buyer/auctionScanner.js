export default class AuctionScanner{
    constructor({
        bot,
        inventory,
        logger,
        settings,
        priceParser
    }){
        this.bot = bot
        this.inventory = inventory
        this.logger = logger
        this.settings = settings
        this.priceParser = priceParser
    }

    findBestCandidate({
        window,
        maxPricePerOne,
        balance,
        minimumLotSize = null,
        maximumLotSize = Infinity
    }){
        if(!Number.isFinite(maxPricePerOne) || maxPricePerOne <= 0){
            return null
        }

        if(!Number.isFinite(balance) || balance <= 0){
            return null
        }

        const startSlot = this.#setting("auctionLotsStartSlot", 0)
        const endSlot = this.#setting("auctionLotsEndSlot", 44)
        const minLotSize = Number.isFinite(minimumLotSize)
            ? minimumLotSize
            : this.#setting("minimumLotSize", 21)

        let best = null

        for(let slot = startSlot; slot <= endSlot; slot++){
            const item = window?.slots?.[slot]
            if(!item) continue

            const count = Number(item.count)

            if(!Number.isSafeInteger(count) || count < minLotSize || count > maximumLotSize){
                continue
            }

            if(!this.inventory.isTarget(item)) continue

            const totalPrice = this.priceParser.extractTotalPrice(item)

            if(totalPrice === null){
                this.logger.warn(`Bot ${this.bot.botId}: could not parse auction lot price`, {
                    slot,
                    count
                })
                continue
            }

            const pricePerOne = totalPrice / count

            if(pricePerOne > maxPricePerOne) continue
            if(totalPrice > balance) continue

            const candidate = {
                slot,
                item,
                count,
                totalPrice,
                pricePerOne
            }

            if(!best){
                best = candidate
                continue
            }

            if(candidate.pricePerOne < best.pricePerOne){
                best = candidate
                continue
            }

            if(
                candidate.pricePerOne === best.pricePerOne &&
                candidate.totalPrice < best.totalPrice
            ){
                best = candidate
            }
        }

        return best
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}
