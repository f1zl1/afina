import {setTimeout as sleep} from 'node:timers/promises'
import {auctionConstraints} from '../../../../core/market/marketConfig.js'
import AuctionObservationParser from './auctionObservationParser.js'
import {isAuctionWindow,sameAuction,waitForAuctionWindow} from '../../../utils/auctionWindow.js'

export default class AnalystExecution{
    constructor({client,logger,antiAfk=null,parser=new AuctionObservationParser(),random=Math.random,wait=sleep,now=Date.now}){
        Object.assign(this,{client,logger,antiAfk,parser,random,wait,now})
    }
    isAuction(window){
        return isAuctionWindow(window)
    }
    async execute(task,{signal,onObservation,onProgress}){
        if(!task?.analysisId || !Number.isInteger(task.observationCount) || task.observationCount<1 || task.observationCount>20 || typeof task.query!=='string' || !task.query.trim() || task.query.length>180 || /[\r\n]/.test(task.query)) throw new Error('INVALID_ANALYSIS_TASK')
        const timing=task.timing
        if(!timing || !Number.isFinite(timing.minimumRefreshIntervalMs) || timing.minimumRefreshIntervalMs<auctionConstraints.minimumRefreshMs || !Number.isFinite(timing.refreshJitterMs) || timing.refreshJitterMs<0 || !Number.isFinite(timing.windowTimeoutMs) || timing.windowTimeoutMs<1000) throw new Error('INVALID_ANALYSIS_TIMING')
        const controller=new AbortController(),abort=()=>controller.abort(signal?.reason ?? new Error('CANCELLED'))
        const disconnected=()=>controller.abort(new Error('DISCONNECTED'))
        signal?.addEventListener('abort',abort,{once:true})
        if(signal?.aborted) abort()
        this.client.on('end',disconnected)
        let window=null,refreshing=false
        const closed=w=>{if(window && !refreshing && (!w || w.id===window.id)) controller.abort(new Error('WINDOW_CLOSED'))}
        const opened=w=>{if(window && w!==window && !(refreshing && this.sameAuction(w,window))) controller.abort(new Error('UNEXPECTED_WINDOW'))}
        this.client.on('windowClose',closed);this.client.on('windowOpen',opened)
        const check=()=>{if(controller.signal.aborted) throw controller.signal.reason; if(window && (this.client.currentWindow!==window || !this.isAuction(window))) throw new Error('UNEXPECTED_WINDOW')}
        let release=this.antiAfk?.acquireBlock('ROLE_AUCTION_OPERATION')
        try{
            check()
            if(this.client.currentWindow) throw new Error('WINDOW_BUSY')
            window=await this.waitWindow(null,controller.signal,timing.windowTimeoutMs,()=>this.client.chat(`/ah search ${task.query}`))
            check()
            for(let ordinal=1;ordinal<=task.observationCount;ordinal++){
                check()
                onObservation({analysisId:task.analysisId,ordinal,observedAt:this.now(),lots:this.parser.scan(window,task,this.logger)})
                if(ordinal===task.observationCount) break
                const interval=timing.minimumRefreshIntervalMs+Math.floor(Math.max(0,Math.min(.999999,this.random()))*(timing.refreshJitterMs+1))
                onProgress({analysisId:task.analysisId,completedObservations:ordinal,requestedObservations:task.observationCount,nextRefreshAt:this.now()+interval})
                await this.wait(interval,undefined,{signal:controller.signal})
                check()
                // Yield at the boundary of completed observations; only close our own window.
                if(this.antiAfk?.isDue()){
                    const owned=window;window=null
                    this.client.closeWindow(owned)
                    release?.();release=null
                    await this.antiAfk.performIfDue()
                    check()
                    release=this.antiAfk.acquireBlock('ROLE_AUCTION_OPERATION')
                    if(this.client.currentWindow)throw new Error('WINDOW_BUSY')
                    window=await this.waitWindow(null,controller.signal,timing.windowTimeoutMs,()=>this.client.chat(`/ah search ${task.query}`))
                    continue
                }
                refreshing=true
                try{window=await this.waitWindow(window,controller.signal,timing.windowTimeoutMs,()=>this.client.clickWindow(auctionConstraints.refreshSlot,0,0))}
                finally{refreshing=false}
            }
            return {analysisId:task.analysisId,completedObservations:task.observationCount}
        }catch(error){
            if(controller.signal.aborted) throw controller.signal.reason
            throw error
        }finally{
            signal?.removeEventListener('abort',abort);this.client.off('end',disconnected)
            this.client.off('windowClose',closed);this.client.off('windowOpen',opened)
            if(window && this.client.currentWindow===window){try{this.client.closeWindow(window)}catch{}}
            release?.()
        }
    }
    sameAuction(next,previous){return sameAuction(next,previous)}
    waitWindow(window,signal,timeoutMs,action){
        return waitForAuctionWindow(this.client,{previousWindow:window,signal,timeoutMs,action})
    }
}
