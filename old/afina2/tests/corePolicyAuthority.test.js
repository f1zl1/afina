import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import DatabaseStore from '../src/data/databaseStore.js'
import CoreStore from '../src/core/coreStore.js'
import * as schema from '../src/data/databaseSchema.js'
import {defaultOperationsPolicy,mergeOperationsPolicy,effectiveOperationsPolicy} from '../src/core/operationsPolicy.js'
import {coreCapabilities,policySettingMetadata,operationsSetting} from '../src/core/coreCapabilities.js'
import {accountGenerationAllowance} from '../src/core/canonicalPolicy.js'
import {policyFields,overrideFields} from '../src/core/corePolicy.js'
import {explicitPolicyChanges,metadataHelp} from '../src/webTerminal/public/js/operationsPolicyUi.js'

async function fixture(t,seed){
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-policy-authority-')),config={databasePath:path.join(dir,'afina.db')}
    if(seed){
        const db=new DatabaseSync(config.databasePath);db.exec(schema.schema);schema.addChangeTracking(db)
        for(let version=2;version<=8;version++)schema['upgradeToVersion'+version](db)
        db.exec("PRAGMA user_version=8; INSERT INTO schemaMigrations VALUES(8,'fixture'); INSERT INTO accountsData(username,password) VALUES('Preserved','fixture-secret')")
        seed(db);db.close()
    }
    const store=new DatabaseStore(config);await store.init();const core=new CoreStore(store)
    t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
    return {store,core,dir,config}
}
const edit=(core,values)=>core.updateOperationsPolicy(values,core.operationsPolicy().revision)
const legacy=(core,values)=>core.updatePolicy(values,core.revision())

test('fresh canonical policy contains both supported roles and inert defaults',async t=>{
    const {core,store}=await fixture(t),p=core.operationsPolicy()
    assert.deepEqual(Object.keys(p.roles),['analyst','reseller'])
    assert.equal(p.automationEnabled,false);assert.equal(p.reserve.automaticAccountGeneration,false)
    assert.equal(core.canonicalization().diagnostics.length,0)
    assert.equal(store.prepare('PRAGMA user_version').get().user_version,16)
})

test('legacy partial target writes preserve unrelated targets, schedules and hard global maximum',async t=>{
    const {core}=await fixture(t)
    edit(core,{roles:{analyst:{target:1,maximum:20},reseller:{target:10,maximum:20}},capacity:{maximum:11},schedules:[{id:'night',role:'analyst',weekdays:[1],start:'23:00',end:'07:00',enabled:true,capacity:null}]})
    const schedules=core.operationsPolicy().schedules
    legacy(core,{targetAnalysts:2})
    let p=core.operationsPolicy();assert.equal(p.roles.analyst.target,2);assert.equal(p.roles.reseller.target,10);assert.equal(p.capacity.maximum,11)
    legacy(core,{targetResellers:8});p=core.operationsPolicy()
    assert.equal(p.roles.analyst.target,2);assert.equal(p.roles.reseller.target,8);assert.deepEqual(p.schedules,schedules)
    legacy(core,{enabled:true,autoReplaceBannedAccounts:true,allowAutomaticAccountGeneration:true,maxAccounts:25})
    p=core.operationsPolicy();assert.equal(p.automationEnabled,true);assert.equal(p.recovery.autoReplaceBannedAccounts,true);assert.equal(p.reserve.automaticAccountGeneration,true);assert.equal(p.reserve.maximumTotalAccounts,25)
})

test('canonical writes and runtime saves each increment one revision; mirrors are never decision authority',async t=>{
    const {core,store}=await fixture(t)
    for(const operation of [()=>edit(core,{automationEnabled:true}),()=>legacy(core,{enabled:false}),()=>legacy(core,{antiAfkEnabled:false})]){
        const revision=core.operationsPolicy().revision,input=core.revision();operation()
        assert.equal(core.operationsPolicy().revision,revision+1);assert.equal(core.revision(),input+1)
    }
    const before=core.operationsPolicy()
    store.prepare('UPDATE corePolicy SET enabled=1,targetAnalysts=999,allowAutomaticAccountGeneration=1,autoReplaceBannedAccounts=1,maxAccounts=999').run()
    assert.deepEqual(core.operationsPolicy(),before)
    assert.equal(core.policy().enabled,false);assert.equal(core.policy().targetAnalysts,0)
    assert.equal(core.runtimeSettings().enabled,undefined);assert.equal(core.runtimeSettings().maxAccounts,undefined)
    assert.throws(()=>core.updateOperationsPolicy({automationEnabled:true},before.revision-1),/CONFLICT/)
    assert.deepEqual(core.operationsPolicy(),before)
})

test('stale global target is derived; priority clipping, unknown role and execution blockers are explicit',()=>{
    const p=mergeOperationsPolicy(defaultOperationsPolicy,{automationEnabled:true,capacity:{minimum:99,target:9999,maximum:5},roles:{analyst:{target:3,maximum:3},reseller:{target:10,maximum:10}}})
    assert.equal(p.capacity.target,5)
    const e=effectiveOperationsPolicy(p);assert.equal(e.roles.analyst.target,3);assert.equal(e.roles.reseller.target,2)
    assert.equal(e.roles.reseller.configuredTarget,10);assert.equal(e.roles.reseller.scheduledTarget,10)
    assert.equal(e.roles.reseller.executable,false);assert.equal(e.roles.reseller.blocker,'TRADING_EXECUTION_DISABLED')
    assert.ok(e.roles.reseller.reasons.some(r=>r.code==='GLOBAL_CAPACITY_CLIPPED'))
    const unknown=mergeOperationsPolicy(p,{roles:{miner:{...p.roles.analyst,target:1,priority:1}}})
    assert.equal(effectiveOperationsPolicy(unknown).roles.miner.blocker,'UNSUPPORTED_OPERATIONAL_ROLE')
    assert.equal(operationsSetting('roles.miner.target').editable,false)
})

