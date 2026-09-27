import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import DatabaseStore from '../src/data/databaseStore.js'
import TradingPlanner,{tradingPlan} from '../src/core/tradingPlanner.js'
import {marketDefaults} from '../src/core/market/marketConfig.js'
import {classifyLots,summarizeObservation,modelFromHistory,withAge} from '../src/core/market/marketStatistics.js'
import {fixture as economicFixture} from './helpers/economicFixture.js'
import {coreCapabilities} from '../src/core/coreCapabilities.js'
import CoreDecisionEngine from '../src/core/coreDecisionEngine.js'
import {foundationEngines} from '../src/core/economicContracts.js'

const now=1000000,policy={...marketDefaults,maxResellersPerItem:5}
const item={itemId:1,name:'Apple',searchQuery:'apple',matcher:'{"minecraftName":"apple"}'}
function model(at=now){
    const lots=Array.from({length:20},(_,i)=>({amount:1,totalPrice:1000,seller:'Seller'+i}))
    lots.push({amount:4,totalPrice:2000,seller:'Wholesaler'},{amount:1,totalPrice:100000000,seller:'Outlier'})
    const summary=summarizeObservation(classifyLots(lots,new Set(),policy))
    return withAge({...modelFromHistory(summary,Array(5).fill(summary)),itemId:1,serverId:1,realm:101,lastObservedAt:at},policy,at)
}
const plan=(patch={})=>tradingPlan({item,model:model(),policy,now,...patch})
const hold=(p,code)=>{assert.equal(p.decision,'HOLD');assert.ok(p.reasons.includes(code),JSON.stringify(p.reasons));assert.equal(p.targetQuantity,0)}

test('profitable observed wholesale lot produces integer-safe BUY_RESELL terms',()=>{
    const p=plan();assert.equal(p.decision,'BUY_RESELL');assert.equal(p.maxBuyPricePerItem,500);assert.equal(p.targetSellPricePerItem,1000)
    assert.equal(p.targetQuantity,4);assert.equal(p.expectedProfitPerItem,500);assert.equal(p.expectedMargin,1);assert.deepEqual(p.reasons,['PROFITABLE_SPREAD'])
    assert.equal(p.sourceTimestamp,now);assert.equal(p.expiresAt,now+policy.marketFreshMs)
})
test('missing model holds',()=>hold(plan({model:null}),'MARKET_UNAVAILABLE'))
test('no spread holds',()=>hold(plan({model:{...model(),potentialWholesaleOpportunities:[]}}),'NO_PROFITABLE_SPREAD'))
test('stale and reanalysis models hold',()=>{for(const freshness of ['stale','aging','requires_reanalysis'])hold(plan({model:{...model(),freshness}}),'DATA_STALE')})
test('future evidence is contradictory and holds',()=>hold(plan({model:{...model(),lastObservedAt:now+1}}),'DATA_STALE'))
test('low confidence holds',()=>hold(plan({model:{...model(),confidence:49}}),'LOW_CONFIDENCE'))
test('disabled item holds',()=>hold(plan({override:{disabled:true}}),'ITEM_DISABLED'))
test('maxBots zero is zero allocation, not unlimited',()=>hold(plan({override:{maxBots:0}}),'ITEM_MAX_BOTS_LIMIT'))
test('maximum buy bound holds below available lot price and allows equality',()=>{hold(plan({override:{maxBuyPrice:499.9}}),'MAX_BUY_PRICE');assert.equal(plan({override:{maxBuyPrice:500}}).maxBuyPricePerItem,500)})
test('sell floor cannot inflate a market-derived target',()=>{hold(plan({override:{minSellPrice:1001}}),'MIN_SELL_PRICE');assert.equal(plan({override:{minSellPrice:1000}}).targetSellPricePerItem,1000)})
test('non-positive profit and inconsistent opportunity spread rejected',()=>{for(const pricePerItem of [1000,1001,800])hold(plan({model:{...model(),potentialWholesaleOpportunities:[{amount:1,pricePerItem}]}}),'NO_PROFITABLE_SPREAD')})
test('outlier is excluded and cannot set sell price',()=>{assert.equal(model().excludedHighOutlierCount,1);assert.equal(plan().targetSellPricePerItem,1000)})
test('insufficient retail support cannot set price',()=>hold(plan({model:{...model(),retail:{lotCount:1,medianPricePerItem:1000}}}),'PRICES_UNAVAILABLE'))
test('whole-lot quantity is bounded, never truncated to fit',()=>{hold(plan({model:{...model(),potentialWholesaleOpportunities:[{amount:65,pricePerItem:500}]}}),'INSUFFICIENT_SUPPLY');assert.equal(plan({model:{...model(),independentSupply:100,potentialWholesaleOpportunities:[{amount:64,pricePerItem:500}]}}).targetQuantity,64)})
test('purchase commitment and safe integer limits reject oversized opportunities',()=>{
    const m={...model(),retail:{lotCount:20,medianPricePerItem:1000000000},independentSupply:100,potentialWholesaleOpportunities:[{amount:64,pricePerItem:500000000}]}
    assert.equal(plan({model:m}).decision,'HOLD');m.potentialWholesaleOpportunities[0].amount=2;assert.equal(plan({model:m}).targetQuantity,2)
})
test('fractional price rounds buy up and sell down',()=>{const m=model();m.potentialWholesaleOpportunities[0].pricePerItem=500.1;m.retail.medianPricePerItem=1000.9;const p=plan({model:m});assert.equal(p.maxBuyPricePerItem,501);assert.equal(p.targetSellPricePerItem,1000)})
test('unsupported item contract holds',()=>hold(plan({item:{...item,matcher:'{}'}}),'INVALID_ITEM'))
test('reasons have deterministic order',()=>{const args={override:{disabled:true,maxBots:0},model:{...model(),freshness:'stale',confidence:0}};assert.deepEqual(plan(args).reasons,plan(args).reasons)})
test('disabled and zero-allocation diagnostics do not request forced bots',()=>{
    for(const override of [{disabled:true,forcedBots:2},{maxBots:0}]){
        const result=new CoreDecisionEngine().evaluate({policy:{...policy,operations:{roles:{reseller:{target:5},analyst:{target:0}}}},overrides:[{itemId:1,...override}],actual:{items:[item],bots:[{task:{type:'reseller',enabled:1,itemId:1,buyPrice:10,sellPrice:20}}]},engines:foundationEngines()})
        const a=result.allocations[0];assert.equal(a.desiredBots,0);assert.equal(a.requested,0);assert.equal(a.maxBots,0);assert.ok(!a.reasons.some(r=>r.code==='USER_FORCED_BOTS'))
    }
})
test('confidence expiry precedes freshness when necessary',()=>{const m={...model(),confidenceBase:.52,confidence:52};const p=plan({model:m});assert.ok(p.expiresAt<now+policy.marketFreshMs);hold(plan({model:m,now:p.expiresAt}),'LOW_CONFIDENCE')})

