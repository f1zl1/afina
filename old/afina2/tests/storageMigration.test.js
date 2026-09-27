import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {DatabaseSync} from "node:sqlite"
import DatabaseStore from "../src/data/databaseStore.js"
import DataBaseManager from "../src/data/dataBaseManagerMain.js"
import DatabaseEditor from "../src/data/databaseEditor.js"
import BotConfigurationService from "../src/botManager/botConfigurationService.js"
import {schema,addChangeTracking,upgradeToVersion2,upgradeToVersion3} from "../src/data/databaseSchema.js"

test("version 3 upgrade adds disabled Core and preserves Telegram and task data",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'afina-v4-'))
    const config={databasePath:path.join(dir,'afina.db')}
    const old=new DatabaseSync(config.databasePath)
    old.exec(schema)
    addChangeTracking(old)
    upgradeToVersion2(old)
    upgradeToVersion3(old)
    old.exec("INSERT INTO schemaMigrations VALUES(3,'before'); PRAGMA user_version=3")
    seed(old)
    old.exec("INSERT INTO telegramAccounts(telegramAccountId,phone,session,status) VALUES(1,'+4700000000','fixture-session','disconnected'); UPDATE accountsData SET telegramAccountId=1 WHERE accountId=1")
    const before=old.prepare('SELECT * FROM tasksData ORDER BY taskId').all()
    old.close()
    const store=new DatabaseStore(config)
    t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true})})
    await store.init()
    assert.equal(store.prepare('PRAGMA user_version').get().user_version,16)
    assert.equal(store.prepare('SELECT enabled FROM corePolicy').get().enabled,0)
    assert.equal(store.prepare('SELECT session FROM telegramAccounts').get().session,'fixture-session')
    assert.equal(store.prepare('SELECT telegramAccountId FROM accountsData WHERE accountId=1').get().telegramAccountId,1)
    assert.deepEqual(store.prepare('SELECT * FROM tasksData ORDER BY taskId').all(),before)
    assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(),[])
    assert.equal((await fs.readdir(path.join(dir,'backups'))).length,1)
})

const logger={child(){return this},info(){},warn(){},error(){}}
async function fixture(t){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"afina-storage-"))
    const manager=new DataBaseManager({config:{databasePath:path.join(dir,"afina.db")},logger})
    await manager.init()
    t.after(async()=>{manager.close();await fs.rm(dir,{recursive:true,force:true})})
    return {manager,db:manager.store.db,dir}
}
function seed(db){
    db.exec(`
        INSERT INTO serverData VALUES(1,'test','1','Test');
        INSERT INTO accountsData(accountId,username,password) VALUES(1,'one','secret-one'),(2,'two','secret-two');
        INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(1,'Bot',1,1,101);
        INSERT INTO itemsData(itemId,name,searchQuery,matcher) VALUES(1,'item','item','{}');
        INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne) VALUES(1,'reseller',1,10,20);
        INSERT INTO resellerSettings(settingName,settingType,settingValue) VALUES('delay','integer','100');
    `)
}

test("rotation is atomic and preserves bot-owned target and task; constraints apply outside editor",async t=>{
    const {manager,db}=await fixture(t)
    seed(db)
    const task=await manager.getTasksData(1)
    const result=manager.assignAvailableAccount(1,{rotate:true,oldAccountAction:'blocked'})
    assert.equal(result.accountId,2)
    assert.deepEqual(await manager.getTasksData(1),task)
    assert.equal((await manager.getBotData(1)).realm,101)
    assert.equal((await manager.getAccountPoolState(1)).status,'blocked')
    assert.throws(()=>manager.assignAvailableAccount(1,{rotate:true}),/unchanged/)
    assert.equal((await manager.getBotData(1)).connectedAccountId,2)
    assert.throws(()=>db.exec("INSERT INTO botData(connectedAccountId) VALUES(2)"),/UNIQUE/)
    assert.throws(()=>db.exec("INSERT INTO tasksData(botId) VALUES(1)"),/UNIQUE/)
    assert.throws(()=>db.exec("UPDATE botData SET serverId=999 WHERE botId=1"),/FOREIGN KEY/)
    assert.throws(()=>db.exec("UPDATE tasksData SET type='nonsense'"),/CHECK/)
})