test('effective permission gates do not activate inert role, recovery, or stop settings',()=>{
    const p=mergeOperationsPolicy(defaultOperationsPolicy,{automationEnabled:true,reserve:{automaticAccountGeneration:true,maximumTotalAccounts:3},recovery:{autoReplaceBannedAccounts:true},roles:{reseller:{autoReplace:false,autoStart:false,stopMode:'immediate'}}})
    const active=effectiveOperationsPolicy(p);assert.equal(active.permissions.mayReplace,true)
    assert.equal(accountGenerationAllowance(active,{total:0,requested:1}).count,1)
    for(const effective of [effectiveOperationsPolicy({...p,automationEnabled:false}),effectiveOperationsPolicy({...p,maintenanceMode:true}),effectiveOperationsPolicy(p,new Date(),{keepStopped:true})]){
        assert.equal(effective.automationActive,false);assert.ok(Object.values(effective.permissions).every(v=>v===false))
        assert.equal(accountGenerationAllowance(effective,{total:0}).count,0)
    }
    assert.equal(coreCapabilities().gracefulManagedStop.supported,false)
    const zero=effectiveOperationsPolicy({...p,reserve:{...p.reserve,maximumTotalAccounts:0}})
    assert.equal(accountGenerationAllowance(zero,{total:0}).blocker,'ACCOUNT_TOTAL_LIMIT_REACHED')
})

test('setting metadata covers every control, separates domains, and filters hidden mirrors from a runtime save',()=>{
    const m=policySettingMetadata(policyFields,overrideFields,defaultOperationsPolicy)
    assert.equal(Object.keys(m.core).length,Object.keys(policyFields).length)
    for(const path of ['health.quarantineUnhealthyAccounts','roles.reseller.autoReplace','recovery.restartWindowMs']){
        assert.equal(m.operations[path].status,'UNSUPPORTED');assert.equal(m.operations[path].editable,false)
        assert.match(metadataHelp(m.operations[path]),/Не підтримується.*Споживач/)
    }
    assert.equal(m.operations['transitions.startIntervalMs'].status,'SUPPORTED')
    assert.equal(m.operations['stability.minimumBotRuntimeMs'].status,'SUPPORTED')
    assert.equal(m.operations['recovery.restartOnCrash'].status,'PARTIALLY_SUPPORTED')
    assert.equal(m.core.antiAfkEnabled.domain,'runtime');assert.equal(m.core.autoAnalysis.domain,'market')
    assert.deepEqual(explicitPolicyChanges({enabled:true,targetAnalysts:99,antiAfkEnabled:false},{enabled:false,targetAnalysts:1,antiAfkEnabled:true},m.core),{antiAfkEnabled:false})
})

for(const mode of ['old-only','operations-only','conflicting'])test(`v8 ${mode} migration preserves originals, diagnoses conflicts and is idempotent`,async t=>{
    const original=mergeOperationsPolicy(defaultOperationsPolicy,{automationEnabled:true,capacity:{maximum:10},roles:{analyst:{target:1,maximum:1},reseller:{target:9,maximum:9}},reserve:{automaticAccountGeneration:true,maximumTotalAccounts:100},recovery:{autoReplaceBannedAccounts:true}})
    const {store,core,dir,config}=await fixture(t,db=>{
        if(mode!=='operations-only')db.exec('UPDATE corePolicy SET enabled=1,targetAnalysts=2,targetResellers=7,autoReplaceBannedAccounts=1,allowAutomaticAccountGeneration=0,maxAccounts=20')
        if(mode!=='old-only')db.prepare('UPDATE operationsPolicy SET document=?').run(JSON.stringify(original))
    })
    const p=core.operationsPolicy(),report=core.canonicalization()
    assert.equal(p.roles.analyst.target,mode==='old-only'?2:1)
    assert.equal(p.roles.reseller.target,mode==='old-only'?7:9)
    assert.equal(p.recovery.autoReplaceBannedAccounts,mode!=='operations-only')
    assert.equal(p.reserve.automaticAccountGeneration,mode==='operations-only')
    assert.equal(effectiveOperationsPolicy(p).roles.reseller.executable,false)
    assert.ok(report.diagnostics.length>0)
    assert.deepEqual(report.original.operations,mode==='old-only'?{}:original)
    assert.equal(store.prepare('SELECT password FROM accountsData').get().password,'fixture-secret')
    assert.equal(store.prepare('SELECT count(*) n FROM coreDecisionJournal').get().n,0)
    assert.equal(store.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(),[])
    const revision=core.revision();store.close();await store.init()
    assert.deepEqual(core.operationsPolicy(),p);assert.equal(core.revision(),revision);assert.deepEqual(core.canonicalization(),report)
    const backups=await readdir(path.join(dir,'backups'));assert.equal(backups.length,1)
    const backup=new DatabaseSync(path.join(dir,'backups',backups[0],'afina-before-v16.db'),{readOnly:true})
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,8);backup.close()
})
