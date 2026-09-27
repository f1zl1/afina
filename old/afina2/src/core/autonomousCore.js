import { createHash, randomUUID } from "node:crypto"
import AccountReplacements from './accountReplacements.js'
import CoreStore from "./coreStore.js"
import CoreActualState from "./coreActualState.js"
import CoreObserver from "./coreObserver.js"
import ActionCoordinator from "./actionCoordinator.js"
import CycleScheduler from "./cycleScheduler.js"
import LifecycleArbiter from './lifecycleArbiter.js'
import {semanticFactEvents} from '../minecraftBot/worker/workerFacts.js'
import CoreDecisionEngine from "./coreDecisionEngine.js"
import CoreReconciler from "./coreReconciler.js"
import { foundationEngines } from "./economicContracts.js"
import { policyFields,overrideFields,reason } from "./corePolicy.js"
import {effectiveOperationsPolicy,operationsHelp} from './operationsPolicy.js'
import {coreCapabilities,policySettingMetadata,legacyOperationalFields} from './coreCapabilities.js'
import MarketStore from './market/marketStore.js'
import MarketModel from './market/marketModel.js'
import AnalysisPlanner from './market/analysisPlanner.js'
import AnalysisCoordinator from './market/analysisCoordinator.js'
import WorkloadCoordinator from './workloadCoordinator.js'
import EconomicCoordinator from './economicCoordinator.js'
import LiveValidation from './liveValidation.js'
import TradingExecutionCoordinator from './tradingExecutionCoordinator.js'
import TradingPlanner from './tradingPlanner.js'
import ProxyStore from '../resources/proxyStore.js'

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex")
const triggers=new Set(["system.database.changed","system.bots.changed","system.worker.started","system.worker.exited","bot.status.changed",
    "bot.supervisor.status.changed","bot.desired.state.changed","bot.disconnected","task.state.changed","market.updated","core.market.updated","analysis.completed"])
