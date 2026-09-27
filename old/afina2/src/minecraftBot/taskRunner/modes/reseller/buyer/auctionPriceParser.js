import nbtComponentToString from "../../../../utils/nbtComponentToString.js"

export default class AuctionPriceParser{
    extractTotalPrice(item){
        const loreComponent = item?.components?.find(
            component => component?.type === "lore"
        )

        const lore = loreComponent?.data
        if(!Array.isArray(lore)) return null

        for(const component of lore){
            const text = this.#stripMinecraftColors(
                nbtComponentToString(component)
            )

            if(!text.toLowerCase().includes("цен")) continue

            const matches = [
                ...text.matchAll(/\$\s*(\d[\d\s,.]*)/g)
            ]

            if(matches.length > 0){
                const raw = matches[matches.length - 1][1]
                const value = raw.replace(/[^\d]/g, "")
                const price = Number(value)

                if(Number.isSafeInteger(price) && price >= 0){
                    return price
                }
            }

            const fallback = text.match(
                /цен[^0-9]*(\d[\d\s,.]*)/i
            )

            if(fallback){
                const value = fallback[1].replace(/[^\d]/g, "")
                const price = Number(value)

                if(Number.isSafeInteger(price) && price >= 0){
                    return price
                }
            }
        }

        return null
    }

    #stripMinecraftColors(text){
        return String(text ?? "").replace(
            /§[0-9A-FK-OR]/gi,
            ""
        )
    }
}