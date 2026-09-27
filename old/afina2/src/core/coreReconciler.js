import { reason } from "./corePolicy.js"
import {accountGenerationAllowance} from './canonicalPolicy.js'
import {effectiveOperationsPolicy} from './operationsPolicy.js'

export default class CoreReconciler{
    constructor({store,botManager,configurationService,executeCommand,accountGeneration}){Object.assign(this,{store,botManager,configurationService,executeCommand,accountGeneration})}
    plan({policy,desired,actual,operations=null,accountGeneration=null,now=Date.now(),overrides=[],admission=null}){
        const failures=[]
        const safePlan=(component,fn)=>{try{return fn()}catch{failures.push({action:'plan',target:{botId:null,itemId:null},result:'blocked',reasons:[reason('PLAN_COMPONENT_FAILED','Не вдалося розрахувати частину плану.',{component})],constraintsApplied:[],alternatives:[]});return []}}
        const admitted=b=>!admission||admission.botIds.has(b.botId)
        const allocations=desired.allocations.filter(a=>!admission||admission.itemIds.has(a.itemId))
        const activeIds=new Set((actual.observation?.actions??[]).map(a=>a.botId))
        const lifecycleActions=safePlan('lifecycle',()=>this.lifecycle?.plan({actual,policy,admission,now})??[])
        const actions=[...lifecycleActions,...safePlan('replacement',()=>this.replacements?.plan({policy,desired,actual,now,overrides,admission})??[])].filter(a=>a.action==='continue_binding'||!activeIds.has(a.target.botId)),used=new Set(actions.map(a=>a.target.botId)),kept=new Set()
        for(const b of actual.bots)if(b.lifecycle?.intent==='running'&&b.lifecycle.requestReason)used.add(b.botId)
        const replacementIds=new Set(actions.filter(a=>a.action==='replace_account').map(a=>a.target.botId))
        const replacementBots=actual.bots.filter(b=>b.replacementPending || replacementIds.has(b.botId))
        if(actual.accounting&&lifecycleActions.length)actual={...actual,accounting:{...actual.accounting,roles:Object.fromEntries(Object.entries(actual.accounting.roles).map(([role,r])=>[role,{...r,uncovered:Math.max(0,r.uncovered-lifecycleActions.filter(a=>a.action==='recover_bot'&&a.result==='planned'&&a.after.type===role).length)}]))}}
        for(const bot of replacementBots)used.add(bot.botId)
        actual={...actual,bots:actual.bots.filter(b=>!b.banned && !b.operationalBlock && !used.has(b.botId)).map(b=>activeIds.has(b.botId)?{...b,pendingDecisionId:b.pendingDecisionId??'ACTION_IN_PROGRESS'}:b)}
        const occupied=actual.bots.flatMap(b=>{
            const action=actual.observation?.actions?.find(a=>a.botId===b.botId&&a.role==='reseller'&&['START','REPLACE'].includes(a.type))
            if(action)return [{...b,activeTask:{...b.activeTask,...action.metadata.expectedTask}}]
            return (b.running||b.desiredState==='running')&&b.activeTask.type==='reseller'&&b.activeTask.enabled===1?[b]:[]
        })
        const isOccupied=b=>occupied.some(v=>v.botId===b.botId)
        const desiredMap=new Map(desired.allocations.map(a=>[a.itemId,a]))
        const counts=new Map()
        for(const allocation of desired.allocations){
            const current=occupied.filter(b=>b.activeTask.itemId === allocation.itemId).sort((a,b)=>a.botId-b.botId)
            for(const bot of current.slice(0,allocation.desiredBots)) kept.add(bot.botId)
            const replacements=replacementBots.filter(b=>b.task.type==='reseller' && b.task.itemId===allocation.itemId).length
            counts.set(allocation.itemId,Math.min(current.length+replacements,allocation.desiredBots))
        }
        let freeAccounts=actual.accounts.available
        if(desired.analystExecutionEnabled){
            const analystPolicy={...policy,operations:{...policy.operations,roles:{...policy.operations.roles,analyst:{...policy.operations.roles.analyst,target:Math.max(0,policy.operations.roles.analyst.target-replacementBots.filter(b=>b.task.type==='analyst').length)}}}}
            const analystActions=safePlan('analyst',()=>this.planAnalysts({policy:analystPolicy,actual,now,admission}))
            for(const action of analystActions){actions.push(action);if(action.target.botId) used.add(action.target.botId)}
            freeAccounts-=analystActions.filter(a=>a.result==='planned' && a.action==='assign_analyst' && actual.bots.find(b=>b.botId===a.target.botId)?.accountId==null).length
        }
        let reserved=occupied.length+replacementBots.filter(b=>b.task.type==='reseller').length
        const make=(bot,allocation,action)=>{
            const reasons=[...(allocation?.reasons ?? [reason("TARGET_RESELLER_COUNT","Кількість reseller перевищує ціль.",{target:policy.operations.roles.reseller.target})])]
            const constraints=[...(allocation?.constraintsApplied ?? [])]
            const blocked=[]
            if(desired.analystExecutionEnabled&&!policy.operations.autonomousTradingEnabled) blocked.push(reason('TRADING_EXECUTION_DISABLED','Автономну торгівлю вимкнено канонічною політикою.'))
            const after=action === "release" ? {...bot.task,enabled:0} : {type:"reseller",itemId:allocation.itemId,buyPrice:allocation.buyPrice,sellPrice:allocation.sellPrice,enabled:1}
            if(!policy.operations.automationActive) blocked.push(reason("CORE_DISABLED","Автономне виконання вимкнено."))
            if(!policy.operations.allocationEnabled) blocked.push(reason("AUTO_ALLOCATION_DISABLED","Автоматичний розподіл ботів вимкнено."))
            if(bot.manualHold) blocked.push(reason("USER_BOT_HOLD","Бот перебуває під ручним керуванням користувача."))
            if(bot.pendingDecisionId) blocked.push(reason("ACTION_IN_PROGRESS","Попередня дія ще очікує завершення."))
            if(bot.failedUntil>now) blocked.push(reason("FAILURE_BACKOFF","Пауза після невдалої дії.",{until:bot.failedUntil}))
            if(bot.reconnectBlocked) blocked.push(reason("SUPERVISOR_BLOCKED","Supervisor заблокував повторне підключення."))
            if(bot.running || bot.desiredState === "running" || ["stopping","restarting","starting"].includes(bot.supervisorStatus)){
                blocked.push(reason("SAFE_TRANSITION_UNAVAILABLE","Для активного бота ще немає підтвердженого safe transition point. Завдання не переривається."))
            }
            if(action !== "release"){
                if(!bot.targetConfigured) blocked.push(reason("BOT_TARGET_MISSING","У бота не задано сервер або анархію."))
                if(after.buyPrice==null || after.sellPrice==null) blocked.push(reason("PRICES_UNAVAILABLE","Немає однозначних заданих цін у межах override."))
                if(!bot.accountUsable){
                    if(bot.accountId!=null || freeAccounts<1) blocked.push(reason("ACCOUNT_UNAVAILABLE","Немає доступного Minecraft-акаунта для цього бота."))
                }
                if(!isOccupied(bot) && reserved>=policy.operations.roles.reseller.target) blocked.push(reason("TOTAL_RESELLER_LIMIT","Новий запуск перевищив би загальну ціль reseller."))
                const switching=bot.task.type === "reseller" && bot.task.itemId!=null && bot.task.itemId!==after.itemId
                if(switching && !allocation.hardOverride){
                    for(const [code,timestamp,duration] of [["MINIMUM_ASSIGNMENT_DURATION",bot.lastAssignmentAt,policy.minimumAssignmentDurationMs],["SWITCH_COOLDOWN",bot.lastSwitchAt,policy.switchCooldownMs]]){
                        if(timestamp!=null && now<timestamp+duration) blocked.push(reason(code,"Очікування дозволеного часу перемикання.",{until:timestamp+duration}))
                    }
                    if(allocation.improvementPercent==null || allocation.improvementPercent<policy.switchImprovementThresholdPercent){
                        blocked.push(reason("SWITCH_IMPROVEMENT_UNAVAILABLE","Покращення для автоматичного перемикання не підтверджено даними.",{requiredPercent:policy.switchImprovementThresholdPercent,observedPercent:allocation.improvementPercent}))
                    }
                }
                reasons.push(reason("RESELLER_DEFICIT","Потрібен reseller для досягнення desired allocation.",{desired:allocation.desiredBots,actual:actual.allocations.find(a=>a.itemId===allocation.itemId)?.actualBots ?? 0}))
                if(!bot.running) reasons.push(reason("AVAILABLE_BOT","Процес бота зупинено; конфігурацію можна змінити без переривання операції.",{botId:bot.botId}))
            }
            constraints.push(...blocked.map(r=>({code:r.code,...r.data})))
            return {action,target:{botId:bot.botId,itemId:allocation?.itemId ?? bot.task.itemId},before:bot.task,after,
                reasons:[...reasons,...blocked],constraintsApplied:constraints,alternatives:[],result:blocked.length ? "blocked" : "planned"}
        }
        for(const allocation of allocations){
            let deficit=allocation.desiredBots-(counts.get(allocation.itemId) ?? 0)
            // Even a matching count may violate newly imposed price constraints.
            for(const bot of occupied.filter(b=>admitted(b)&&kept.has(b.botId) && b.activeTask.itemId===allocation.itemId)){
                if(bot.activeTask.buyPrice!==allocation.buyPrice || bot.activeTask.sellPrice!==allocation.sellPrice){
                    actions.push(make(bot,allocation,"assign"));used.add(bot.botId)
                }
            }
            const candidates=actual.bots.filter(b=>admitted(b)&&!kept.has(b.botId) && !used.has(b.botId) && !b.manualHold && !b.pendingDecisionId && b.activeTask.type!=='analyst')
                .sort((a,b)=>Number(make(a,allocation,"assign").result!=="planned")-Number(make(b,allocation,"assign").result!=="planned") || (admission?.botTurns?.get(a.botId)??0)-(admission?.botTurns?.get(b.botId)??0) || Number(isOccupied(b))-Number(isOccupied(a)) || Number(b.task.itemId===allocation.itemId)-Number(a.task.itemId===allocation.itemId) || a.botId-b.botId)
            for(const bot of candidates){
                if(deficit<=0) break
                const action=make(bot,allocation,"assign")
                actions.push(action);used.add(bot.botId);deficit--
                if(action.result === "planned"){
                    if(!bot.accountUsable) freeAccounts--
                    if(!isOccupied(bot)) reserved++
                }
            }
            if(deficit>0) actions.push({action:"allocate",target:{botId:null,itemId:allocation.itemId},before:{actualBots:counts.get(allocation.itemId)},after:{desiredBots:allocation.desiredBots},
                reasons:[...allocation.reasons,reason("NO_ELIGIBLE_BOT",`${deficit} слотів очікують доступних ботів.`,{deficit})],constraintsApplied:allocation.constraintsApplied,alternatives:[],result:"blocked"})
        }
        for(const bot of occupied.filter(b=>admitted(b)&&!kept.has(b.botId) && !used.has(b.botId))) actions.push(make(bot,desiredMap.get(bot.activeTask.itemId),"release"))
        if(desired.unallocatedResellers>0) actions.push({action:"allocate",target:{botId:null,itemId:null},before:{allocated:policy.operations.roles.reseller.target-desired.unallocatedResellers},after:{target:policy.operations.roles.reseller.target},reasons:[reason("NO_ITEM_PLAN","Немає дозволеного плану товарів для всіх слотів.",{deficit:desired.unallocatedResellers})],constraintsApplied:[],alternatives:[],result:"blocked"})
        if(!desired.analystExecutionEnabled && policy.operations.roles.analyst.target>actual.roles.analyst) actions.push({action:"allocate_analyst",target:{botId:null,itemId:null},before:{actual:actual.roles.analyst},after:{target:policy.operations.roles.analyst.target},reasons:[reason("ANALYST_UNAVAILABLE","Analyst execution поки недоступний.")],constraintsApplied:[],alternatives:[],result:"blocked"})
        const generationActions=safePlan('generation',()=>{const a=operations&&accountGeneration?this.planAccountGeneration({desired,actual,operations,accountGeneration,now,replacementBots}):null;return a?[a]:[]})
        return [...actions,...generationActions,...failures]
    }
    planAccountGeneration({desired,actual,operations,accountGeneration,now,replacementBots=[]}){
        const reserve=operations.reserve,pending=actual.accounting?.accounts.pendingGeneration??((accountGeneration.pending??0)+(this.replacements?.pendingCreations()??0))
        const starting=actual.bots.filter(b=>!b.role&&(b.desiredState==='running'||b.supervisorStatus==='starting')).length
        const running=Object.values(actual.roles).reduce((sum,value)=>sum+value,0)
        const desiredRunning=Object.values(desired.roles).reduce((sum,value)=>sum+value,0)
        // Existing replacement requests own these logical slots, including retry backoff.
        // Ordinary generation must not create a second account for the same demand.
        const replacementDemand=Object.entries(desired.roles).reduce((sum,[role,target])=>sum+Math.min(Math.max(0,target-(actual.roles[role]??0)),replacementBots.filter(b=>b.task.type===role).length),0)
        const workCapacityDeficit=actual.accounting?.accounts.accountDemand??Math.max(0,desiredRunning-running-starting-replacementDemand)
        const reserveDeficit=Math.max(0,reserve.targetReadyAccounts-Math.max(0,actual.accounts.available-workCapacityDeficit))
        const uncoveredAccountDeficit=actual.accounting?.accounts.uncovered??Math.max(0,workCapacityDeficit+reserve.targetReadyAccounts-actual.accounts.available-pending)
        const diagnostic={desiredRunning,running,starting,eligibleReadyAccounts:actual.accounts.available,pendingAccountCreations:pending,workCapacityDeficit,reserveDeficit,uncoveredAccountDeficit,totalAccounts:actual.accounts.total,maximumTotalAccounts:reserve.maximumTotalAccounts,maximumPendingAccountGeneration:reserve.maximumPendingAccountGeneration}
        if(!uncoveredAccountDeficit)return null
        const allowance=accountGenerationAllowance(operations,{total:actual.accounts.total,pending,requested:uncoveredAccountDeficit})
        let blocker=allowance.blocker
        if(!blocker&&accountGeneration.available===false)blocker='ACCOUNT_GENERATOR_UNAVAILABLE'
        if(!blocker&&accountGeneration.retryAt>now)blocker='ACCOUNT_GENERATION_BACKOFF'
        const count=allowance.count
        if(!blocker&&!count)blocker='ACCOUNT_TOTAL_LIMIT_REACHED'
        const messages={AUTOMATIC_ACCOUNT_GENERATION_DISABLED:'Автоматичне створення акаунтів вимкнено.',ACCOUNT_TOTAL_LIMIT_REACHED:'Досягнуто максимальну кількість акаунтів.',ACCOUNT_PENDING_LIMIT_REACHED:'Досягнуто ліміт одночасного створення акаунтів.',ACCOUNT_GENERATOR_UNAVAILABLE:'Наявний генератор акаунтів недоступний.',ACCOUNT_GENERATION_BACKOFF:'Пауза після невдалої генерації акаунтів.',MAINTENANCE_MODE:'Режим обслуговування забороняє створення акаунтів.',CORE_DISABLED:'Автоматизацію вимкнено.'}
        return {action:'generate_accounts',target:{botId:null,itemId:null},before:diagnostic,after:{...diagnostic,requested:count},result:blocker?'blocked':'planned',reasons:[reason('ACCOUNT_CAPACITY_DEFICIT','Для поточної цілі та резерву бракує акаунтів.',diagnostic),...(blocker?[reason(blocker,messages[blocker],diagnostic)]:[])],constraintsApplied:blocker?[{code:blocker}]:[],alternatives:[]}
    }
    planAnalysts({policy,actual,now,admission=null}){
        const active=actual.bots.filter(b=>b.activeTask.type==='analyst' && (b.running || b.desiredState==='running')).sort((a,b)=>a.botId-b.botId)
        const actions=[]
        let needed=actual.accounting?.roles.analyst?.uncovered??Math.max(0,policy.operations.roles.analyst.target-active.length),available=actual.accounts.available
        const candidates=actual.bots.filter(b=>(!admission||admission.botIds.has(b.botId))&&!b.running && b.desiredState!=='running' && !b.manualHold && !b.pendingDecisionId && !b.reconnectBlocked && !(b.failedUntil>now) && b.targetConfigured && (b.accountUsable || b.accountId==null) && !['starting','stopping','restarting'].includes(b.supervisorStatus))
            .sort((a,b)=>(admission?.botTurns?.get(a.botId)??0)-(admission?.botTurns?.get(b.botId)??0) || Number(b.task.type==='analyst')-Number(a.task.type==='analyst') || Number(a.task.type==='reseller')-Number(b.task.type==='reseller') || a.botId-b.botId)
        for(const bot of candidates){
            if(!needed) break
            if(!bot.accountUsable && available<1) continue
            const permitted=policy.operations.automationActive && policy.operations.allocationEnabled
            actions.push({action:'assign_analyst',target:{botId:bot.botId,itemId:null},before:bot.task,after:{type:'analyst',itemId:null,buyPrice:null,sellPrice:null,enabled:1},
                result:permitted?'planned':'blocked',reasons:[reason('TARGET_ANALYST_COUNT','Потрібен Analyst для цілі користувача.',{target:policy.operations.roles.analyst.target}),...(!permitted?[reason('ANALYST_ALLOCATION_DISABLED','Автономне призначення вимкнене.')]:[])],constraintsApplied:[],alternatives:[]})
            needed--;if(!bot.accountUsable) available--
        }
        if(needed) actions.push({action:'allocate_analyst',target:{botId:null,itemId:null},before:{actual:active.length},after:{target:policy.operations.roles.analyst.target},result:'blocked',reasons:[reason('NO_ELIGIBLE_ANALYST','Немає доступного зупиненого бота для Analyst.',{deficit:needed})],constraintsApplied:[],alternatives:[]})
        for(const bot of active.slice(policy.operations.roles.analyst.target).filter(b=>(!admission||admission.botIds.has(b.botId))&&!b.pendingDecisionId)){
            const permitted=policy.operations.automationActive && policy.operations.allocationEnabled && !bot.manualHold && bot.analysisState==='idle'
            actions.push({action:'stop_analyst',target:{botId:bot.botId,itemId:null},before:{desiredState:bot.desiredState},after:{desiredState:'stopped'},result:permitted?'planned':'blocked',
                reasons:[reason('TARGET_ANALYST_COUNT','Зменшено ціль Analyst.'),...(!permitted?[reason('ANALYST_STOP_BLOCKED','Очікування idle та дозволу користувача.')]:[])],constraintsApplied:[],alternatives:[]})
        }
        return actions
    }
    async apply(action,{valid,onAssigned,decisionId,actionId=null}){
        if(this.lifecycle&&(['stop_bot','stop_analyst','recover_bot','continue_binding'].includes(action.action)||action.action.startsWith('manual_')))return this.lifecycle.execute(action,{actionId,valid})
        if(action.action==='replace_account')return this.replacements.apply(action,{valid,decisionId,actionId})
        if(action.action==='generate_accounts'){
            const state=this.accountGeneration
            const check=(owned=0)=>{
                if(!valid())throw new Error('STALE_REVISION')
                // A replacement earlier in this cycle may already have consumed
                // the shared budget without changing the policy revision.
                if(this.store){
                    const operations=effectiveOperationsPolicy(this.store.operationsPolicy())
                    const total=this.store.store.prepare('SELECT count(*) n FROM accountsData').get().n
                    const pending=this.actions?.pendingGeneration(actionId)??(Math.max(0,state.pending-owned)+(this.replacements?.pendingCreations()??0))
                    const allowance=accountGenerationAllowance(operations,{total,pending,requested:action.after.requested})
                    if(allowance.count<action.after.requested)throw new Error(allowance.blocker??'ACCOUNT_CAPACITY_CHANGED')
                }
            }
            check()
            state.pending+=action.after.requested;state.state='generating';state.lastRequestedAt=Date.now();state.lastError=null
            try{
                const result=await this.executeCommand({command:'accounts.generate',payload:{count:action.after.requested},actor:{type:'internal',id:'autonomous-core'},actionId,executionGuard:()=>check(action.after.requested)})
                if(!result.ok)throw new Error('ACCOUNT_GENERATION_FAILED')
                state.state='created';state.lastCreatedAt=Date.now();state.retryAt=null
                return result.data
            }catch(error){state.state='failed';state.lastError=error?.message??'ACCOUNT_GENERATION_FAILED';throw error}
            finally{state.pending=Math.max(0,state.pending-action.after.requested)}
        }
        const botId=action.target.botId
        if(action.action==='stop_analyst'){
            const bot=this.botManager.getBot(botId)
            if(!valid() || bot?.analysisState!=='idle' || this.store.control().find(c=>c.botId===botId)?.manualHold) throw new Error('STALE_REVISION')
            const result=await this.executeCommand({command:'bot.stop',payload:{botId},actor:{type:'internal',id:'autonomous-core'},actionId,executionGuard:()=>{if(!valid())throw new Error('STALE_REVISION')}})
            if(!result.ok) throw new Error('BOT_START_REJECTED')
            return
        }
        const check=()=>{
            if(!valid()) throw new Error("STALE_REVISION")
            const bot=this.botManager.getBot(botId)
            if(bot?.isRunning() || bot?.desiredState === "running" || bot?.startingConfiguration || bot?.restartRequested) throw new Error("SAFE_TRANSITION_UNAVAILABLE")
            if(this.store.control().find(c=>c.botId===botId)?.manualHold) throw new Error("USER_BOT_HOLD")
        }
        check()
        this.store.store.transaction(()=>{
            const row=this.store.store.prepare("SELECT taskId,type,itemId,buyPricePerOne AS buyPrice,sellPricePerOne AS sellPrice,enabled FROM tasksData WHERE botId=?").get(botId)
            if(JSON.stringify(row ?? {taskId:null,type:null,itemId:null,buyPrice:null,sellPrice:null,enabled:null})!==JSON.stringify(action.before)) throw new Error("TASK_CHANGED_BY_USER")
            if(action.action === "release") this.store.store.prepare("UPDATE tasksData SET enabled=0 WHERE botId=?").run(botId)
            else this.store.store.prepare(`INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne,enabled) VALUES(?,?,?,?,?,1)
                ON CONFLICT(botId) DO UPDATE SET type=excluded.type,itemId=excluded.itemId,buyPricePerOne=excluded.buyPricePerOne,sellPricePerOne=excluded.sellPricePerOne,enabled=1`).run(botId,action.after.type,action.after.itemId,action.after.buyPrice,action.after.sellPrice)
            onAssigned()
        })
        await this.configurationService.sync()
        check()
        const row=this.store.store.prepare("SELECT type,itemId,buyPricePerOne AS buyPrice,sellPricePerOne AS sellPrice,enabled FROM tasksData WHERE botId=?").get(botId)
        if(Object.entries(row).some(([k,v])=>action.after[k]!==v)) throw new Error("TASK_CHANGED_BY_USER")
        if(action.action === "release") return
        const executionGuard=()=>{
            if(!valid()) throw new Error("STALE_REVISION")
            if(this.store.control().find(c=>c.botId===botId)?.manualHold) throw new Error("USER_BOT_HOLD")
            const task=this.store.store.prepare("SELECT type,itemId,buyPricePerOne AS buyPrice,sellPricePerOne AS sellPrice,enabled FROM tasksData WHERE botId=?").get(botId)
            if(!task || Object.entries(task).some(([k,v])=>action.after[k]!==v)) throw new Error("TASK_CHANGED_BY_USER")
        }
        const result=await this.executeCommand({command:"bot.start",payload:{botId},actor:{type:"internal",id:"autonomous-core"},actionId,executionGuard})
        if(!result.ok) throw new Error("BOT_START_REJECTED")
    }
}
