import test from "node:test"
import assert from "node:assert/strict"
import BotConfigurationService from "../src/botManager/botConfigurationService.js"

function fixture(t, autoRestart = false){
    const definitions = [1, 2, 3].map(botId => ({botId, connectedAccountId: botId, serverId: botId === 3 ? 2 : 1, realm: 101}))
    const accounts = [1, 2, 3].map(accountId => ({accountId, serverId: accountId === 3 ? 2 : 1}))
    const tasks = [1, 2, 3].map(accountId => ({accountId, type: accountId === 2 ? "test" : "reseller", itemId: accountId}))
    const items = [1, 2, 3].map(itemId => ({itemId, name: "item"}))
    const servers = [{serverId: 1, version: "1"}, {serverId: 2, version: "1"}]
    const settings = [{settingName: "delay", value: 100}]
    const workers = new Map(definitions.map(d => [d.botId, {botId: d.botId, desiredState: d.botId === 3 ? "stopped" : "running", supervisorStatus: "running"}]))
    const restarted = []
    const manager = {
        async synchronizeDefinitions(){}, getBotDefinitions: () => definitions,
        getBot: id => workers.get(id), restartBot: async id => restarted.push(id)
    }
    const dataBaseManager = {
        getConfigurationSnapshot(){
            return {revision:JSON.stringify({definitions,accounts,tasks,items,servers,settings}), configurations:new Map(definitions.map(definition => {
                const account=accounts.find(a=>a.accountId===definition.connectedAccountId)
                const task=tasks.find(a=>a.accountId===definition.botId)
                return [definition.botId,structuredClone({definition,accountData:{...account,realm:definition.realm},taskData:{...task,item:items.find(i=>i.itemId===task.itemId)},serverData:servers.find(s=>s.serverId===definition.serverId),settings:Object.fromEntries(settings.map(s=>[s.settingName,s.value]))})]
            }))}
        },
        getBotData: async id => definitions.find(d => d.botId === id),
        getAccountData: async id => accounts.find(a => a.accountId === id),
        getTasksData: async id => tasks.find(a => a.accountId === id),
        getItemData: async id => items.find(a => a.itemId === id),
        getServerData: async id => servers.find(a => a.serverId === id),
        getResellerSettings: async () => settings
    }
    const service = new BotConfigurationService({botManager: manager, dataBaseManager, eventBus: {publish(){}}, logger: {child(){return {error(){}}}}, config: {autoRestartOnSettingsChange: autoRestart}})
    t.after(() => service.destroy())
    return {service, definitions, accounts, tasks, items, servers, settings, workers, restarted}
}

test("dependency changes mark only affected bots; restart uses latest data and clears marker on ready", async t => {
    const f = fixture(t)
    await f.service.sync()
    f.items[0].name = "changed"
    await f.service.sync()
    assert.equal(f.service.status(1).restartRequired, true)
    assert.equal(f.service.status(2).restartRequired, false)
    assert.equal(f.service.status(3).restartRequired, false)
    const worker = f.workers.get(1)
    await f.service.prepare(worker)
    assert.equal(worker.taskData.item.name, "changed")
    assert.equal(f.service.status(1).restartRequired, true)
    f.service.applied(worker)
    assert.equal(f.service.status(1).restartRequired, false)
    f.servers[0].version = "2"
    await f.service.sync()
    assert.equal(f.service.status(1).restartRequired, true)
    assert.equal(f.service.status(2).restartRequired, true)
    assert.equal(f.service.status(3).restartRequired, false)
    assert.deepEqual(f.restarted, [])
})

test("global behavior settings skip test bots; auto restart never starts stopped bots", async t => {
    const f = fixture(t, true)
    t.mock.timers.enable({apis: ["setTimeout"]})
    await f.service.sync()
    f.settings[0].value = 200
    await f.service.sync()
    assert.equal(f.service.status(1).restartRequired, true)
    assert.equal(f.service.status(2).restartRequired, false)
    assert.equal(f.service.status(3).restartRequired, true)
    t.mock.timers.tick(800)
    await Promise.resolve()
    assert.deepEqual(f.restarted, [1])
    await f.service.sync()
    t.mock.timers.tick(800)
    await Promise.resolve()
    assert.deepEqual(f.restarted, [1])
})

test("changes during startup remain pending and reverted edits clear marker", async t => {
    const f = fixture(t)
    await f.service.sync()
    f.definitions[0].realm = 2
    await f.service.sync()
    await f.service.prepare(f.workers.get(1))
    f.definitions[0].realm = 3
    await f.service.sync()
    f.service.applied(f.workers.get(1))
    assert.equal(f.service.status(1).restartRequired, true)
    f.definitions[0].realm = 2
    await f.service.sync()
    assert.equal(f.service.status(1).restartRequired, false)
})

test('inventory operational block cancels a scheduled configuration restart',async t=>{
    const f=fixture(t,true);t.mock.timers.enable({apis:['setTimeout']})
    await f.service.sync();f.settings[0].value=200;await f.service.sync()
    f.workers.get(1).operationalBlock={type:'INVENTORY_BLOCKED_BY_IGNORED_ITEMS'}
    t.mock.timers.tick(800);await Promise.resolve();assert.deepEqual(f.restarted,[])
    await f.service.sync();t.mock.timers.tick(800);await Promise.resolve();assert.deepEqual(f.restarted,[])
})
