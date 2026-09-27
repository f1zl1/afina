const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child)}return value}

// Read side only: batched durable inventory + lifecycle-owner observations.
export default class CoreObserver{
    constructor({store,botManager,accountPool,logger,options={}}){
        Object.assign(this,{store,botManager,accountPool,logger});this.options={freshMs:15000,timeoutMs:1000,concurrency:32,scanTimeoutMs:3000,...options}
        for(const [key,max] of Object.entries({freshMs:60000,timeoutMs:5000,concurrency:64,scanTimeoutMs:10000}))if(!Number.isInteger(this.options[key])||this.options[key]<1||this.options[key]>max)throw new Error('Invalid observation option: '+key)
        this.controller=new AbortController();this.lastAuthoritativeAt=null;this.metrics=null
    }
    inventory(){
        const revision=this.store.revision()
        if(this.cached?.revision!==revision)this.cached={revision,
            bots:this.store.prepare(`SELECT b.botId,b.name,b.connectedAccountId,b.serverId,b.realm,t.taskId,t.type,t.itemId,t.buyPricePerOne,t.sellPricePerOne,t.enabled,s.serverId AS validServerId FROM botData b LEFT JOIN tasksData t ON t.botId=b.botId LEFT JOIN serverData s ON s.serverId=b.serverId WHERE b.archived=0 ORDER BY b.botId`).all(),
            items:this.store.prepare('SELECT itemId,name FROM itemsData ORDER BY itemId').all(),
            accounts:this.store.prepare(`SELECT a.accountId,a.banned,a.disabled,p.status,p.cooldownUntil,b.botId FROM accountsData a LEFT JOIN accountPoolState p ON p.accountId=a.accountId LEFT JOIN botData b ON b.connectedAccountId=a.accountId AND b.archived=0`).all()}
        return this.cached
    }
    async refresh({force=false,reason='event',budgetMs=this.options.scanTimeoutMs}={}){
        if(this.inFlight)return this.inFlight
        this.inFlight=(async()=>{
            const ids=this.inventory().bots.map(b=>b.botId)
            const metrics=await this.botManager.observeBots?.(ids,{...this.options,scanTimeoutMs:Math.max(1,Math.min(this.options.scanTimeoutMs,budgetMs)),force,signal:this.controller.signal})??{workers:ids.length,queried:0,refreshed:0,timeouts:0,unavailable:ids.length,durationMs:0}
            if(force&&!this.controller.signal.aborted)this.lastAuthoritativeAt=Date.now()
            this.metrics={...metrics,reason,force,completedAt:Date.now()}
            if(force)this.logger?.info('CORE_OBSERVATION_COMPLETED',this.metrics)
        })().finally(()=>{this.inFlight=null})
        return this.inFlight
    }
    snapshot({policyRevision,controls=[],generation={}}={}){
        const db=this.inventory(),timestamp=Date.now()
        const replacements=this.store.prepare("SELECT requestId,botId,bannedAccountId,replacementAccountId,state,generated,createdAt,updatedAt,retryAt,reason FROM accountReplacements WHERE state NOT IN ('completed','cancelled')").all()
        const workers=db.bots.map(b=>this.botManager.getWorkerObservation?.(b.botId,{now:timestamp,freshMs:this.options.freshMs})??{
            botId:b.botId,quality:'UNAVAILABLE',process:{alive:null,ipcConnected:false,incarnationId:null,observedAt:timestamp,source:'process_observation'},facts:null,source:'process_observation',reason:'WORKER_OBSERVATION_API_UNAVAILABLE',intent:{}})
        const actions=this.store.prepare("SELECT * FROM coreActions WHERE state IN ('RESERVED','DISPATCHED','RUNNING') ORDER BY createdAt,actionId").all().map(a=>({...a,metadata:JSON.parse(a.metadata),resourceKeys:JSON.parse(a.resourceKeys)}))
        const reservations=this.store.prepare('SELECT * FROM coreActionResources').all()
        const generationResults=this.store.prepare('SELECT * FROM coreGenerationResults WHERE requestId IN (SELECT actionId FROM coreActions WHERE state IN (\'RESERVED\',\'DISPATCHED\',\'RUNNING\'))').all()
        const generated=new Map(generationResults.map(r=>[r.requestId,JSON.parse(r.accountIds).length]))
        const pendingGeneration=actions.filter(a=>a.type==='GENERATE'||a.type==='REPLACE'&&a.metadata.generation).reduce((n,a)=>n+Math.max(0,a.quantity-(generated.get(a.actionId)??a.created)),0)
        const accounts=db.accounts.map(a=>({...a,assigned:a.botId!=null,manualHold:Boolean(controls.find(c=>c.botId===a.botId)?.manualHold),reserved:this.accountPool?.reserved?.has(a.accountId)===true||reservations.some(r=>r.resourceKey==='account:'+a.accountId),
            replacementPending:replacements.some(r=>r.replacementAccountId===a.accountId),initializing:replacements.some(r=>r.replacementAccountId===a.accountId&&r.state==='initializing'),
            eligible:!a.banned&&!a.disabled&&(!a.status||a.status==='available'||a.status==='cooldown'&&Date.parse(a.cooldownUntil)<=timestamp),source:'database',observedAt:timestamp}))
        const lifecycle=this.botManager.lifecycle?.state.rows()??[]
        const snapshot={version:1,timestamp,policyRevision,dataRevision:db.revision,definitions:db.bots,items:db.items,accounts,workers,controls,actions,reservations,generationResults,lifecycle,
            pending:{replacements:{source:'database',observedAt:timestamp,rows:replacements},generation:{source:'action_ledger',observedAt:timestamp,pending:pendingGeneration,state:generation.state??'idle'}},
            metrics:{...this.metrics,stale:workers.filter(w=>w.quality==='STALE').length,unavailable:workers.filter(w=>['UNAVAILABLE','INCARNATION_MISMATCH'].includes(w.quality)).length},lastAuthoritativeAt:this.lastAuthoritativeAt,options:this.options}
        return freeze(structuredClone(snapshot))
    }
    stop(){this.controller.abort();this.botManager.cancelObservation?.()}
}