test("effective settings precedence, cached snapshots, external write detection and redacted history",async t=>{
    const {manager,db}=await fixture(t)
    seed(db)
    db.exec(`INSERT INTO settingProfiles VALUES(1,'Profile','');
        UPDATE botData SET settingsProfileId=1;
        INSERT INTO profileSettings(profileId,settingName,settingValue) VALUES(1,'delay','200');
        INSERT INTO botSettings(botId,settingName,settingValue) VALUES(1,'delay','300')`)
    const first=manager.getConfigurationSnapshot()
    assert.equal(first.configurations.get(1).settings.delay,300)
    assert.equal(manager.getConfigurationSnapshot(),first)
    const external=new DatabaseSync(manager.config.databasePath)
    external.exec("UPDATE botSettings SET settingValue='400'")
    external.close()
    const second=manager.getConfigurationSnapshot()
    assert.notEqual(first,second)
    assert.equal(second.configurations.get(1).settings.delay,400)
    db.exec("DELETE FROM botSettings")
    assert.equal(manager.getConfigurationSnapshot().configurations.get(1).settings.delay,200)
    const log=JSON.stringify(db.prepare('SELECT * FROM changeLog').all())
    assert.equal(log.includes('secret-one'),false)
    const editor=new DatabaseEditor({store:manager.store})
    assert.equal(editor.read({database:'history',table:'changeLog'}).readOnly,true)
    assert.throws(()=>editor.mutate({database:'history',table:'changeLog',operation:'insert',values:{}}),/read-only/)
    assert.throws(()=>editor.read({database:'history',table:'legacyImportRecords'}),/Unknown table/)
})

test("unchanged configuration poll uses one revision query, no per-bot reads",async t=>{
    const {manager,db}=await fixture(t)
    seed(db)
    const service=new BotConfigurationService({dataBaseManager:manager,logger,eventBus:{publish(){}},botManager:{
        synchronizeDefinitions:async()=>{},getBotDefinitions:()=>[{botId:1}],getBot:()=>null
    }})
    t.after(()=>service.destroy())
    await service.sync()
    const original=manager.store.prepare.bind(manager.store)
    let calls=0
    manager.store.prepare=sql=>{calls++;return original(sql)}
    await service.sync()
    assert.equal(calls,1)
})

test("migration preserves duplicate assignments and orphan tasks in archives; import is idempotent",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"afina-migration-"))
    const legacyPaths={}
    const scripts={
        serversPath:"CREATE TABLE serverData(serverId INTEGER,serverIp TEXT,version TEXT,serverName TEXT); INSERT INTO serverData VALUES(1,'test','1','Test')",
        accountsPath:"CREATE TABLE accountsData(accountId INTEGER,username TEXT,password TEXT,realm INTEGER,serverId INTEGER,status TEXT,createdAt TEXT); INSERT INTO accountsData VALUES(1,'one','secret',101,1,'offline','0'),(2,'two','other',102,1,'banned','0')",
        botsPath:"CREATE TABLE botData(botId INTEGER,connectedAccountId INTEGER,type TEXT,archived INTEGER); INSERT INTO botData VALUES(1,1,'reseller',0),(2,1,'reseller',0)",
        itemsPath:"CREATE TABLE itemsData(itemId INTEGER,name TEXT,searchQuery TEXT,matcher TEXT); INSERT INTO itemsData VALUES(1,'item','item','{}')",
        tasksPath:"CREATE TABLE tasksData(accountId INTEGER,type TEXT,itemId INTEGER,buyPricePerOne INTEGER,sellPricePerOne INTEGER,status TEXT,createdAt INTEGER); INSERT INTO tasksData VALUES(1,'null',1,10,20,'active',0),(2,'afk',1,10,20,'active',0)",
        resellerSettingsPath:"CREATE TABLE resellerSettings(id INTEGER,settingName TEXT,settingDescription TEXT,settingType TEXT,settingValue TEXT,category TEXT,updatedAt TEXT); INSERT INTO resellerSettings VALUES(1,'delay','','integer','100','general','0')"
    }
    for(const [key,sql] of Object.entries(scripts)){
        legacyPaths[key]=path.join(dir,key+'.db')
        const source=new DatabaseSync(legacyPaths[key]);source.exec(sql);source.close()
    }
    const before=await Promise.all(Object.values(legacyPaths).map(file=>fs.readFile(file)))
    const config={databasePath:path.join(dir,'unified.db'),legacyPaths}
    const store=new DatabaseStore(config)
    t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true})})
    await store.init()
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasksData').get().n,3)
    assert.equal(store.db.prepare('SELECT type FROM tasksData WHERE botId=1').get().type,'test')
    assert.equal(store.db.prepare('SELECT connectedAccountId FROM botData WHERE botId=2').get().connectedAccountId,null)
    assert.equal(store.db.prepare('SELECT status FROM accountPoolState WHERE accountId=2').get().status,'blocked')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM legacyImportRecords').get().n,9)
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0)
    const backups=await fs.readdir(path.join(dir,'backups'))
    assert.equal((await fs.readdir(path.join(dir,'backups',backups[0]))).length,6)
    store.close();await store.init()
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasksData').get().n,3)
    const after=await Promise.all(Object.values(legacyPaths).map(file=>fs.readFile(file)))
    before.forEach((buffer,index)=>assert.deepEqual(buffer,after[index]))
})

