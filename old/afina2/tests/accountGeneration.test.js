import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import DataBaseManager from "../src/data/dataBaseManagerMain.js"
import Core from "../src/core/coreMain.js"
import {generateCredentials} from "../src/accounts/accountCredentials.js"

const logger={child(){return this},info(){},warn(){},error(){}}
async function fixture(t){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"afina-generation-"))
    const manager=new DataBaseManager({config:{databasePath:path.join(dir,"afina.db")},logger})
    await manager.init()
    t.after(async()=>{manager.close();await fs.rm(dir,{recursive:true,force:true})})
    return manager
}

test("credentials use readable ASCII nicknames and independently random passwords",()=>{
    const passwords=new Set()
    for(let index=0;index<1000;index++){
        const {username,password}=generateCredentials()
        assert.match(username,/^[A-Za-z][A-Za-z0-9_]{2,15}$/)
        assert.match(username,/[A-Za-z]{3}/)
        assert.match(password,/^[A-Za-z0-9]{24}$/)
        assert.match(password,/[a-z]/)
        assert.match(password,/[A-Z]/)
        assert.match(password,/[0-9]/)
        passwords.add(password)
    }
    assert.equal(passwords.size,1000)
})

test("batch generation creates complete available accounts without leaking passwords",async t=>{
    const manager=await fixture(t)
    const events=[]
    const core=new Core({logger,dataBaseManager:manager,eventBus:{publish:(...args)=>events.push(args)}})
    const response=await core.executeCommand({command:"accounts.generate",payload:{count:100}})
    assert.equal(response.ok,true)
    assert.equal(response.data.count,100)
    const accounts=await manager.getAllAccountsData()
    const states=await manager.getAllAccountPoolStates()
    assert.equal(accounts.length,100)
    assert.equal(states.length,100)
    assert.equal(new Set(accounts.map(a=>a.username.toLowerCase())).size,100)
    assert.ok(states.every(s=>s.status==='available' && s.failureCount===0 && s.cooldownUntil===null && s.lastUsedAt===null && s.updatedAt))
    assert.ok(accounts.every(a=>a.createdAt && !JSON.stringify(response).includes(a.password)))
    const logs=JSON.stringify(manager.store.db.prepare('SELECT * FROM changeLog').all())
    assert.ok(accounts.every(a=>!logs.includes(a.password)))
    assert.equal(events.length,2)
    manager.store.db.exec("INSERT INTO botData(botId,name) VALUES(1,'New bot')")
    assert.ok(manager.assignAvailableAccount(1).accountId)
})

test("case-insensitive collisions retry, and any failure rolls back the entire batch",async t=>{
    const manager=await fixture(t)
    const password='Aa'+'1'.repeat(22)
    manager.createGeneratedAccounts(1,()=>({username:'MiloRiver',password}))
    let attempts=0
    const result=manager.createGeneratedAccounts(1,()=>({username:++attempts===1?'miloriver':'AlexStone',password}))
    assert.equal(attempts,2)
    assert.equal(result[0].username,'AlexStone')
    const revision=manager.store.revision()
    let generated=0
    assert.throws(()=>manager.createGeneratedAccounts(2,()=>{
        if(generated++) throw new Error('simulated generator failure')
        return {username:'QuietFox',password}
    }),/simulated/)
    assert.equal((await manager.getAllAccountsData()).length,2)
    assert.equal((await manager.getAllAccountPoolStates()).length,2)
    assert.equal(manager.store.revision(),revision)
    assert.throws(()=>manager.createGeneratedAccounts(1,()=>({username:'MILORIVER',password})))
    for(const count of [0,-1,101,1.5,'2',null]) assert.throws(()=>manager.createGeneratedAccounts(count))
})
