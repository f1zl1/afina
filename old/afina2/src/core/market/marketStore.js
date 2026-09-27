import {createHash} from 'node:crypto'
import {classifyLots,summarizeObservation,modelFromHistory,withAge} from './marketStatistics.js'

export default class MarketStore{
    constructor(store){this.store=store;this.namesRevision=null;this.names=new Set()}
    ownNames(){
        const revision=this.store.revision()
        if(this.namesRevision!==revision){
            this.names=new Set(this.store.prepare('SELECT username FROM accountsData').all().map(r=>r.username.trim().toLowerCase()))
            this.namesFingerprint=createHash('sha256').update(JSON.stringify([...this.names].sort())).digest('hex')
            this.namesRevision=revision
        }
        return this.names
    }
    items(){
        const revision=this.store.revision()
        if(this.itemCache?.revision!==revision) this.itemCache={revision,items:this.store.prepare('SELECT itemId,name,searchQuery,matcher FROM itemsData ORDER BY itemId').all()}
        return this.itemCache.items
    }
    revision(){return this.store.prepare('SELECT revision FROM marketMetadata WHERE id=1').get().revision}
    sessions(activeOnly=true){return this.store.prepare(`SELECT * FROM analysisSessions ${activeOnly?"WHERE status IN ('planned','running')":''} ORDER BY startedAt DESC LIMIT 1000`).all().map(r=>({...r,task:JSON.parse(r.task)}))}
    session(id){return this.store.prepare('SELECT * FROM analysisSessions WHERE analysisId=?').get(id)}
    createSession({bot,task,decisionId,inputRevision,now=Date.now(),policy}){
        this.store.prepare(`INSERT INTO analysisSessions(analysisId,itemId,botId,serverId,realm,workerPid,decisionId,inputRevision,startedAt,deadline,requestedObservations,status,task)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'planned',?)`).run(task.analysisId,task.itemId,bot.botId,bot.serverId,bot.realm,bot.workerPid,decisionId,inputRevision,now,now+policy.analysisSessionTimeoutMs,task.observationCount,JSON.stringify(task))
    }
    finish(id,status,code=null,now=Date.now()){
        return this.store.prepare("UPDATE analysisSessions SET status=?,failureCode=?,completedAt=?,nextRefreshAt=NULL WHERE analysisId=? AND status IN ('planned','running')").run(status,code,now,id).changes>0
    }
    progress(id,nextRefreshAt){this.store.prepare("UPDATE analysisSessions SET status='running',nextRefreshAt=? WHERE analysisId=? AND status IN ('planned','running')").run(nextRefreshAt ?? null,id)}
    observe(session,payload,policy,now=Date.now()){
        if(!Number.isSafeInteger(payload.ordinal) || payload.ordinal<1 || payload.ordinal>session.requestedObservations || !Array.isArray(payload.lots) || payload.lots.length>45) throw new Error('INVALID_OBSERVATION')
        if(payload.ordinal<=session.completedObservations) return null
        if(this.store.prepare('SELECT 1 FROM marketObservations WHERE analysisId=? AND ordinal=?').get(session.analysisId,payload.ordinal)) return null
        if(payload.ordinal!==session.completedObservations+1) throw new Error('OBSERVATION_OUT_OF_ORDER')
        if(!Number.isSafeInteger(payload.observedAt) || payload.observedAt<session.startedAt-2000 || payload.observedAt>now+2000) throw new Error('INVALID_OBSERVATION_TIME')
        const previous=this.store.prepare('SELECT observedAt FROM marketObservations WHERE analysisId=? ORDER BY ordinal DESC LIMIT 1').get(session.analysisId)
        if(previous && payload.observedAt<previous.observedAt) throw new Error('INVALID_OBSERVATION_TIME')
        const classified=classifyLots(payload.lots,this.ownNames(),policy),summary=summarizeObservation(classified)
        const observationId=`${session.analysisId}:${payload.ordinal}`,at=payload.observedAt
        return this.store.transaction(()=>{
            this.store.prepare('INSERT INTO marketObservations VALUES(?,?,?,?,?,?,?,?)').run(observationId,session.analysisId,payload.ordinal,session.itemId,session.serverId,session.realm,at,JSON.stringify(classified.lots))
            const latest={...summary,itemId:session.itemId,serverId:session.serverId,realm:session.realm,lastObservedAt:at,analysisId:session.analysisId,
                segmentation:{retailMax:policy.marketRetailMaxAmount,mediumMax:policy.marketMediumMaxAmount},ownershipFingerprint:this.namesFingerprint}
            this.store.prepare('INSERT INTO marketHistory VALUES(?,?,?,?,?,?,?)').run(observationId,session.analysisId,session.itemId,session.serverId,session.realm,at,JSON.stringify(latest))
            const history=this.store.prepare('SELECT document FROM marketHistory WHERE serverId=? AND realm=? AND itemId=? AND observedAt>=? ORDER BY observedAt DESC LIMIT 60').all(session.serverId,session.realm,session.itemId,at-86400000).map(r=>JSON.parse(r.document))
                .filter(h=>h.ownershipFingerprint===latest.ownershipFingerprint && h.segmentation?.retailMax===latest.segmentation.retailMax && h.segmentation?.mediumMax===latest.segmentation.mediumMax)
            const model=modelFromHistory(latest,history)
            this.store.prepare(`INSERT INTO marketModels VALUES(?,?,?,?,?) ON CONFLICT(serverId,realm,itemId) DO UPDATE SET observedAt=excluded.observedAt,document=excluded.document`).run(session.serverId,session.realm,session.itemId,at,JSON.stringify(model))
            this.store.prepare("UPDATE analysisSessions SET completedObservations=?,lotsObserved=lotsObserved+?,status='running' WHERE analysisId=?").run(payload.ordinal,payload.lots.length,session.analysisId)
            this.store.prepare('UPDATE marketMetadata SET revision=revision+1 WHERE id=1').run()
            return withAge(model,policy,now)
        })
    }
    snapshot(policy,now=Date.now()){
        const revision=this.revision()
        const dataRevision=this.store.revision()
        if(this.modelCache?.revision!==revision || this.modelCache?.dataRevision!==dataRevision){
            this.modelCache={revision,dataRevision,items:this.store.prepare('SELECT document FROM marketModels ORDER BY serverId,realm,itemId').all().map(r=>JSON.parse(r.document))}
        }
        this.ownNames()
        return {available:this.modelCache.items.length>0,status:this.modelCache.items.length?'observed':'unavailable',revision,items:this.modelCache.items.map(m=>{
            const aged=withAge(m,policy,now)
            if(m.ownershipFingerprint!==this.namesFingerprint || m.segmentation?.retailMax!==policy.marketRetailMaxAmount || m.segmentation?.mediumMax!==policy.marketMediumMaxAmount){
                aged.freshness='requires_reanalysis';aged.confidence=0
            }
            return aged
        })}
    }
    details({itemId,serverId,realm,limit=45}){
        if(![itemId,serverId,realm,limit].every(Number.isSafeInteger) || limit<1 || limit>135) throw new Error('Invalid market details query')
        const rows=this.store.prepare('SELECT observationId,observedAt,lots FROM marketObservations WHERE serverId=? AND realm=? AND itemId=? ORDER BY observedAt DESC LIMIT 3').all(serverId,realm,itemId)
        return {lots:rows.flatMap(r=>JSON.parse(r.lots).map(l=>({...l,observationId:r.observationId,observedAt:r.observedAt}))).slice(0,limit)}
    }
    cleanup(policy,now=Date.now()){
        // Bounded batches, no synchronous VACUUM. SQLite reuses freed pages.
        let removed=0
        for(const [table,hours,limit] of [['marketObservations',policy.marketRawRetentionHours,policy.marketRawLimit],['marketHistory',policy.marketHistoryRetentionHours,policy.marketHistoryLimit]]){
            removed+=this.store.prepare(`DELETE FROM ${table} WHERE observationId IN (SELECT observationId FROM ${table} WHERE observedAt<? ORDER BY observedAt LIMIT 100)`).run(now-hours*3600000).changes
            removed+=this.store.prepare(`DELETE FROM ${table} WHERE observationId IN (SELECT observationId FROM ${table} ORDER BY observedAt DESC,observationId DESC LIMIT 100 OFFSET ?)`).run(limit).changes
        }
        removed+=this.store.prepare(`DELETE FROM analysisSessions WHERE analysisId IN (SELECT analysisId FROM analysisSessions WHERE completedAt<? AND NOT EXISTS(SELECT 1 FROM marketObservations o WHERE o.analysisId=analysisSessions.analysisId) ORDER BY completedAt LIMIT 100)`).run(now-policy.marketHistoryRetentionHours*3600000).changes
        removed+=this.store.prepare(`DELETE FROM analysisSessions WHERE analysisId IN (SELECT analysisId FROM analysisSessions WHERE completedAt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM marketObservations o WHERE o.analysisId=analysisSessions.analysisId) ORDER BY completedAt DESC LIMIT 100 OFFSET ?)`).run(policy.marketHistoryLimit).changes
        return removed
    }
}
