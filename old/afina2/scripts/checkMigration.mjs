import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import DataBaseManager from "../src/data/dataBaseManagerMain.js"
import {DatabaseSync,backup} from "node:sqlite"

const config=JSON.parse(await fs.readFile("src/config/dataBaseManager.json","utf8"))
const directory=await fs.mkdtemp(path.join(os.tmpdir(),"afina-migration-preview-"))
const manager=new DataBaseManager({config:{...config,databasePath:path.join(directory,"afina.db")},logger:{child(){return {}}}})
let sourceKind="legacy-import"
try{
    try{
        await fs.access(config.databasePath)
        const source=new DatabaseSync(config.databasePath,{readOnly:true})
        try{await backup(source,manager.config.databasePath)}finally{source.close()}
        sourceKind="existing-unified"
    }catch(error){if(error.code !== "ENOENT") throw error}
    await manager.init()
    const db=manager.store.db
    const counts={}
    for(const table of ["accountsData","botData","tasksData","itemsData","serverData","resellerSettings","legacyImportRecords"]){
        counts[table]=db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    }
    const report={
        checkedAt:new Date().toISOString(),sourceKind,schemaVersion:db.prepare("PRAGMA user_version").get().user_version,
        counts,integrity:db.prepare("PRAGMA integrity_check").get().integrity_check,
        foreignKeyErrors:db.prepare("PRAGMA foreign_key_check").all(),
        issues:db.prepare("SELECT entity,message FROM migrationIssues").all(),
        bots:db.prepare("SELECT botId,connectedAccountId,serverId,realm FROM botData").all(),
        tasks:db.prepare("SELECT taskId,botId,type FROM tasksData").all()
    }
    const snapshot=manager.getConfigurationSnapshot()
    if([...snapshot.configurations.values()].some(c=>c.error)) throw new Error("Invalid imported configuration")
    await fs.mkdir("artifacts",{recursive:true})
    await fs.writeFile("artifacts/migration-preview.json",JSON.stringify(report,null,2))
    console.log(JSON.stringify(report,null,2))
}finally{
    manager.close()
    await fs.rm(directory,{recursive:true,force:true})
}
