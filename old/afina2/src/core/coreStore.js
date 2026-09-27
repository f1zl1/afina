import { randomUUID } from "node:crypto"
import {runtimeConfig,validateAntiAfk} from '../minecraftBot/runtime/runtimeConfig.js'
import {validateMarketPolicy} from './market/marketConfig.js'
import { policyFields, overrideFields, validateFields, validateOverride } from "./corePolicy.js"
import {defaultOperationsPolicy,mergeOperationsPolicy} from './operationsPolicy.js'
import {legacyOperationalFields} from './coreCapabilities.js'
import {adaptLegacyPolicy,legacyPolicyProjection} from './canonicalPolicy.js'

const decode=(row,fields)=>Object.fromEntries(Object.entries(row).filter(([k])=>k!=="id").map(([k,v])=>[k,fields[k]?.type === "boolean" ? Boolean(v) : v]))
const encode=value=>typeof value === "boolean" ? Number(value) : value
export default class CoreStore{
    constructor(store){this.store=store}
    revision(){return this.store.prepare("SELECT revision FROM coreMetadata WHERE id=1").get().revision}
    runtimeSettings(){
        const values=decode(this.store.prepare("SELECT * FROM corePolicy WHERE id=1").get(),policyFields)
        for(const key of Object.keys(legacyOperationalFields))delete values[key]
        return values
    }
    // Read compatibility only: operational aliases always project canonical intent.
    policy(){return {...this.runtimeSettings(),...legacyPolicyProjection(this.operationsPolicy())}}
    operationsPolicy(){
        const row=this.store.prepare('SELECT revision,document,updatedAt FROM operationsPolicy WHERE id=1').get()
        const stored=JSON.parse(row?.document ?? '{}')
        return {...mergeOperationsPolicy(defaultOperationsPolicy,stored),revision:row?.revision ?? 1,updatedAt:row?.updatedAt ?? null}
    }
    canonicalization(){return JSON.parse(this.store.prepare('SELECT canonicalization FROM operationsPolicy WHERE id=1').get().canonicalization)}
    persistPolicy(next,settings={}){
        const {revision,updatedAt,...document}=next
        const aliases=legacyPolicyProjection(document)
        aliases.targetAnalysts=Math.min(1000,aliases.targetAnalysts);aliases.targetResellers=Math.min(1000,aliases.targetResellers)
        const values={...settings,...aliases},keys=Object.keys(values)
        // v9 mirrors have no revision trigger. One canonical write invalidates the
        // input revision exactly once, inside the caller's transaction.
        this.store.prepare(`UPDATE corePolicy SET ${keys.map(k=>`"${k}"=?`).join(',')} WHERE id=1`).run(...keys.map(k=>encode(values[k])))
        this.store.prepare('UPDATE operationsPolicy SET revision=revision+1,document=?,updatedAt=? WHERE id=1').run(JSON.stringify(document),Date.now())
    }
    updateOperationsPolicy(values,expectedRevision){return this.store.transaction(()=>{
        const current=this.operationsPolicy()
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==current.revision)throw new Error('OPERATIONS_CONFLICT: refresh settings; Operations Policy already changed')
        const {revision,updatedAt,...base}=current,next=mergeOperationsPolicy(base,values)
        if(current.liveValidation.enabled&&!next.liveValidation.enabled)next.autonomousTradingEnabled=false
        this.persistPolicy(next)
        return this.operationsPolicy()
    })}
    overrides(){return this.store.prepare("SELECT * FROM coreItemOverrides ORDER BY itemId").all().map(row=>decode(row,overrideFields))}
    control(){return this.store.prepare("SELECT * FROM coreBotControl ORDER BY botId").all()}
    desired(){const row=this.store.prepare("SELECT document FROM coreDesiredState WHERE id=1").get();return row ? JSON.parse(row.document) : null}
    updatePolicy(values,expectedRevision){
        validateFields(values,policyFields)
        return this.store.transaction(()=>{
            this.checkRevision(expectedRevision)
            validateMarketPolicy({...this.policy(),...values})
            validateAntiAfk(runtimeConfig({...this.policy(),...values}))
            const next=adaptLegacyPolicy(this.operationsPolicy(),values)
            const settings=Object.fromEntries(Object.entries(values).filter(([key])=>!Object.hasOwn(legacyOperationalFields,key)))
            this.persistPolicy(next,settings)
            return this.policy()
        })
    }
    checkRevision(revision){if(!Number.isSafeInteger(revision) || revision!==this.revision()) throw new Error("CORE_CONFLICT: оновіть дані — налаштування вже змінено")}
    setOverride(itemId,values,expectedRevision){
        if(!Number.isSafeInteger(itemId) || itemId<1) throw new Error("Invalid itemId")
        validateOverride(values)
        return this.store.transaction(()=>{
            this.checkRevision(expectedRevision)
            if(!this.store.prepare("SELECT 1 FROM itemsData WHERE itemId=?").get(itemId)) throw new Error("Item does not exist")
            const previous=this.overrides().find(v=>v.itemId===itemId) ?? {disabled:false,minBots:null,maxBots:null,forcedBots:null,maxBuyPrice:null,minSellPrice:null}
            const next={...previous,...values};delete next.itemId;validateOverride(next)
            this.store.prepare(`INSERT INTO coreItemOverrides(itemId,${Object.keys(next).join(",")}) VALUES(?,${Object.keys(next).map(()=>"?").join(",")})
                ON CONFLICT(itemId) DO UPDATE SET ${Object.keys(next).map(k=>`${k}=excluded.${k}`).join(",")}`).run(itemId,...Object.values(next).map(encode))
            return {itemId,...next}
        })
    }
    deleteOverride(itemId,expectedRevision){
        if(!Number.isSafeInteger(itemId) || itemId<1) throw new Error("Invalid itemId")
        this.store.transaction(()=>{this.checkRevision(expectedRevision);this.store.prepare("DELETE FROM coreItemOverrides WHERE itemId=?").run(itemId)})
    }
    saveDesired(state){this.store.prepare("INSERT INTO coreDesiredState VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,generatedAt=excluded.generatedAt,document=excluded.document").run(state.revision,state.generatedAt,JSON.stringify(state))}
    decisions(limit=50){
        if(!Number.isInteger(limit) || limit<1 || limit>200) throw new Error("Invalid decision limit (1..200)")
        return this.store.prepare("SELECT document FROM coreDecisionJournal ORDER BY sequence DESC LIMIT ?").all(limit).map(row=>JSON.parse(row.document))
    }
    decision(record){
        const value={decisionId:randomUUID(),timestamp:Date.now(),...record}
        this.store.prepare(`INSERT INTO coreDecisionJournal(decisionId,timestamp,action,result,document) VALUES(?,?,?,?,?)
            ON CONFLICT(decisionId) DO UPDATE SET result=excluded.result,document=excluded.document`).run(value.decisionId,value.timestamp,value.action,value.result,JSON.stringify(value))
        this.store.prepare(`DELETE FROM coreDecisionJournal WHERE sequence NOT IN (SELECT sequence FROM coreDecisionJournal ORDER BY sequence DESC LIMIT ?)
            AND decisionId NOT IN (SELECT pendingDecisionId FROM coreBotControl WHERE pendingDecisionId IS NOT NULL
                UNION SELECT decisionId FROM analysisSessions WHERE status IN ('planned','running')
                UNION SELECT decisionId FROM accountReplacements WHERE decisionId IS NOT NULL AND state NOT IN ('completed','cancelled')
                UNION SELECT decisionId FROM coreActions WHERE decisionId IS NOT NULL AND state IN ('RESERVED','DISPATCHED','RUNNING'))`).run(this.runtimeSettings().journalLimit)
        return value
    }
    getDecision(id){const row=this.store.prepare("SELECT document FROM coreDecisionJournal WHERE decisionId=?").get(id);return row ? JSON.parse(row.document) : null}
    setControl(botId,values){
        const allowed=new Set(["manualHold","lastAssignmentAt","lastSwitchAt","pendingDecisionId","pendingActionId","pendingSince","pendingAfter","failedUntil"])
        const keys=Object.keys(values)
        if(!keys.length || keys.some(k=>!allowed.has(k))) throw new Error("Invalid core control field")
        this.store.prepare(`INSERT INTO coreBotControl(botId,${keys.join(",")}) VALUES(?,${keys.map(()=>"?").join(",")})
            ON CONFLICT(botId) DO UPDATE SET ${keys.map(k=>`${k}=excluded.${k}`).join(",")}`).run(botId,...keys.map(k=>encode(values[k])))
    }
    clearPending(botId,failedUntil=null){this.setControl(botId,{pendingDecisionId:null,pendingActionId:null,pendingSince:null,pendingAfter:null,failedUntil})}
}
