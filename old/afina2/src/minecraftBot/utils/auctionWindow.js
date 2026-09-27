import {auctionConstraints} from '../../core/market/marketConfig.js'

export function isAuctionWindow(window){
    const title=typeof window?.title==='string'?window.title:JSON.stringify(window?.title ?? '')
    return window?.type===auctionConstraints.windowType && /аукцион|auction|поиск|search/i.test(title) && Array.isArray(window.slots) && window.slots.length>=54
}
export function sameAuction(next,previous){return isAuctionWindow(next) && JSON.stringify(next.title)===JSON.stringify(previous.title)}

// Shared, read-only GUI acknowledgement used by analysis and runtime readiness.
export function waitForAuctionWindow(client,{previousWindow:window=null,signal,timeoutMs,action}){
    return new Promise((resolve,reject)=>{
        let settled=false,quiet=null
        const finish=(error,value)=>{
            if(settled)return;settled=true
            clearTimeout(timer);clearTimeout(quiet);client.off('windowOpen',open)
            if(window){client.off(`setWindowItems:${window.id}`,updated);window.off?.('updateSlot',slotUpdated)}
            signal.removeEventListener('abort',abort)
            error?reject(error):resolve(value)
        }
        const open=w=>finish(isAuctionWindow(w) && (!window || sameAuction(w,window))?null:new Error('UNEXPECTED_WINDOW'),w)
        const updated=()=>finish(client.currentWindow===window && isAuctionWindow(window)?null:new Error('UNEXPECTED_WINDOW'),window)
        const slotUpdated=slot=>{if(slot>=0 && slot<=45){clearTimeout(quiet);quiet=setTimeout(updated,300)}}
        const abort=()=>finish(signal.reason ?? new Error('CANCELLED'))
        const timer=setTimeout(()=>finish(new Error(window?'REFRESH_TIMEOUT':'WINDOW_TIMEOUT')),timeoutMs)
        client.on('windowOpen',open)
        if(window){client.on(`setWindowItems:${window.id}`,updated);window.on?.('updateSlot',slotUpdated)}
        signal.addEventListener('abort',abort,{once:true})
        if(signal.aborted){abort();return}
        try{Promise.resolve(action()).catch(()=>finish(new Error('AUCTION_ACTION_FAILED')))}catch{finish(new Error('AUCTION_ACTION_FAILED'))}
    })
}
