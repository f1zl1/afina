import test from "node:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import BotManager from "../src/botManager/botManagerMain.js"
import BotProcess from "../src/botManager/botProcess.js"
import BotConfigurationService from "../src/botManager/botConfigurationService.js"

test("cancelled autonomous launch after configuration loading never spawns or reconnects",async t=>{
    const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){}}
    const manager=new BotManager({logger,eventBus:{publish(){}}})
    t.after(()=>clearInterval(manager.heartbeatTimer))
    let allowed=true,starts=0
    const bot={botId:1,accountId:1,desiredState:'stopped',supervisorStatus:'offline',isRunning:()=>false,start(){starts++}}
    manager.definitions.set(1,{botId:1})
    manager.bots.set(1,bot)
    manager.configurationService={async prepare(){allowed=false}}
    await assert.rejects(manager.startBot(1,()=>{if(!allowed) throw new Error('STALE_REVISION')}),/STALE_REVISION/)
    assert.equal(starts,0)
    assert.equal(bot.desiredState,'stopped')
    assert.equal(bot.supervisorStatus,'stopped')
    assert.equal(bot.startingConfiguration,false)
    assert.ok(!bot.reconnectTimer)
})

test("BotManager manual restart reloads account, task, item, server and settings before worker start", async t => {
    const logger = {child(){return this}, withContext(){return this}, info(){}, warn(){}, error(){}}
    const eventBus = {on(){}, publish(){}}
    let realm = 1
    let price = 10
    let delay = 100
    const dataBaseManager = {
        getConfigurationSnapshot(){return {revision: `${realm}:${price}:${delay}`,configurations:new Map([[1,{
            definition:{botId:1,connectedAccountId:1,serverId:1,realm},
            accountData:{accountId:1,serverId:1,realm},
            taskData:{botId:1,type:"reseller",itemId:1,buyPricePerOne:price,item:{itemId:1,name:"item"}},
            serverData:{serverId:1,version:"1"},settings:{delay}
        }]])}},
        getAllBotsData: async () => [{botId: 1, connectedAccountId: 1, type: "reseller"}],
        getBotData: async () => ({botId: 1, connectedAccountId: 1, type: "reseller"}),
        getAccountData: async () => ({accountId: 1, serverId: 1, realm}),
        getTasksData: async () => ({accountId: 1, type: "reseller", itemId: 1, buyPricePerOne: price}),
        getItemData: async () => ({itemId: 1, name: "item"}),
        getServerData: async () => ({serverId: 1, version: "1"}),
        getResellerSettings: async () => [{settingName: "delay", value: delay}]
    }
    const resellerSettingsStore = {getAll: () => ({delay: 1})}
    const starts = []
    const originalStart = BotProcess.prototype.start
    const originalStop = BotProcess.prototype.stop
    BotProcess.prototype.start = function(){
        this.process = {}
        starts.push(structuredClone({account: this.accountData, task: this.taskData, settings: this.resellerSettings}))
        this.emit("ready", {workerPid: 1, startedAt: Date.now()})
    }
    BotProcess.prototype.stop = function(){
        this.process = null
        this.emit("exit", {code: 0, reason: "manual_restart"})
    }
    const manager = new BotManager({logger, eventBus, dataBaseManager, resellerSettingsStore})
    const service = new BotConfigurationService({botManager: manager, dataBaseManager, resellerSettingsStore, eventBus, logger})
    manager.configurationService = service
    t.after(() => {
        clearInterval(manager.heartbeatTimer)
        service.destroy()
        BotProcess.prototype.start = originalStart
        BotProcess.prototype.stop = originalStop
    })
    await manager.loadBots()
    await service.sync()
    await manager.startBot(1)
    await setImmediate()
    assert.equal(starts.length, 1)
    realm = 2
    price = 20
    delay = 200
    await service.sync()
    assert.equal(manager.getBotRuntimeState(1).configuration.restartRequired, true)
    await manager.restartBot(1)
    await setImmediate()
    assert.equal(starts.length, 2)
    assert.equal(starts[1].account.realm, 2)
    assert.equal(starts[1].task.buyPricePerOne, 20)
    assert.equal(starts[1].settings.delay, 200)
    assert.equal(manager.getBotRuntimeState(1).configuration.restartRequired, false)
})
