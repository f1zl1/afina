import {randomUUID} from 'node:crypto'
import {reason} from '../corePolicy.js'
import {auctionConstraints} from './marketConfig.js'

// Coordinates the existing Core / worker contract. Never uses Mineflayer or trades.
export default class AnalysisCoordinator{
    constructor({core,store,planner}){Object.assign(this,{core,store,planner});this.priorities=[];this.assessment=[];this.lastPlannerSignature=null}
    admissionCandidates({policy,actual,admission}){
        if(!policy.operations.automationActive||!policy.autoAnalysis)return []
        const busy=new Set(this.store.sessions().map(s=>s.botId))
        return actual.bots.filter(b=>b.role==='analyst'&&!b.manualHold&&!b.configurationStale).sort((a,b)=>a.botId-b.botId).slice(0,policy.operations.roles.analyst.target)
            .filter(b=>admission.botIds.has(b.botId)&&!this.core.workloads.eligible(b)&&b.analysisState==='idle'&&!busy.has(b.botId))
            .map(b=>({action:'analysis_workload',target:{botId:b.botId},after:{type:'analyst'},result:'planned'}))
    }
    restore(){
        for(const session of this.store.sessions()) this.finish(session,'cancelled','APPLICATION_RESTARTED')
    }
    record(session,code,result,details={}){
        const old=this.core.store.getDecision(session.decisionId)
        this.core.record({...old,decisionId:session.decisionId,actionId:session.analysisId,
            trigger:old?.trigger ?? {type:code,source:'core',details:{}},action:'analysis',target:{botId:session.botId,itemId:session.itemId},
            before:old?.before ?? null,after:{analysisId:session.analysisId,...details},constraintsApplied:old?.constraintsApplied ?? [],alternatives:old?.alternatives ?? [],
            result,updatedAt:Date.now(),reasons:[...(old?.reasons ?? []),reason(code,code==='ANALYSIS_COMPLETED'?'Аналіз завершено; спостереження збережено.':'Стан аналізу змінено.',details)]},true)
    }
    finish(session,status,code){
        if(!this.store.finish(session.analysisId,status,code)) return
        if(status!=='completed')this.core.workloads.cancel(session)
        const current=this.store.session(session.analysisId)
        const model=this.store.snapshot(this.core.runtimePolicy()).items.find(m=>m.analysisId===session.analysisId)
        const details={analysisId:session.analysisId,status,code,itemId:session.itemId,botId:session.botId,
            observations:current.completedObservations,lotsObserved:current.lotsObserved,durationMs:Date.now()-session.startedAt,
            independentLots:model?.independentLotCount ?? 0,ownLots:model?.ownLotCount ?? 0,highOutliers:model?.excludedHighOutlierCount ?? 0}
        this.record(session,status==='completed'?'ANALYSIS_COMPLETED':code,status==='completed'?'applied':'failed',details)
        this.core.eventBus.publish(status==='completed'?'core.analysis.completed':'core.analysis.failed',details)
        this.core.schedule({type:status==='completed'?'ANALYSIS_COMPLETED':'ANALYSIS_FAILED',source:'core',details:{analysisId:session.analysisId}})
    }
    handle(event){
        if(!event.type.startsWith('bot.analysis.')) return false
        const botId=event.source?.botId,bot=this.core.botManager.getBot(botId)
        if(this.core.botManager.isCurrentWorkerEvent?.(event)===false)return true
        const runtime=this.core.readActual().bots.find(b=>b.botId===botId)
        if(!bot || !runtime?.running || runtime.workerPid!==event.source?.workerPid) return true
        const payload=event.payload ?? {}
        if(event.type==='bot.analysis.status'){
            if(['idle','busy','unavailable'].includes(payload.state)) bot.analysisState=payload.state
            if(payload.state==='busy'&&typeof payload.analysisId==='string'){
                const session=this.store.session(payload.analysisId)
                const task=session&&(typeof session.task==='string'?JSON.parse(session.task):session.task)
                if(session?.botId===botId&&session.workerPid===runtime.workerPid&&(task.workloadGeneration==null||payload.workloadGeneration===task.workloadGeneration)&&this.core.workloads.current(session,runtime))this.store.progress(session.analysisId,null)
            }
            if(payload.state==='unavailable'){
                for(const session of this.store.sessions().filter(s=>s.botId===botId && s.workerPid===runtime.workerPid)){
                    const task=typeof session.task==='string'?JSON.parse(session.task):session.task
                    if(task.incarnationId!==runtime.incarnationId||payload.analysisId&&payload.analysisId!==session.analysisId||task.workloadGeneration!=null&&payload.workloadGeneration!==task.workloadGeneration)continue
                    this.finish(session,'cancelled',payload.code==='AFK_INTERRUPTED'?'AFK_INTERRUPTED':'ANALYST_ROLE_ENDED')
                }
            }
            this.core.schedule({type:'ANALYST_STATUS_CHANGED',source:'bot',details:{botId}})
            return true
        }
        if(typeof payload.analysisId!=='string') return true
        const session=this.store.session(payload.analysisId)
        if(!session || !['planned','running'].includes(session.status) || session.botId!==botId || session.workerPid!==runtime.workerPid) return true
        const policy=this.core.runtimePolicy()
        const hold=this.core.store.control().find(c=>c.botId===botId)?.manualHold
        const current=this.store.store.prepare('SELECT b.serverId,b.realm,b.archived,t.type,t.enabled FROM botData b LEFT JOIN tasksData t ON t.botId=b.botId WHERE b.botId=?').get(botId)
        const item=this.store.items().find(i=>i.itemId===session.itemId),task=JSON.parse(session.task)
        if(task.workloadGeneration!=null&&payload.workloadGeneration!==task.workloadGeneration)return true
        if(!this.core.workloads.owns(session,runtime) || (!this.core.workloads.current(session,runtime)&&event.type!=='bot.analysis.failed') || this.core.actions.ledger.active().some(a=>a.botId===botId) || !policy.operations.automationActive || !policy.autoAnalysis || hold || this.core.store.revision()!==session.inputRevision || runtime.desiredState!=='running'
            || current?.archived || current?.type!=='analyst' || current?.enabled!==1 || current.serverId!==session.serverId || current.realm!==session.realm
            || item?.searchQuery!==task.query || item?.matcher!==task.matcherJson){
            this.finish(session,'cancelled','ANALYSIS_CANCELLED');return true
        }
        if(Date.now()>session.deadline){this.finish(session,'timed_out','ANALYSIS_TIMEOUT');return true}
        try{
            if(event.type==='bot.analysis.observation'){
                const model=this.store.observe(session,payload,policy)
                if(model){
                    this.core.eventBus.publish('core.market.updated',{revision:this.store.revision(),itemId:session.itemId,serverId:session.serverId,realm:session.realm,lastObservedAt:model.lastObservedAt})
                    this.core.eventBus.publish('core.analysis.progress',{analysisId:session.analysisId,botId,completedObservations:payload.ordinal,requestedObservations:session.requestedObservations})
                    this.store.cleanup(policy)
                }
            }else if(event.type==='bot.analysis.progress'){
                const next=Number.isSafeInteger(payload.nextRefreshAt)?payload.nextRefreshAt:null
                this.store.progress(session.analysisId,next)
                this.core.eventBus.publish('core.analysis.progress',{analysisId:session.analysisId,botId,completedObservations:session.completedObservations,requestedObservations:session.requestedObservations,nextRefreshAt:next})
            }else if(event.type==='bot.analysis.completed'){
                if(session.completedObservations!==session.requestedObservations) throw new Error('INCOMPLETE_ANALYSIS')
                this.finish(session,'completed','ANALYSIS_COMPLETED')
            }else if(event.type==='bot.analysis.failed'){
                const allowed=new Set(['AFK_INTERRUPTED','WINDOW_TIMEOUT','REFRESH_TIMEOUT','UNEXPECTED_WINDOW','WINDOW_CLOSED','WINDOW_BUSY','DISCONNECTED','CANCELLED','AUCTION_ACTION_FAILED','INVALID_ANALYSIS_TASK','INVALID_ANALYSIS_TIMING'])
                this.finish(session,['AFK_INTERRUPTED','CANCELLED'].includes(payload.code)?'cancelled':'failed',allowed.has(payload.code)?payload.code:'ANALYSIS_EXECUTION_FAILED')
            }
        }catch(error){
            this.core.logger.warn('Analysis result rejected',{analysisId:session.analysisId,code:error.message})
            this.finish(session,'failed','INVALID_ANALYSIS_RESULT')
        }
        return true
    }
    async reconcile({policy,actual,overrides,inputRevision,admission=null,maxDispatch=Infinity,maxCandidates=Infinity,canContinue=()=>true}){
        this.assessment=[]
        const now=Date.now(),items=this.store.items(),market=this.store.snapshot(policy,now)
        if(policy.autoAnalysis && actual.bots.some(b=>b.role==='analyst' && !b.manualHold && (b.configurationStale || b.analysisState==='unavailable'))){
            this.assessment.push(reason('ANALYST_NOT_READY','Очікування входу Analyst у realm або застосування його конфігурації.'))
        }
        const managed=actual.bots.filter(b=>b.role==='analyst' && !b.manualHold && !b.configurationStale).sort((a,b)=>a.botId-b.botId).slice(0,policy.operations.roles.analyst.target)
        for(const session of this.store.sessions()){
            const bot=managed.find(b=>b.botId===session.botId),item=items.find(i=>i.itemId===session.itemId)
            const task=typeof session.task==='string'?JSON.parse(session.task):session.task
            if(!bot)this.core.workloads.runtimeFailure(session.botId,task.incarnationId)
            if(!policy.operations.automationActive || !policy.autoAnalysis || !this.core.workloads.current(session,bot) || bot.workerPid!==session.workerPid || bot.serverId!==session.serverId || bot.realm!==session.realm || inputRevision!==session.inputRevision || item?.searchQuery!==task.query || item?.matcher!==task.matcherJson){
                this.finish(session,'cancelled','ANALYSIS_CANCELLED')
            }else if(now>session.deadline) this.finish(session,'timed_out','ANALYSIS_TIMEOUT')
        }
        const priorities=[]
        let dispatched=0,considered=0,deferred=0
        const failures=[]
        for(const bot of managed.sort((a,b)=>(admission?.botTurns?.get(a.botId)??0)-(admission?.botTurns?.get(b.botId)??0)||a.botId-b.botId)){
            if(admission&&!admission.botIds.has(bot.botId))continue
            if(!await canContinue()){deferred++;break}
            if(this.core.workloads.eligible(bot)||!policy.operations.automationActive||!policy.autoAnalysis)continue
            if(considered>=maxCandidates){deferred++;continue}
            considered++
            try{
            const context={items,market,policy,overrides,actual,sessions:[...this.store.sessions(),...this.store.sessions(false)],serverId:bot.serverId,realm:bot.realm,now}
            const candidates=this.planner.rank(context)
            for(const candidate of candidates.slice(0,10)) if(!priorities.some(p=>p.itemId===candidate.itemId && p.serverId===bot.serverId && p.realm===bot.realm)) priorities.push(candidate)
            if(bot.analysisState!=='idle' || this.store.sessions().some(s=>s.botId===bot.botId)) continue
            if(dispatched>=maxDispatch){deferred++;continue}
            const task=this.planner.getNextAnalysisTask(context)
            if(!task){
                if(!this.assessment.some(r=>r.code==='ANALYSIS_WAITING')) this.assessment.push(reason('ANALYSIS_WAITING',candidates.length?'Товари вже в аналізі або чекають паузи перед повтором.':'Немає дозволених товарів із коректним search query.',
                    {serverId:bot.serverId,realm:bot.realm,nextEligibleAt:candidates.reduce((next,c)=>c.retryAt>now?Math.min(next ?? c.retryAt,c.retryAt):next,null)}))
                continue
            }
            task.matcherJson=items.find(i=>i.itemId===task.itemId).matcher
            task.incarnationId=bot.incarnationId
            task.lifecycleEpoch=this.core.workloads.epoch(bot.botId)
            task.workloadGeneration=bot.workload?.generation??null
            const decisionId=randomUUID()
            this.store.createSession({bot,task,decisionId,inputRevision,policy,now})
            this.core.record({decisionId,actionId:task.analysisId,timestamp:now,trigger:{type:'ANALYSIS_SELECTED',source:'core',details:{serverId:bot.serverId,realm:bot.realm}},
                action:'analysis',target:{botId:bot.botId,itemId:task.itemId},before:{state:'idle'},after:{analysisId:task.analysisId,observationCount:task.observationCount,priority:task.priority},
                reasons:[reason('ANALYSIS_SELECTED','Core обрав наступний товар для спостереження.'),...task.reasons],constraintsApplied:[{code:'SAFE_REFRESH_INTERVAL',minimumMs:task.timing.minimumRefreshIntervalMs}],alternatives:task.alternatives,result:'applying'})
            dispatched++
            const sent=this.core.workloads.dispatch(bot.botId,task)
            if(!sent.accepted){this.finish(this.store.session(task.analysisId),'failed',sent.reason??'ANALYST_UNAVAILABLE');continue}
            this.core.eventBus.publish('core.analysis.started',{analysisId:task.analysisId,botId:bot.botId,itemId:task.itemId,requestedObservations:task.observationCount})
            }catch{
                failures.push({stage:'SETTLE_WAIT',code:'ANALYSIS_DISPATCH_FAILED',botId:bot.botId})
                for(const session of this.store.sessions().filter(s=>s.botId===bot.botId))this.finish(session,'failed','ANALYSIS_EXECUTION_FAILED')
                this.core.logger.warn('ANALYSIS_DISPATCH_FAILED',{botId:bot.botId})
            }
        }
        this.priorities=priorities
        // Age is updated on each reconciliation; events carry only bounded candidate summaries.
        const signature=JSON.stringify(priorities.map(p=>[p.itemId,p.serverId,p.realm,Math.floor(p.priority),p.eligible]))
        if(signature!==this.lastPlannerSignature){this.lastPlannerSignature=signature;this.core.eventBus.publish('core.analysisPlanner.updated',{candidates:priorities.slice(0,30).map(({matcher,matcherJson,query,...p})=>p)})}
        this.store.cleanup(policy,now)
        return {dispatched,considered,deferred,failures}
    }
    snapshot(actual,policy){
        const items=this.store.items(),market=this.store.snapshot(policy)
        const scopes=[...new Map(actual.bots.filter(b=>b.targetConfigured).map(b=>[`${b.serverId}:${b.realm}`,{serverId:b.serverId,realm:b.realm}])).values()]
        for(const scope of scopes) for(const item of items) if(!market.items.some(m=>m.itemId===item.itemId && m.serverId===scope.serverId && m.realm===scope.realm)) market.items.push({...scope,itemId:item.itemId,lastObservedAt:null,dataAgeMs:null,freshness:'unavailable',confidence:0,observationCount:0,independentLotCount:0,ownLotCount:0,excludedHighOutlierCount:0,independentSupply:0,ownSupply:0,medianPricePerItem:null,volatility:null})
        market.items=market.items.map(m=>({...m,name:items.find(i=>i.itemId===m.itemId)?.name ?? String(m.itemId)}))
        return {market,analysis:{activeSessions:this.store.sessions().map(({task,...s})=>s),analysts:actual.bots.filter(b=>b.activeTask.type==='analyst').map(b=>({botId:b.botId,serverId:b.serverId,realm:b.realm,state:b.analysisState,manualHold:b.manualHold})),
            priorities:this.priorities.slice(0,30).map(({matcher,query,...p})=>p)},auctionConstraints}
    }
    stop(){for(const session of this.store.sessions()) this.finish(session,'cancelled','CORE_STOPPED')}
    cancelForUser({botId,itemId}){
        for(const session of this.store.sessions()) if(session.botId===botId || session.itemId===itemId) this.finish(session,'cancelled','USER_CANCELLED_ANALYSIS')
    }
}