test("failed migration rolls back and does not mark schema as applied",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"afina-failed-migration-"))
    const file=path.join(dir,'legacy.db')
    const source=new DatabaseSync(file)
    source.exec("CREATE TABLE itemsData(itemId INTEGER,name TEXT,searchQuery TEXT,matcher TEXT); INSERT INTO itemsData VALUES(1,'item','item','bad json')")
    source.close()
    const store=new DatabaseStore({databasePath:path.join(dir,'unified.db'),legacyPaths:{itemsPath:file}})
    t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true})})
    await assert.rejects(store.init(),/rolled back/)
    const target=new DatabaseSync(path.join(dir,'unified.db'))
    assert.equal(target.prepare('PRAGMA user_version').get().user_version,0)
    assert.equal(target.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table'").get().n,0)
    target.close()
})

test("version 1 upgrade preserves existing unified data and creates a backup",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"afina-v2-"))
    const config={databasePath:path.join(dir,"afina.db")}
    const old=new DatabaseSync(config.databasePath)
    old.exec(schema)
    addChangeTracking(old)
    old.exec("INSERT INTO schemaMigrations VALUES(1,'before'); PRAGMA user_version=1")
    seed(old)
    old.close()
    const store=new DatabaseStore(config)
    t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true})})
    await store.init()
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,16)
    assert.equal(store.db.prepare('SELECT password FROM accountsData WHERE accountId=1').get().password,'secret-one')
    const backups=await fs.readdir(path.join(dir,'backups'))
    assert.equal((await fs.readdir(path.join(dir,'backups',backups[0])))[0],'afina-before-v16.db')
    assert.throws(()=>store.db.exec("INSERT INTO botSettings(botId,settingName,settingValue) VALUES(1,'delay','wrong')"),/Override/)
    store.db.exec("INSERT INTO botSettings(botId,settingName,settingValue) VALUES(1,'delay','200')")
    assert.throws(()=>store.db.exec("UPDATE resellerSettings SET settingType='boolean',settingValue='true'"),/incompatible/)
})

test("configuration snapshot uses a fixed query count for 1000 bots",async t=>{
    const {manager,db}=await fixture(t)
    seed(db)
    const insert=manager.query("INSERT INTO botData(botId,name,serverId,realm) VALUES(?,?,1,101)")
    const task=manager.query("INSERT INTO tasksData(botId,type) VALUES(?,'test')")
    manager.store.transaction(()=>{for(let id=2;id<=1000;id++){insert.run(id,'Bot '+id);task.run(id)}})
    const original=manager.store.prepare.bind(manager.store)
    let queries=0
    manager.store.prepare=sql=>{queries++;return original(sql)}
    const snapshot=manager.getConfigurationSnapshot()
    assert.equal(snapshot.configurations.size,1000)
    assert.ok(queries<=12,`Unexpected query count: ${queries}`)
    const count=queries
    assert.equal(manager.getConfigurationSnapshot(),snapshot)
    assert.equal(queries-count,1)
})
