import { sleep } from "../resellerUtils.js"

export default class ResellerServerDelay{
    constructor({settings}){
        this.settings = settings
        this.lastInteractionAt = 0
    }

    async wait(category = "server"){
        const {min, max} = this.#range(category)
        const targetDelay = this.#random(min, max)
        const elapsed = Date.now() - this.lastInteractionAt
        const remaining = Math.max(0, targetDelay - elapsed)

        if(remaining > 0){
            await sleep(remaining)
        }
    }

    async pause(category = "server"){
        const {min, max} = this.#range(category)
        await sleep(this.#random(min, max))
    }

    markInteraction(){
        this.lastInteractionAt = Date.now()
    }

    #range(category){
        switch(category){
            case "inventory":
                return {
                    min: this.#setting("inventoryActionDelayMinMs", 100),
                    max: this.#setting("inventoryActionDelayMaxMs", 200)
                }
            case "window":
                return {
                    min: this.#setting("windowInteractionDelayMinMs", 120),
                    max: this.#setting("windowInteractionDelayMaxMs", 250)
                }
            case "refresh":
                return {
                    min: this.#setting("auctionRefreshDelayMinMs", 350),
                    max: this.#setting("auctionRefreshDelayMaxMs", 600)
                }
            default:
                return {
                    min: this.#setting("serverInteractionDelayMinMs", 120),
                    max: this.#setting("serverInteractionDelayMaxMs", 250)
                }
        }
    }

    #random(min, max){
        const from = Math.min(Number(min) || 0, Number(max) || 0)
        const to = Math.max(Number(min) || 0, Number(max) || 0)

        return Math.floor(Math.random() * (to - from + 1)) + from
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }
}