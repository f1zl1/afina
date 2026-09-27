import {randomUUID} from 'node:crypto'
import {accountGenerationAllowance} from './canonicalPolicy.js'

// Reconciler action for an existing logical bot; never launches a worker directly.
export default class AccountReplacements{
    constructor({core,dataBaseManager,executeCommand,accountPool}){Object.assign(this,{core,dataBaseManager,executeCommand,accountPool});this.db=dataBaseManager.store}
    rows(){return this.db.prepare('SELECT * FROM accountReplacements ORDER BY createdAt,requestId').all()}
    pendingCreations(excludeRequestId=null){return this.rows().filter(r=>r.requestId!==excludeRequestId&&r.state==='generating'&&r.replacementAccountId==null).length}
    notify(type,row,extra={}){
        const task=this.db.prepare('SELECT type FROM tasksData WHERE botId=?').get(row.botId)
        const payload={type,botId:row.botId,bannedAccountId:row.bannedAccountId,replacementAccountId:row.replacementAccountId,
            generationRequestId:row.requestId,cause:'ACCOUNT_BANNED',timestamp:Date.now(),...((row.requestedRole ?? task?.type)?{desiredRole:row.requestedRole ?? task.type}:{}),...extra}
        this.core.eventBus.publish('core.account.incident',payload)
        this.core.record({action:type,target:{botId:row.botId},before:null,after:payload,result:type.endsWith('FAILED')?'failed':'applied',
            trigger:{type:'ACCOUNT_BANNED',source:'runtime'},reasons:[{code:type,message:type,data:payload}],constraintsApplied:[],alternatives:[]})
    }
    update(row,values){
        this.db.prepare(`UPDATE accountReplacements SET ${Object.keys(values).map(k=>k+'=?').join(',')},updatedAt=? WHERE requestId=?`).run(...Object.values(values),Date.now(),row.requestId)
        Object.assign(row,values)
    }
    settleJournal(row,result){
        const decision=row.decisionId && this.core.store.getDecision(row.decisionId)
        if(decision)this.core.record({...decision,result,updatedAt:Date.now()},true)
    }
    available(botId,actionId=null){return this.db.prepare(`SELECT a.accountId FROM accountsData a LEFT JOIN accountPoolState p ON p.accountId=a.accountId
        WHERE a.banned=0 AND a.disabled=0 AND (p.status IS NULL OR p.status='available' OR (p.status='cooldown' AND p.cooldownUntil<=?))
        AND NOT EXISTS(SELECT 1 FROM botData b WHERE b.archived=0 AND b.connectedAccountId=a.accountId)
        AND NOT EXISTS(SELECT 1 FROM coreActionResources r WHERE r.resourceKey='account:'||a.accountId AND r.actionId!=COALESCE(?,''))
        AND NOT EXISTS(SELECT 1 FROM accountReplacements r WHERE r.replacementAccountId=a.accountId AND r.botId!=? AND r.state NOT IN ('completed','cancelled'))
        ORDER BY COALESCE(p.lastUsedAt,''),a.accountId`).all(new Date().toISOString(),actionId,botId).filter(a=>!this.accountPool?.reserved?.has(a.accountId))}
    settle({policy,actual,now=Date.now()}){
        const rows=this.rows()
        for(const row of rows.filter(r=>['initializing','failed'].includes(r.state) && r.replacementAccountId!=null)){
            const b=actual.bots.find(b=>b.botId===row.botId)
            if(b?.accountId===row.replacementAccountId && b.workReady && b.role===b.task.type){
                this.update(row,{state:'completed',reason:null});this.settleJournal(row,'applied');this.notify('ACCOUNT_REPLACED',row)
            }else if(row.state==='initializing' && (!b || b.accountId!==row.replacementAccountId || b.banned || now-row.updatedAt>policy.actionTimeoutMs)){
                this.update(row,{state:'failed',reason:'INITIALIZATION_FAILED',retryAt:now+policy.failureRetryMs});this.settleJournal(row,'failed');this.notify('ACCOUNT_REPLACEMENT_FAILED',row,{failureReason:'INITIALIZATION_FAILED'})
            }
        }
        for(const row of rows.filter(r=>!['completed','cancelled'].includes(r.state))){
            const b=actual.bots.find(b=>b.botId===row.botId)
            if(b?.banned&&row.bannedAccountId!==b.accountId)this.update(row,{state:'cancelled'})
        }
    }
    plan({policy,desired,actual,now=Date.now(),overrides=[],admission=null}){
        const actions=[],rows=actual.observation?.pending.replacements.rows??[],remaining={reseller:Math.max(0,(desired.roles?.reseller ?? policy.operations.roles.reseller.target)-(actual.roles?.reseller ?? 0)),analyst:Math.max(0,(desired.roles?.analyst ?? policy.operations.roles.analyst.target)-(actual.roles?.analyst ?? 0))}
        const itemRemaining=new Map((desired.allocations ?? []).map(a=>[a.itemId,Math.max(0,a.desiredBots-(actual.allocations?.find(i=>i.itemId===a.itemId)?.actualBots ?? 0))]))
        const reserve=b=>{
            if(b.task.type in remaining)remaining[b.task.type]=Math.max(0,remaining[b.task.type]-1)
            if(b.task.type==='reseller')itemRemaining.set(b.task.itemId,Math.max(0,(itemRemaining.get(b.task.itemId) ?? 0)-1))
        }
        for(const b of actual.bots){
            if(!b.banned && !b.operationalBlock && !b.role && !rows.some(r=>r.botId===b.botId && !['completed','cancelled'].includes(r.state)) && (b.running || b.desiredState==='running') && b.task.enabled && b.task.type in remaining){
                reserve(b)
            }
        }
        // Reserve all existing initializations before considering any new deficit,
        // independently of bot ordering (a pending bot may have a larger ID).
        for(const row of rows.filter(r=>r.state==='initializing')){
            const b=actual.bots.find(b=>b.botId===row.botId)
            if(b && !b.role)reserve(b)
        }
        const pendingBotIds=new Set(rows.filter(r=>!['completed','cancelled'].includes(r.state)).map(r=>r.botId))
        for(const b of [...actual.bots].sort((a,b)=>(admission?.botTurns?.get(a.botId)??0)-(admission?.botTurns?.get(b.botId)??0) || Number(pendingBotIds.has(b.botId))-Number(pendingBotIds.has(a.botId)) || a.botId-b.botId)){
            let row=rows.find(r=>r.botId===b.botId && !['completed','cancelled'].includes(r.state))
            if(admission&&!admission.botIds.has(b.botId))continue
            const role=b.task.type
            if(!['reseller','analyst'].includes(role) || !b.task.enabled || b.manualHold || b.operationalBlock)continue
            if(row?.state==='initializing')continue
            if(b.banned&&row&&row.bannedAccountId!==b.accountId)row=null
            if(!b.banned && !row?.replacementAccountId)continue
            if(remaining[role]<=0)continue
            if(role==='reseller' && desired.allocations && !(itemRemaining.get(b.task.itemId)>0))continue
            const override=overrides.find(o=>o.itemId===b.task.itemId)
            if(role==='reseller' && ((override?.maxBuyPrice!=null && b.task.buyPrice>override.maxBuyPrice) || (override?.minSellPrice!=null && b.task.sellPrice<override.minSellPrice)))continue
            reserve(b)
            const permitted=policy.operations.automationActive && policy.operations.recovery.autoReplaceBannedAccounts && !b.running && b.desiredState!=='running' && !(row?.retryAt>now)
            actions.push({action:'replace_account',target:{botId:b.botId,itemId:b.task.itemId},before:b.task,after:b.task,
                result:permitted?'planned':'blocked',reasons:[{code:permitted?'ACCOUNT_REPLACEMENT_REQUESTED':'ACCOUNT_CAPACITY_DEFICIT',message:permitted?'Заміна заблокованого тестового акаунта.':'Немає доступного акаунта для потрібної потужності.',data:{bannedAccountId:b.accountId,requiredReplacementCount:1}}],constraintsApplied:[],alternatives:[]})
        }
        return actions
    }
    async apply(action,{valid,decisionId,actionId=null}){
        const checkWorkload=()=>{
            if(!valid() || !this.core.effectiveOperations().permissions.mayReplace)throw new Error('STALE_REVISION')
            if(this.core.store.control().find(c=>c.botId===action.target.botId)?.manualHold)throw new Error('USER_BOT_HOLD')
            const task=this.db.prepare('SELECT taskId,type,itemId,buyPricePerOne AS buyPrice,sellPricePerOne AS sellPrice,enabled FROM tasksData WHERE botId=?').get(action.target.botId)
            if(JSON.stringify(task)!==JSON.stringify(action.before))throw new Error('TASK_CHANGED_BY_USER')
        }
        const check=()=>{
            checkWorkload()
            const process=this.core.botManager.getBot(action.target.botId)
            if(process?.isRunning?.() || process?.desiredState==='running' || process?.startingConfiguration || process?.restartRequested)throw new Error('SAFE_TRANSITION_UNAVAILABLE')
        }
        check()
        const botId=action.target.botId,accountId=this.db.prepare('SELECT connectedAccountId FROM botData WHERE botId=?').get(botId).connectedAccountId
        let row=this.rows().find(r=>r.botId===botId && !['completed','cancelled'].includes(r.state))
        if(!row){
            row={requestId:randomUUID(),botId,bannedAccountId:accountId,replacementAccountId:null,state:'requested',createdAt:Date.now(),updatedAt:Date.now(),requestedRole:action.after.type,requestedAssignment:JSON.stringify(action.after)}
            this.db.prepare('INSERT INTO accountReplacements(requestId,botId,bannedAccountId,state,createdAt,updatedAt,requestedRole,requestedAssignment) VALUES(?,?,?,?,?,?,?,?)').run(row.requestId,botId,accountId,row.state,row.createdAt,row.updatedAt,row.requestedRole,row.requestedAssignment)
            this.notify('ACCOUNT_REPLACEMENT_REQUESTED',row,{desiredRole:action.after.type,itemId:action.after.itemId})
        }
        if(decisionId)this.update(row,{decisionId})
        try{
            const policy=this.core.runtimePolicy()
            if(row.replacementAccountId!=null){
                const candidate=this.db.prepare(`SELECT a.banned,a.disabled,p.status FROM accountsData a LEFT JOIN accountPoolState p ON p.accountId=a.accountId WHERE a.accountId=?`).get(row.replacementAccountId)
                if(!candidate || candidate.banned || candidate.disabled || ['blocked','retired','cooldown'].includes(candidate.status)){
                    this.update(row,{replacementAccountId:null,state:'requested',reason:'ACCOUNT_UNAVAILABLE'})
                }
            }
            if(!this.available(botId,actionId).length && !row.replacementAccountId){
                const total=this.db.prepare('SELECT count(*) AS n FROM accountsData').get().n
                const pending=this.core.actions?.pendingGeneration(actionId)??((this.core.accountGeneration.pending??0)+this.pendingCreations(row.requestId))
                const allowance=accountGenerationAllowance(policy.operations,{total,pending,requested:1})
                if(!allowance.count){
                    this.update(row,{state:'deficit',retryAt:Date.now()+policy.failureRetryMs,reason:allowance.blocker==='AUTOMATIC_ACCOUNT_GENERATION_DISABLED'?'GENERATION_DISABLED':allowance.blocker==='ACCOUNT_TOTAL_LIMIT_REACHED'?'ACCOUNT_LIMIT_REACHED':allowance.blocker})
                    this.notify('ACCOUNT_CAPACITY_DEFICIT',row,{requiredReplacementCount:1,availableEligibleAccounts:0,pendingAccountCreations:this.rows().filter(r=>['generating','created','initializing'].includes(r.state)).length,generationAllowed:false})
                    return
                }
                check();this.update(row,{state:'generating'});this.notify('ACCOUNT_GENERATION_REQUESTED',row,{desiredRole:action.after.type})
                // The existing generator transaction also records its durable request result.
                try{
                    check()
                    this.dataBaseManager.createGeneratedAccounts(1,undefined,accounts=>{
                        this.update(row,{replacementAccountId:accounts[0].accountId,state:'created',generated:1,reason:null})
                        if(actionId)this.core.actions.ledger.claim(actionId,'account:'+accounts[0].accountId,{inTransaction:true})
                    },actionId)
                }catch{throw new Error('GENERATION_FAILED')}
                this.notify('ACCOUNT_GENERATED',row)
            }
            check()
            if(accountId!==row.replacementAccountId){
                const result=await this.executeCommand({command:'bot.account.rotate',payload:{botId,oldAccountAction:'blocked'},actor:{type:'internal',id:'autonomous-core'},actionId,executionGuard:check})
                if(!result.ok)throw new Error('ACCOUNT_SELECTION_FAILED')
                const selected=this.db.prepare('SELECT connectedAccountId FROM botData WHERE botId=?').get(botId).connectedAccountId
                this.update(row,{replacementAccountId:selected,state:'selected',retryAt:null,reason:null})
                this.notify('ACCOUNT_REPLACEMENT_SELECTED',row)
            }
            check()
            this.update(row,{state:'initializing',retryAt:null})
            const result=await this.executeCommand({command:'bot.start',payload:{botId},actor:{type:'internal',id:'autonomous-core'},actionId,executionGuard:()=>{
                checkWorkload()
                const account=this.db.prepare(`SELECT a.banned,a.disabled,p.status,p.cooldownUntil FROM accountsData a LEFT JOIN accountPoolState p ON p.accountId=a.accountId WHERE a.accountId=?`).get(row.replacementAccountId)
                const bound=this.db.prepare('SELECT connectedAccountId FROM botData WHERE botId=? AND archived=0').get(botId)
                if(!account || account.banned || account.disabled || bound?.connectedAccountId!==row.replacementAccountId || ['blocked','retired'].includes(account.status) || (account.status==='cooldown' && (!account.cooldownUntil || account.cooldownUntil>new Date().toISOString())))throw new Error('ACCOUNT_UNAVAILABLE')
            }})
            if(!result.ok)throw new Error('BOT_START_REJECTED')
        }catch(error){
            const code=['STALE_REVISION','USER_BOT_HOLD','SAFE_TRANSITION_UNAVAILABLE','TASK_CHANGED_BY_USER','ACCOUNT_SELECTION_FAILED','BOT_START_REJECTED','ACCOUNT_UNAVAILABLE','GENERATION_FAILED'].includes(error.message)?error.message:'REPLACEMENT_EXECUTION_FAILED'
            this.update(row,{state:'failed',retryAt:Date.now()+this.core.runtimePolicy().failureRetryMs,reason:code})
            this.notify('ACCOUNT_REPLACEMENT_FAILED',row,{failureReason:code})
        }
    }
}