const safeFailure=new Set(["STALE_REVISION","TASK_CHANGED_BY_USER","USER_BOT_HOLD","SAFE_TRANSITION_UNAVAILABLE","BOT_START_REJECTED"])
export default class AutonomousCore{
    constructor({dataBaseManager,botManager,snapshotStore,configurationService,eventBus,logger,executeCommand,accountPool,engines=null,observationOptions={}}){
        Object.assign(this,{eventBus,botManager,engines})
        this.logger=logger.child("AutonomousCore")
        this.store=new CoreStore(dataBaseManager.store)
        this.marketStore=new MarketStore(dataBaseManager.store)
        this.trading=new TradingPlanner(dataBaseManager.store)
        this.engines=engines ?? {...foundationEngines(),market:new MarketModel({store:this.marketStore,policy:()=>this.store.runtimeSettings()}),analysis:new AnalysisPlanner()}
        this.analysis=new AnalysisCoordinator({core:this,store:this.marketStore,planner:this.engines.analysis})
        this.observer=new CoreObserver({store:dataBaseManager.store,botManager,accountPool,logger:this.logger,options:observationOptions})
        this.projection=new CoreActualState()
        this.engine=new CoreDecisionEngine()
        this.accountGeneration={available:typeof executeCommand==='function',pending:0,state:'idle',lastRequestedAt:null,lastCreatedAt:null,lastFailedAt:null,lastError:null,retryAt:null}
        this.reconciler=new CoreReconciler({store:this.store,botManager,configurationService,executeCommand,accountGeneration:this.accountGeneration})
        this.replacements=new AccountReplacements({core:this,dataBaseManager,executeCommand,accountPool})
        this.reconciler.replacements=this.replacements
        this.actions=new ActionCoordinator(this)
        this.proxies=new ProxyStore({store:dataBaseManager.store,capacity:()=>this.store.operationsPolicy().maximumBotsPerProxy??4})
        this.reconciler.actions=this.actions
        this.lifecycle=typeof botManager.installLifecycle==='function'?new LifecycleArbiter(this):null
        this.reconciler.lifecycle=this.lifecycle
        this.workloads=new WorkloadCoordinator({requireEvidence:Boolean(this.lifecycle),actual:()=>this.readActual(),actions:()=>this.actions.ledger.active(),epoch:id=>this.lifecycle?.state.get(id)?.epoch??0,
            sessions:()=>this.marketStore.sessions(),send:(id,event,payload)=>this.botManager.getBot(id)?.sendEvent?.(event,payload),requestRecovery:(...args)=>this.lifecycle?.request(...args)??false})
        this.economic=new EconomicCoordinator(this)
        this.tradingExecution=new TradingExecutionCoordinator(this)
        this.liveValidation=new LiveValidation(this)
        this.state={status:"starting",lastEvaluationAt:null,lastDecisionAt:null,pendingActions:0,blockedActions:0,warnings:[]}
        this.scheduler=new CycleScheduler();this.lastCycle=null;this.activeCycle=null;this.triggerCount=0
        this.generation=0;this.triggerQueue=new Map();this.lastPlans=new Map();this.stopped=false
        this.scheduleTimer=null;this.startedWithKeepStopped=false
        this.listener=event=>{
            if(this.botManager.isCurrentWorkerEvent?.(event)===false)return
            if(event.type==='bot.runtime.incident' && event.payload.type==='ACCOUNT_BANNED'){
                const p=event.payload
                this.record({action:'ACCOUNT_BANNED',target:{botId:event.source.botId},before:{role:p.previousRole ?? null,assignment:p.previousAssignment ?? null},
                    after:{accountId:p.accountId ?? event.source.accountId,banId:p.banId},result:'applied',trigger:{type:'ACCOUNT_BANNED',source:'runtime'},
                    reasons:[reason('ACCOUNT_BANNED','Акаунт заблоковано сервером.')],constraintsApplied:[],alternatives:[]})
            }
            if(this.economic.handle(event)||this.analysis.handle(event)) return
            if(!triggers.has(event.type) && !semanticFactEvents.has(event.type)) return
            // No raw event payloads or chat text enter the decision journal.
            this.schedule({type:event.type,source:event.source?.kind ?? "system",details:{botId:event.source?.botId ?? null}})
        }
    }
    readActual(){return this.projection.read(this.observer.snapshot({policyRevision:this.store.operationsPolicy().revision,controls:this.store.control(),generation:this.accountGeneration}))}
    capabilities(){return coreCapabilities({analystAvailable:this.engines.analysis.available===true,generatorAvailable:this.accountGeneration.available,foundation:!this.engines.analysis.available,lifecycleAvailable:Boolean(this.lifecycle),autonomousTradingEnabled:this.store.operationsPolicy().autonomousTradingEnabled})}
    effectiveOperations(at=new Date()){return effectiveOperationsPolicy(this.store.operationsPolicy(),at,{keepStopped:this.startedWithKeepStopped,capabilities:this.capabilities()})}
    runtimePolicy(){return {...this.store.runtimeSettings(),operations:this.effectiveOperations()}}
    async start(){
        this.proxies.reconcile()
        const report=this.store.canonicalization()
        this.logger.info('CORE_POLICY_CANONICALIZED',{revision:this.store.operationsPolicy().revision,source:report.source,conflicts:report.diagnostics.length})
        for(const diagnostic of report.diagnostics)this.logger.warn('CORE_POLICY_CONFLICT',diagnostic)
        this.analysis.restore()
        this.economic.restore()
        this.eventBus.onAny(this.listener)
        const known=new Set(this.store.control().map(c=>c.botId))
        const actual=this.readActual()
        this.store.store.transaction(()=>{
            for(const bot of actual.bots) if(!known.has(bot.botId) && bot.task.type === "reseller") this.store.setControl(bot.botId,{lastAssignmentAt:Date.now()})
        })
        this.startedWithKeepStopped=this.store.operationsPolicy().startupPolicy==='keepStopped'
        await this.evaluateNow({type:"CORE_STARTED",source:"system",details:{}})
        if(this.stopped)return
        this.safetyTimer=setInterval(()=>{
            const policy=this.store.runtimeSettings()
            if(Date.now()-(this.observer.lastAuthoritativeAt ?? 0)>=policy.safetyIntervalMs) this.schedule({type:"SAFETY_RECONCILIATION",source:"system",details:{}})
        },10000)
        this.safetyTimer.unref?.()
    }
    status(status,extra={}){
        this.state={...this.state,status,...extra}
        this.eventBus.publish("core.status.updated",this.state)
    }
    queueTrigger(trigger){
        if(this.stopped)return
        this.triggerCount++
        const critical=['CORE_STARTED','SAFETY_RECONCILIATION','OPERATIONS_POLICY_UPDATED','USER_POLICY_UPDATED','CORE_CONTINUATION']
        if(this.triggerQueue.size<20||this.triggerQueue.has(trigger.type)||critical.includes(trigger.type))this.triggerQueue.set(trigger.type,trigger)
        else this.triggerQueue.set('CORE_EVENTS_COALESCED',{type:'CORE_EVENTS_COALESCED',source:'scheduler',force:true})
    }
    armDrain(delay=this.store.runtimeSettings().decisionDebounceMs){
        if(this.stopped||this.debounce||this.running)return
        this.debounce=setTimeout(()=>{this.debounce=null;void this.drain()},delay);this.debounce.unref?.()
    }
    schedule(trigger){this.queueTrigger(trigger);this.armDrain()}
    async evaluateNow(trigger={type:'MANUAL_EVALUATION',source:'system',details:{}}){
        if(this.stopped)return
        this.queueTrigger(trigger);clearTimeout(this.debounce);this.debounce=null;return this.drain()
    }
    drain(){
        if(this.running||this.stopped)return this.running
        const limits=this.store.operationsPolicy().controller
        this.running=(async()=>{
            for(let pass=0;pass<limits.maxPassesPerDrain&&this.triggerQueue.size&&!this.stopped;pass++){
                if(pass>0&&[...this.triggerQueue.keys()].every(k=>k==='CORE_CONTINUATION'))break
                const batch=[...this.triggerQueue.values()];this.triggerQueue.clear()
                try{await this.cycle(batch)}catch{
                    this.logger.error('Core evaluation failed',{cycleId:this.lastCycle?.cycleId})
                    this.status('error',{warnings:[reason('CORE_EVALUATION_FAILED','Core evaluation failed; pending triggers are retained.')]})
                    break
                }
                if(this.triggerQueue.size)await new Promise(resolve=>setImmediate(resolve))
            }
        })().finally(()=>{this.running=null;if(this.triggerQueue.size)this.armDrain(limits.continuationDelayMs)})
        return this.running
    }
    async cycle(batch){
        if(batch.some(t=>t.type==='CORE_STARTED'))this.recoveryPending=true
        const context=this.scheduler.begin(this.store.operationsPolicy().controller,batch)
        this.activeCycle=context.summary
        try{await this.runCycle(batch,context)}catch(error){context.summary.outcome='failed';context.summary.failures.push({stage:context.summary.stage,code:'CORE_EVALUATION_FAILED'});throw error}
        finally{
            if(this.stopped)context.summary.outcome='cancelled'
            else if(context.remaining()===0&&!['failed','superseded'].includes(context.summary.outcome)){
                context.summary.budgetReason='CYCLE_TIME_BUDGET';context.summary.outcome='deferred'
            }
            if(!this.stopped&&context.summary.outcome!=='failed'&&this.scheduler.continuation(context.summary,context.unvisited??0)){
                context.summary.continuationRequested=true;this.queueTrigger({type:'CORE_CONTINUATION',source:'scheduler'})
            }
            context.summary.anotherCycleRequested=this.triggerQueue.size>0
            this.lastCycle=context.finish();this.activeCycle=null
            if(!this.stopped){this.logger.info('CORE_CYCLE_COMPLETED',this.lastCycle);this.eventBus.publish('core.cycle.completed',this.lastCycle)}
        }
    }
    record(value,updated=false){
        const record=this.store.decision(value)
        this.state.lastDecisionAt=record.updatedAt ?? record.timestamp
        this.eventBus.publish(updated ? "core.decision.updated" : "core.decision.created",record)
        return record
    }
    async runCycle(batch,context){
        const token=this.generation
        const operations=this.store.operationsPolicy(),effectiveOperations=this.effectiveOperations()
        const policy={...this.store.runtimeSettings(),operations:effectiveOperations}
        const overrides=this.store.overrides(),inputRevision=this.store.revision()
        Object.assign(context.summary,{policyRevision:operations.revision,inputRevision,triggerCount:this.triggerCount});this.triggerCount=0
        const checkpoint=async stage=>{
            if(!await context.checkpoint(stage))return false
            if(this.stopped||this.generation!==token||this.store.revision()!==inputRevision){context.summary.outcome='superseded';if(!this.stopped)this.queueTrigger({type:'INPUTS_CHANGED',source:'scheduler'});return false}
            return true
        }
        if(this.stopped)return
        await this.observer.refresh({force:batch.some(t=>t.force||['CORE_STARTED','SAFETY_RECONCILIATION'].includes(t.type)),budgetMs:context.remaining(),reason:batch.map(t=>t.type).join(',')})
        if(!await checkpoint('ACCOUNT'))return
        this.armScheduleWakeup(effectiveOperations.nextTransition)
        const trigger=batch.find(t=>["USER_POLICY_UPDATED","USER_OVERRIDE_UPDATED","USER_OVERRIDE_DELETED"].includes(t.type)) ?? batch[0]
        const combined={...trigger,coalescedTypes:batch.map(t=>t.type)}
        this.status(policy.operations.automationActive ? "evaluating" : "disabled",{activity:{phase:"evaluating",trigger:combined}})
        let actual=this.readActual()
        this.lifecycle?.account(actual,this.recoveryPending===true)
        this.proxies.reconcile()
        this.actions.reconcile(actual,this.recoveryPending===true)
        this.recoveryPending=false
        this.replacements.settle({policy,actual})
        actual=this.readActual()
        Object.assign(context.summary,{observationAt:actual.observedAt,dataRevision:actual.dataRevision})
        if(!await checkpoint('PLAN'))return
        this.tradingSnapshot(policy)
        const computed=this.engine.evaluate({policy,overrides,actual,engines:this.engines})
        const previous=this.store.desired()
        const body={inputRevision,...computed}
        let desired=previous
        if(!previous || hash({...previous,revision:undefined,generatedAt:undefined})!==hash(body)){
            desired={...body,revision:(previous?.revision ?? 0)+1,generatedAt:Date.now()}
            this.store.saveDesired(desired)
            this.eventBus.publish("core.desiredState.updated",{revision:desired.revision,generatedAt:desired.generatedAt,roles:desired.roles})
        }
        actual.accounting=this.actions.accounting(actual,desired)
        const admission=this.scheduler.window(actual,operations.controller.maxCandidatesPerCycle,batch,operations.controller.maxActionsPerCycle)
        context.unvisited=admission.unvisited
        const actions=this.reconciler.plan({policy,desired,actual,operations:effectiveOperations,accountGeneration:this.accountGeneration,overrides,admission})
        if(!await checkpoint('SELECT'))return
        this.economic.reconcile()
        this.tradingExecution.evaluate(this.tradingSnapshot(policy).plans,admission,operations.controller.maxActionsPerCycle)
        const workloadCandidates=[...(this.engines.analysis.available?this.analysis.admissionCandidates({policy,actual,admission}):[]),...this.economic.candidates(actual,admission)]
        const selection=this.scheduler.select([...actions,...workloadCandidates],operations.controller,effectiveOperations)
        const workloadSelection=selection.selected.filter(a=>a.action==='analysis_workload')
        const economicSelection=selection.selected.filter(a=>a.action==='economic_workload')
        const operationalSelection=selection.selected.filter(a=>!['analysis_workload','economic_workload'].includes(a.action))
        Object.assign(context.summary,{candidatesConsidered:selection.considered,candidatesProduced:actions.length+workloadCandidates.length,selected:operationalSelection.length,workloadSelected:workloadSelection.length,deferred:selection.deferred,blocked:selection.blocked,unvisited:admission.unvisited})
        if(selection.deferred)context.summary.budgetReason=operations.controller.maxCandidatesPerCycle<operations.controller.maxActionsPerCycle?'CANDIDATE_LIMIT':'ACTION_LIMIT'
        else if(admission.unvisited)context.summary.budgetReason='CANDIDATE_LIMIT'
        for(const action of actions)for(const r of action.reasons??[])if(r.code==='PLAN_COMPONENT_FAILED')context.summary.failures.push({stage:'PLAN',code:r.code,component:r.data?.component})
        const currentPlans=new Map()
        const attempted=new Set()
        this.status(policy.operations.automationActive ? "reconciling" : "disabled",{activity:{phase:"reconciling",trigger:combined},pendingActions:actions.filter(a=>a.result === "planned").length})
        for(const action of [...operationalSelection,...selection.diagnostics]){
            if(!await checkpoint('RESERVE')){context.summary.deferred+=operationalSelection.filter(a=>!attempted.has(a)).length;break}
            attempted.add(action)
            if(this.stopped || this.generation!==token || this.store.revision()!==inputRevision) break
            const signature=hash(action)
            const oldId=this.lastPlans.get(signature)
            currentPlans.set(signature,oldId)
            if(oldId&&action.result!=='planned') continue
            let record=this.record({...action,trigger:combined,desiredRevision:desired.revision,actionId:action.result === "planned" ? randomUUID() : null})
            currentPlans.set(signature,record.decisionId)
            if(action.result !== "planned" || !(policy.operations.automationActive||action.action==='continue_binding'||action.action==='stop_bot'&&policy.operations.permissions.mayStopManaged)) continue
            try{
                const reserved=this.actions.reserve(action,{desired,decisionId:record.decisionId})
                if(!reserved.reused)context.summary.reserved++
                context.summary.stage='DISPATCH'
                record=this.record({...record,actionId:reserved.action.actionId,result:'applying'},true)
                if(!reserved.reused||reserved.continuation)await this.actions.dispatch(reserved.action,action,{
                    valid:()=>action.action==='continue_binding'?!this.stopped&&this.lifecycle.valid(reserved.action.actionId):!this.stopped&&this.generation===token&&this.store.revision()===inputRevision&&(action.action==='stop_bot'?this.effectiveOperations().permissions.mayStopManaged:this.effectiveOperations().automationActive),
                    onAssigned:()=>this.store.setControl(action.target.botId,{lastAssignmentAt:Date.now(),lastSwitchAt:action.before.itemId!==action.after.itemId?Date.now():actual.bots.find(b=>b.botId===action.target.botId)?.lastSwitchAt??null,pendingDecisionId:record.decisionId,pendingActionId:reserved.action.actionId,pendingSince:Date.now(),pendingAfter:JSON.stringify(action.after),failedUntil:null})
                })
                if(!reserved.reused||reserved.continuation)context.summary.dispatched++
            }catch(error){
                context.summary.conflicts+=Number(error.message==='ACTIVE_CONFLICTING_ACTION');context.summary.failures.push({stage:'RESERVE_DISPATCH',code:error.message==='ACTIVE_CONFLICTING_ACTION'?error.message:'ACTION_RESERVATION_FAILED',botId:action.target.botId})
                this.record({...record,result:'blocked',reasons:[...record.reasons,reason(error.message==='ACTIVE_CONFLICTING_ACTION'?error.message:'ACTION_RESERVATION_FAILED','Action reservation unavailable.')]},true)
            }
        }

        this.lastPlans=currentPlans
        if(!await checkpoint('SETTLE_WAIT'))return
        actual=this.readActual()
        this.actions.reconcile(actual)
        actual=this.readActual()
        actual.accounting=this.actions.accounting(actual,desired)
        let economicDispatched=0
        for(const candidate of economicSelection){
            if(!await checkpoint('SETTLE_WAIT')||this.stopped||this.generation!==token)break
            if(this.economic.dispatch(candidate))economicDispatched++
        }
        context.summary.economicDispatched=economicDispatched
        context.summary.workloadDispatched=economicDispatched
        if(this.engines.analysis.available && this.generation===token){
            const workload=await this.analysis.reconcile({policy,actual,overrides,inputRevision,admission:{...admission,botIds:new Set(workloadSelection.map(a=>a.target.botId))},maxDispatch:Math.min(workloadSelection.length,Math.max(0,operations.controller.maxActionsPerCycle-context.summary.dispatched)),maxCandidates:workloadSelection.length,canContinue:async()=>await checkpoint('SETTLE_WAIT')&&!this.stopped&&this.generation===token&&this.store.revision()===inputRevision})
            context.summary.workloadDispatched=(workload?.dispatched??0)+economicDispatched
            context.summary.workloadCandidatesConsidered=workload?.considered??0
            context.summary.deferred+=workload?.deferred??0
            context.summary.failures.push(...(workload?.failures??[]))
        }
        const pending=this.actions.ledger.active().length
        const analysisPending=this.marketStore.sessions().length
        const blocked=actions.filter(a=>a.result === "blocked").length
        const capabilityBlockers=Object.entries(effectiveOperations.roles).filter(([,r])=>r.target>0&&!r.executable).map(([role,r])=>reason(r.blocker,'Можливість автономного виконання ролі недоступна.',{role,target:r.target}))
        // Foundation fixtures retain their old execution contract; production has
        // an available Analyst and must always report the Reseller safety blocker.
        const activeCapabilityBlockers=capabilityBlockers.filter(r=>r.data.role!=='reseller'||this.engines.analysis.available)
        const observationBlockers=actual.bots.filter(b=>b.running&&!b.workReady).map(b=>reason(b.uncertain?'WORKER_FACTS_UNAVAILABLE':'WORKER_NOT_READY','Процес не підтверджує готовність до роботи.',{botId:b.botId,quality:b.observationQuality,blocker:b.blocker}))
        const assessment=[...computed.assessments,...this.analysis.assessment,...activeCapabilityBlockers,...observationBlockers]
        const failures=this.store.control().filter(c=>c.failedUntil>Date.now())
        if(failures.length) assessment.push(reason("FAILURE_BACKOFF","Після невдалих дій діє пауза перед повтором.",{botIds:failures.map(c=>c.botId)}))
        if(!policy.operations.automationActive) assessment.unshift(reason("CORE_DISABLED","Ядро вимкнено: спостерігає за системою, але не виконує автономних змін."))
        if(policy.operations.roles.analyst.target>0 && !policy.autoAnalysis) assessment.push(reason('AUTO_ANALYSIS_DISABLED','Analyst очікує: автоматичний аналіз вимкнено.'))
        const deficit=Math.max(0,desired.roles.reseller-actual.roles.reseller)
        if(desired.roles.analyst>actual.roles.analyst) assessment.push(reason('ANALYST_DEFICIT','Очікування Analyst для заданої цілі.',{deficit:desired.roles.analyst-actual.roles.analyst}))
        if(deficit) assessment.push(reason("RESELLER_DEFICIT",`До цілі reseller бракує ${deficit}.`,{desired:desired.roles.reseller,actual:actual.roles.reseller,deficit}))
        for(const action of actions.filter(a=>a.result === "blocked")){
            const last=action.reasons.at(-1)
            if(!assessment.some(r=>r.code===last.code)) assessment.push(last)
        }
        if(!assessment.length && !pending && !blocked) assessment.push(reason(analysisPending?'ANALYSIS_RUNNING':'DESIRED_MATCHES_ACTUAL',analysisPending?'Analyst збирає ринкові спостереження.':'Desired state відповідає actual state.'))
        const diagnosticRoles={}
        for(const id of Object.keys(operations.roles)){
            const configured=operations.roles[id],effective={...effectiveOperations.roles[id]}
            if(effectiveOperations.maintenanceMode)Object.assign(effective,{enabled:false,minimum:0,target:0,maximum:0,reason:'MAINTENANCE_MODE'})
            const roleBots=actual.bots.filter(b=>b.activeTask.type===id),actualCount=actual.roles[id]??0
            const starting=roleBots.filter(b=>!b.role&&(b.desiredState==='running'||b.supervisorStatus==='starting')).length
            const stopping=roleBots.filter(b=>b.supervisorStatus==='stopping'||(b.running&&b.desiredState==='stopped')).length
            const roleActions=actions.filter(a=>a.after?.type===id||a.before?.type===id||a.action.includes(id))
            const blockers=[...new Map([...roleActions.filter(a=>a.result==='blocked').flatMap(a=>a.reasons??[]),...activeCapabilityBlockers.filter(r=>r.data.role===id)].map(r=>[r.code,r])).values()]
            diagnosticRoles[id]={...actual.accounting.roles[id],configured,effective,desired:desired.roles[id]??0,actual:actualCount,starting,stopping,remainingStartDeficit:Math.max(0,(desired.roles[id]??0)-actualCount-starting),remainingStopExcess:Math.max(0,actualCount-(desired.roles[id]??0)-stopping),blockers}
        }
        const generationAction=actions.find(a=>a.action==='generate_accounts')
        const accountGeneration={...this.accountGeneration,...(generationAction?.before??{desiredRunning:Object.values(desired.roles).reduce((s,v)=>s+v,0),running:Object.values(actual.roles).reduce((s,v)=>s+v,0),starting:0,eligibleReadyAccounts:actual.accounts.available,pendingAccountCreations:actual.accounting.accounts.pendingGeneration,workCapacityDeficit:0,reserveDeficit:Math.max(0,effectiveOperations.reserve.targetReadyAccounts-actual.accounts.available),uncoveredAccountDeficit:0,totalAccounts:actual.accounts.total,maximumTotalAccounts:effectiveOperations.reserve.maximumTotalAccounts,maximumPendingAccountGeneration:effectiveOperations.reserve.maximumPendingAccountGeneration}),pending:actual.accounting.accounts.pendingGeneration,requested:generationAction?.after?.requested??0,status:generationAction?.result??'idle',blocker:generationAction?.result==='blocked'?generationAction.reasons.at(-1)?.code??null:null}
        const drift=Object.entries(desired.roles).some(([role,count])=>count!==(actual.roles[role]??0))
        const converging=drift&&pending>0&&!blocked&&!failures.length&&Object.values(actual.accounting.roles).every(r=>r.uncovered===0)
        const assessmentStatus=!effectiveOperations.automationActive?'disabled':converging?'reconciling':blocked||drift||pending||failures.length||assessment.some(r=>!['DESIRED_MATCHES_ACTUAL','ANALYSIS_RUNNING'].includes(r.code))?'degraded':analysisPending?'observing':'stable'
        const reconciliation={policyRevision:operations.revision,inputRevision,desiredRevision:desired.revision,evaluatedAt:Date.now(),trigger:combined,status:assessmentStatus,roles:diagnosticRoles,accountGeneration,actions:actions.map(a=>({action:a.action,botId:a.target?.botId??null,role:a.after?.type??a.before?.type??null,result:a.result,reasons:a.reasons??[]})),nextAction:actions.find(a=>a.result==='planned')??null}
        this.current={policy,operations,effectiveOperations,overrides,desiredState:desired,actualState:actual,assessment,reconciliation}
        this.status(assessmentStatus,{
            activity:{phase:analysisPending?'analysing':pending ? "waiting_for_execution" : blocked ? "blocked" : "observing",trigger:combined},
            lastEvaluationAt:Date.now(),desiredResellers:desired.roles.reseller,actualResellers:actual.roles.reseller,
            desiredAnalysts:desired.roles.analyst,actualAnalysts:actual.roles.analyst,pendingActions:pending+analysisPending,blockedActions:blocked,warnings:assessment.filter(r=>!['DESIRED_MATCHES_ACTUAL','ANALYSIS_RUNNING'].includes(r.code))})
        this.logger.info("Core reconciliation completed",{desiredRevision:desired.revision,pending,blocked})
    }
    tradingSnapshot(policy=this.store.runtimeSettings()){
        const result=this.trading.evaluate({items:this.marketStore.items(),market:this.marketStore.snapshot(policy),overrides:this.store.overrides(),policy})
        clearTimeout(this.tradingExpiryTimer)
        const next=Math.min(...result.plans.map(p=>p.expiresAt).filter(at=>at>Date.now()))
        if(Number.isFinite(next)&&!this.stopped){
            this.tradingExpiryTimer=setTimeout(()=>this.schedule({type:'TRADING_PLAN_EXPIRED',source:'clock'}),Math.max(1,next-Date.now()))
            this.tradingExpiryTimer.unref?.()
        }
        return result
    }
    snapshot(){
        const policy=this.store.policy(),desired=this.store.desired(),actual=this.readActual()
        const operations=this.store.operationsPolicy(),effectiveOperations=this.effectiveOperations()
        const accountRows=actual.observation.accounts,ready=actual.accounts.available
        const transitionAccounting=this.actions.accounting(actual,desired??{roles:{}})
        const pendingGeneration=this.actions.pendingGeneration()
        const accountReserve={ready,target:operations.reserve.targetReadyAccounts,minimum:operations.reserve.minimumReadyAccounts,pendingGeneration,deficit:Math.max(0,operations.reserve.targetReadyAccounts-Math.max(0,ready+pendingGeneration-transitionAccounting.accounts.accountDemand)),total:accountRows.length}
        const metadata=policySettingMetadata(policyFields,overrideFields,operations),domains={runtime:{},market:{},controller:{},workload:{},infrastructure:{consumer:'BotManager / DatabaseStore / Telegram'}}
        for(const [key,value] of Object.entries(this.store.runtimeSettings()))domains[metadata.core[key]?.domain??'workload'][key]=value
        const assessmentPending=this.current?.operations.revision!==operations.revision
        const assessment=assessmentPending?[reason('CORE_POLICY_PENDING','Нова версія політики очікує оцінювання.')]:this.current.assessment
        const observationDrift=actual.bots.some(b=>b.running&&!b.workReady)||Object.entries(desired?.roles??{}).some(([role,count])=>count!==(actual.roles[role]??0))
        const observedStatus=this.state.status==='stable'&&observationDrift?'degraded':this.state.status
        return {status:{...this.state,actualResellers:actual.roles.reseller,actualAnalysts:actual.roles.analyst,status:effectiveOperations.automationActive ? assessmentPending?'evaluating':observedStatus : "disabled"},policy,operationsPolicy:operations,effectiveOperationsPolicy:effectiveOperations,accountReserve,overrides:this.store.overrides(),inputRevision:this.store.revision(),
            assessmentPending,assessmentPolicyRevision:this.current?.operations.revision??null,
            accountReplacements:this.replacements.rows(),reconciliation:this.current?.reconciliation??null,
            cycle:this.lastCycle,activeCycle:this.activeCycle,
            lifecycle:this.lifecycle?.snapshot(actual)??[],proxyResources:this.proxies.snapshot(),
            activeActions:this.actions.ledger.active(),recentActions:this.actions.ledger.recent(),transitionAccounting,
            desiredState:desired,actualState:actual,observation:actual.observation,observationCounts:actual.counts,workloads:this.workloads.snapshot(actual),economic:this.economic.snapshot(),trading:this.tradingExecution.snapshot(this.tradingSnapshot()),assessment,recentDecisions:this.store.decisions(),...this.analysis.snapshot(actual,{...this.store.runtimeSettings(),operations:effectiveOperations}),
            allocations:actual.items.map(item=>{
                const wanted=desired?.allocations.find(a=>a.itemId===item.itemId)?.desiredBots ?? 0
                const count=actual.allocations.find(a=>a.itemId===item.itemId)?.actualBots ?? 0
                return {...item,desiredBots:wanted,actualBots:count,deficit:Math.max(0,wanted-count),excess:Math.max(0,count-wanted),status:wanted===count ? "stable" : wanted>count ? "deficit" : "excess"}
            }),fields:{policy:policyFields,override:overrideFields,operationsHelp},capabilities:this.capabilities(),
            canonicalRevision:operations.revision,configuredPolicy:operations,policyMetadata:metadata,canonicalization:this.store.canonicalization(),
            domains,automation:{enabled:operations.automationEnabled,active:effectiveOperations.automationActive,maintenance:operations.maintenanceMode,keepStopped:this.startedWithKeepStopped},
            capabilityBlockers:Object.entries(effectiveOperations.roles).filter(([,r])=>r.target>0&&!r.executable).map(([role,r])=>({role,code:r.blocker,target:r.target}))}
    }
    updateOperationsPolicy({values,expectedRevision}){
        const before=this.store.operationsPolicy(),after=this.store.updateOperationsPolicy(values,expectedRevision)
        this.startedWithKeepStopped=false;this.generation++;clearTimeout(this.scheduleTimer)
        this.record({trigger:{type:'OPERATIONS_POLICY_UPDATED',source:'user',details:{fields:Object.keys(values)}},action:'operations.policy.update',target:{botId:null,itemId:null},before,after,reasons:[reason('OPERATIONS_POLICY_UPDATED','Операційну політику змінено.')],constraintsApplied:[],alternatives:[],result:'applied'})
        this.eventBus.publish('core.operations.updated',{policy:after,inputRevision:this.store.revision()})
        this.schedule({type:'OPERATIONS_POLICY_UPDATED',source:'user',details:{fields:Object.keys(values)}});return {policy:after,operationsPolicy:this.store.operationsPolicy(),canonicalRevision:this.store.operationsPolicy().revision,inputRevision:this.store.revision()}
    }
    armScheduleWakeup(next){clearTimeout(this.scheduleTimer);if(!next||this.stopped)return;const generation=this.generation,delay=Math.max(0,next.at-Date.now()+50);this.scheduleTimer=setTimeout(()=>{if(!this.stopped&&generation===this.generation)this.schedule({type:'SCHEDULE_TRANSITION',source:'clock',details:{at:next.at}})},delay);this.scheduleTimer.unref?.()}
    updatePolicy({values,expectedRevision}){
        const before=this.store.policy(),after=this.store.updatePolicy(values,expectedRevision)
        if(Object.keys(values).some(key=>Object.hasOwn(legacyOperationalFields,key))){
            this.logger.info('CORE_LEGACY_POLICY_ADAPTER_USED',{fields:Object.keys(values).filter(key=>Object.hasOwn(legacyOperationalFields,key)),revision:this.store.operationsPolicy().revision})
        }
        if(Object.keys(values).some(key=>key.startsWith('antiAfk'))){
            for(const row of this.store.store.prepare('SELECT botId FROM botData WHERE archived=0').all()){
                this.botManager.getBot(row.botId)?.sendEvent?.('runtime:configure',after)
            }
        }
        this.generation++
        this.record({trigger:{type:"USER_POLICY_UPDATED",source:"user",details:{fields:Object.keys(values)}},action:"policy.update",target:{botId:null,itemId:null},before:Object.fromEntries(Object.keys(values).map(k=>[k,before[k]])),after:values,
            reasons:[reason("USER_POLICY_UPDATED","Користувач змінив політику ядра.")],constraintsApplied:[],alternatives:[],result:"applied"})
        this.eventBus.publish("core.policy.updated",{policy:after,inputRevision:this.store.revision()})
        this.schedule({type:"USER_POLICY_UPDATED",source:"user",details:{fields:Object.keys(values)}})
        return {policy:after,operationsPolicy:this.store.operationsPolicy(),canonicalRevision:this.store.operationsPolicy().revision,inputRevision:this.store.revision()}
    }
    setOverride({itemId,values,expectedRevision}){
        const before=this.store.overrides().find(o=>o.itemId===itemId) ?? null
        const after=this.store.setOverride(itemId,values,expectedRevision)
        this.overrideChanged(itemId,before,after,"USER_OVERRIDE_UPDATED")
        return {override:after,inputRevision:this.store.revision()}
    }
    deleteOverride({itemId,expectedRevision}){
        const before=this.store.overrides().find(o=>o.itemId===itemId) ?? null
        this.store.deleteOverride(itemId,expectedRevision)
        this.overrideChanged(itemId,before,null,"USER_OVERRIDE_DELETED")
        return {itemId,inputRevision:this.store.revision()}
    }
    overrideChanged(itemId,before,after,type){
        this.generation++
        this.record({trigger:{type,source:"user",details:{itemId}},action:"override.update",target:{itemId,botId:null},before,after,reasons:[reason(type,"Користувач змінив override товару.")],constraintsApplied:[],alternatives:[],result:"applied"})
        this.eventBus.publish("core.override.updated",{itemId,override:after,inputRevision:this.store.revision()})
        this.schedule({type,source:"user",details:{itemId}})
    }
    userControlsBot(botId){
        this.economic.cancelBot(Number(botId))
        if(!Number.isSafeInteger(botId) || botId<1 || !this.botManager.hasBot(botId) || !this.store.store.prepare("SELECT 1 FROM botData WHERE botId=?").get(botId)) return
        const previous=Boolean(this.store.control().find(c=>c.botId===botId)?.manualHold)
        this.store.setControl(botId,{manualHold:true});this.generation++
        this.actions.ledger.cancelBot(botId)
        this.lifecycle?.manualHold(botId)
        this.analysis.cancelForUser({botId})
        if(!previous) this.recordControl(botId,false,true,"USER_BOT_CONTROL")
        this.schedule({type:"USER_BOT_CONTROL",source:"user",details:{botId}})
    }
    releaseBot({botId}){
        if(!Number.isSafeInteger(botId) || !this.botManager.hasBot(botId)) throw new Error("Unknown bot")
        const previous=Boolean(this.store.control().find(c=>c.botId===botId)?.manualHold)
        this.store.setControl(botId,{manualHold:false});this.generation++
        this.lifecycle?.release(botId)
        if(previous) this.recordControl(botId,true,false,"USER_BOT_RELEASED")
        this.schedule({type:"USER_BOT_RELEASED",source:"user",details:{botId}})
        return {botId,manualHold:false}
    }
    recordControl(botId,before,after,type){
        this.record({trigger:{type,source:"user",details:{botId}},action:"bot.control",target:{botId,itemId:null},
            before:{manualHold:before},after:{manualHold:after},reasons:[reason(type,after ? "Користувач взяв бота під ручне керування." : "Користувач повернув бота під керування ядра.")],constraintsApplied:[],alternatives:[],result:"applied"})
    }
    async stop(){if(this.stopped) return;this.economic.stop();this.stopped=true;this.lifecycle?.close();this.generation++;this.triggerQueue.clear();clearInterval(this.safetyTimer);clearTimeout(this.tradingExpiryTimer);clearTimeout(this.debounce);clearTimeout(this.scheduleTimer);this.eventBus.offAny(this.listener);this.observer.stop();this.actions.stop();this.analysis.stop();await this.running}
}