async function fixture(t){
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-trading-')),config={databasePath:path.join(dir,'afina.db')},store=new DatabaseStore(config);await store.init()
    t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
    const args={items:[item],market:{revision:1,items:[model()]},overrides:[],policy,now}
    return {dir,config,store,args,evaluate:()=>new TradingPlanner(store).evaluate(args)}
}
test('unchanged inputs, clock aging and unrelated market revision coalesce',async t=>{const f=await fixture(t),first=f.evaluate();f.args.now+=1000;f.args.market.revision++;f.args.market.items[0].confidence-=.1;assert.equal(f.evaluate().plans[0].planId,first.plans[0].planId);assert.equal(f.evaluate().history.length,1)})
test('meaningful market update reevaluates',async t=>{const f=await fixture(t),first=f.evaluate();f.args.market.items[0].retail.medianPricePerItem=1100;assert.notEqual(f.evaluate().plans[0].planId,first.plans[0].planId)})
test('expired recommendation becomes HOLD once, without history churn',async t=>{const f=await fixture(t);const p=f.evaluate().plans[0];f.args.now=p.expiresAt;hold(f.evaluate().plans[0],'DATA_STALE');f.args.now++;assert.equal(f.evaluate().history.length,2)})
test('policy and item enable changes reevaluate',async t=>{const f=await fixture(t);f.evaluate();f.args.overrides=[{itemId:1,maxBuyPrice:400}];hold(f.evaluate().plans[0],'MAX_BUY_PRICE');f.args.overrides=[{itemId:1,disabled:true}];hold(f.evaluate().plans[0],'ITEM_DISABLED');f.args.overrides=[];assert.equal(f.evaluate().plans[0].decision,'BUY_RESELL');assert.equal(f.evaluate().history.length,4)})
test('plans survive restart and scope history is bounded',async t=>{const f=await fixture(t);for(let i=0;i<25;i++){f.args.market.items[0].retail.medianPricePerItem=1000+i;f.evaluate()}const first=f.evaluate();assert.equal(first.history.length,20);f.store.close();await f.store.init();assert.equal(f.evaluate().plans[0].planId,first.plans[0].planId);assert.equal(f.evaluate().history.length,20)})
test('separate realms never mix market terms',async t=>{const f=await fixture(t);f.args.market.items.push({...model(),realm:102,confidence:0});const result=f.evaluate();assert.equal(result.plans.length,2);assert.equal(result.plans[0].decision,'BUY_RESELL');hold(result.plans[1],'LOW_CONFIDENCE')})
test('v13 migration backs up, preserves rows, records v14 and reopens idempotently',async t=>{
    const f=await fixture(t);f.store.db.exec("INSERT INTO itemsData VALUES(1,'Apple','apple','{}'); DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; PRAGMA user_version=13");f.store.close();await f.store.init()
    assert.equal(f.store.prepare('PRAGMA user_version').get().user_version,16);assert.equal(f.store.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=14').get().n,1)
    assert.equal(f.store.prepare('SELECT name FROM itemsData').get().name,'Apple');assert.deepEqual(f.store.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.store.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
    const dirs=await readdir(path.join(f.dir,'backups'));const db=new DatabaseSync(path.join(f.dir,'backups',dirs[0],'afina-before-v16.db'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,13);db.close();f.store.close();await f.store.init();assert.equal((await readdir(path.join(f.dir,'backups'))).length,1)
})
test('v14 migration failure rolls back and can be repaired',async t=>{
    const f=await fixture(t);f.store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX economic_source_plan; DROP INDEX economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DELETE FROM schemaMigrations WHERE version=14; PRAGMA user_version=13');f.store.close();await assert.rejects(f.store.init())
    const db=new DatabaseSync(f.config.databasePath);assert.equal(db.prepare('PRAGMA user_version').get().user_version,13);assert.equal(db.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=14').get().n,0);db.exec('DROP TABLE tradingPlans');db.close();await f.store.init();assert.equal(f.evaluate().plans[0].decision,'BUY_RESELL')
})
test('Core recommendations never submit economic work; manual execution still works',async t=>{
    const f=await economicFixture(t,{transport:true});const m=model(Date.now());f.core.marketStore.ownNames();m.ownershipFingerprint=f.core.marketStore.namesFingerprint;m.segmentation={retailMax:policy.marketRetailMaxAmount,mediumMax:policy.marketMediumMaxAmount}
    f.store.prepare('INSERT INTO marketModels VALUES(?,?,?,?,?)').run(1,101,1,m.lastObservedAt,JSON.stringify(m));f.store.db.exec('UPDATE marketMetadata SET revision=revision+1')
    await f.core.evaluateNow();const snapshot=f.core.snapshot();assert.equal(snapshot.trading.plans[0].decision,'BUY_RESELL');assert.equal(snapshot.trading.executionEnabled,false);assert.equal(snapshot.trading.executionBlocker,'TRADING_EXECUTION_DISABLED')
    assert.equal(f.store.prepare('SELECT count(*) n FROM economicWorkloads').get().n,0);assert.equal(f.transactions.length,0)
    assert.equal(coreCapabilities().autonomousTradingExecution.blocker,'TRADING_EXECUTION_DISABLED');const result=await f.run();assert.equal(result.status,'COMPLETED');assert.deepEqual(f.transactions,['buy','list','list'])
})
test('market updates and expiration queue the existing Core scheduler',async t=>{
    const f=await economicFixture(t);const m=model(Date.now());f.core.marketStore.ownNames();m.ownershipFingerprint=f.core.marketStore.namesFingerprint;m.segmentation={retailMax:policy.marketRetailMaxAmount,mediumMax:policy.marketMediumMaxAmount}
    f.store.prepare('INSERT INTO marketModels VALUES(?,?,?,?,?)').run(1,101,1,m.lastObservedAt,JSON.stringify(m));f.store.db.exec('UPDATE marketMetadata SET revision=revision+1')
    const triggers=[];let expired
    const expiration=new Promise(resolve=>{expired=resolve})
    f.core.schedule=trigger=>{triggers.push(trigger.type);if(trigger.type==='TRADING_PLAN_EXPIRED')expired()}
    f.eventBus.publish('core.market.updated',{revision:1})
    assert.ok(triggers.includes('core.market.updated'))
    const shortPolicy={...f.core.store.runtimeSettings(),marketFreshMs:250}
    assert.equal(f.core.tradingSnapshot(shortPolicy).plans[0].decision,'BUY_RESELL')
    let timeout
    try{await Promise.race([expiration,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('expiry trigger missing')),2000)})])}finally{clearTimeout(timeout)}
    hold(f.core.tradingSnapshot(shortPolicy).plans[0],'DATA_STALE')
    assert.equal(f.store.prepare('SELECT count(*) n FROM economicWorkloads').get().n,0)
})
