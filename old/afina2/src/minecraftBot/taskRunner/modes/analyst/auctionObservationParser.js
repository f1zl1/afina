import AuctionPriceParser from '../reseller/buyer/auctionPriceParser.js'
import InventoryMatcher from '../reseller/inventory/inventoryMatcher.js'
import nbtComponentToString from '../../../utils/nbtComponentToString.js'
import {auctionConstraints} from '../../../../core/market/marketConfig.js'

export default class AuctionObservationParser{
    constructor(){this.prices=new AuctionPriceParser()}
    scan(window,task,logger){
        const matcher=new InventoryMatcher({taskData:{item:{matcher:task.matcher}}}),lots=[]
        for(let slot=auctionConstraints.firstLotSlot;slot<=auctionConstraints.lastLotSlot;slot++){
            const item=window.slots[slot]
            if(!item) continue
            try{
                if(!matcher.isTarget(item)) continue
                const lines=(item.components?.find(c=>c.type==='lore')?.data ?? []).map(n=>nbtComponentToString(n).replace(/§[0-9a-fk-or]/gi,''))
                const sellerLine=lines.find(s=>/продавец|seller/i.test(s)) ?? ''
                const seller=sellerLine.match(/(?:продавец|seller)\s*[:»›]?\s*([a-z0-9_]{3,16})(?![a-z0-9_])/i)?.[1] ?? null
                lots.push({slot,amount:item.count,totalPrice:this.prices.extractTotalPrice(item),seller,
                    expires:lines.find(s=>/истека|истеч|осталось|expires|remaining/i.test(s)) ?? null})
            }catch{
                logger?.warn('Auction lot parse failed',{slot})
                lots.push({slot,amount:null,totalPrice:null,seller:null,invalidReason:'PARSER_ERROR'})
            }
        }
        return lots
    }
}
