import { DatabaseSync, backup } from "node:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { schema, schemaVersion, addChangeTracking, upgradeToVersion2, upgradeToVersion3, upgradeToVersion4, upgradeToVersion5, upgradeToVersion6, upgradeToVersion7, upgradeToVersion8, upgradeToVersion9, upgradeToVersion10, upgradeToVersion11, upgradeToVersion12, upgradeToVersion13, upgradeToVersion14, upgradeToVersion15, upgradeToVersion16 } from "./databaseSchema.js"

export async function migrateDatabase(db, config){
    const version = db.prepare("PRAGMA user_version").get().user_version
    if(version > schemaVersion) throw new Error("Database is newer than this application")
    if(version === schemaVersion) return
    if(version >= 1 && version < schemaVersion){
        const directory=path.join(path.dirname(config.databasePath),"backups",new Date().toISOString().replace(/[:.]/g,"-") + `-v${schemaVersion}`)
        await fs.mkdir(directory,{recursive:true})
        await backup(db,path.join(directory,`afina-before-v${schemaVersion}.db`))
        db.exec("BEGIN IMMEDIATE")
        try{
            if(version === 1){
                upgradeToVersion2(db)
                db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(2,new Date().toISOString())
            }
            if(version < 3){
                upgradeToVersion3(db)
                db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(3,new Date().toISOString())
            }
            if(version<4){
                upgradeToVersion4(db)
                db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(4,new Date().toISOString())
            }
            if(version<5){
                upgradeToVersion5(db)
                db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(5,new Date().toISOString())
            }
            if(version<6){upgradeToVersion6(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(6,new Date().toISOString())}
            if(version<7){upgradeToVersion7(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(7,new Date().toISOString())}
            if(version<8){upgradeToVersion8(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(8,new Date().toISOString())}
            if(version<9){upgradeToVersion9(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(9,new Date().toISOString())}
            if(version<10){upgradeToVersion10(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(10,new Date().toISOString())}
            if(version<11){upgradeToVersion11(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(11,new Date().toISOString())}
            if(version<12){upgradeToVersion12(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(12,new Date().toISOString())}
            if(version<13){upgradeToVersion13(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(13,new Date().toISOString())}
            if(version<14){upgradeToVersion14(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(14,new Date().toISOString())}
            if(version<15){upgradeToVersion15(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(15,new Date().toISOString())}
            upgradeToVersion16(db);db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(16,new Date().toISOString())
            if(db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Upgrade foreign key check failed")
            if(db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Upgrade integrity check failed")
            db.exec(`PRAGMA user_version=${schemaVersion}; COMMIT`)
            return
        }catch(error){db.exec("ROLLBACK");throw error}
    }
    if(version !== 0) throw new Error(`Unsupported database version: ${version}`)
    const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
    if(existing.length) throw new Error("Refusing to migrate an unversioned non-empty target database")

    const legacy = {}
    const backupDirectory = path.join(path.dirname(config.databasePath), "backups", new Date().toISOString().replace(/[:.]/g, "-"))
    for(const [key, file] of Object.entries(config.legacyPaths ?? {})){
        // A configured but missing source is an error, never an empty import.
        await fs.access(file)
        await fs.mkdir(backupDirectory, {recursive: true})
        const source = new DatabaseSync(file, {readOnly: true})
        const copy = path.join(backupDirectory, key + ".db")
        try{await backup(source, copy)}finally{source.close()}
        const snapshot = new DatabaseSync(copy, {readOnly: true})
        try{
            for(const {name} of snapshot.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
                legacy[name] = {source: key, rows: snapshot.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()}
            }
        }finally{snapshot.close()}
    }

    db.exec("BEGIN IMMEDIATE")
    try{
        db.exec(schema)
        const archive = db.prepare("INSERT INTO legacyImportRecords(source,tableName,data) VALUES(?,?,?)")
        for(const [table, {source, rows}] of Object.entries(legacy)){
            for(const row of rows) archive.run(source, table, JSON.stringify(row))
        }
        const rows = table => legacy[table]?.rows ?? []
        const issue = (entity, message) => db.prepare("INSERT INTO migrationIssues(entity,message) VALUES(?,?)").run(entity, message)
        const insert = (table, row) => {
            const keys = Object.keys(row)
            db.prepare(`INSERT INTO "${table}" (${keys.map(k => '"' + k + '"').join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
        }
        const now = new Date().toISOString()
        for(const row of rows("serverData")) insert("serverData", {...row, serverName: String(row.serverName)})
        for(const row of rows("itemsData")) insert("itemsData", row)
        for(const row of rows("accountsData")){
            insert("accountsData", {accountId: row.accountId, username: row.username, password: row.password, createdAt: String(row.createdAt ?? now)})
            const oldState = rows("accountPoolState").find(s => s.accountId === row.accountId)
            const banned = row.status === "banned"
            insert("accountPoolState", {
                accountId: row.accountId, status: banned ? "blocked" : oldState?.status ?? "available",
                reason: banned ? "legacy_banned" : oldState?.reason ?? null,
                failureCount: oldState?.failureCount ?? 0, cooldownUntil: oldState?.cooldownUntil ?? null,
                lastUsedAt: oldState?.lastUsedAt ?? null, updatedAt: oldState?.updatedAt ?? now
            })
        }
        for(const row of rows("resellerSettings")) insert("resellerSettings", {...row, updatedAt: String(row.updatedAt ?? now)})
        const assigned = new Set()
        const usedTasks = new Set()
        const importTask = (row, botId) => {
            const type = ["reseller", "afk", "test"].includes(row?.type) ? row.type : "test"
            if(row && type !== row.type) issue(`task:${botId}`, `Legacy mode ${row.type} normalized to test`)
            insert("tasksData", {
                botId, type, itemId: row?.itemId ?? null,
                buyPricePerOne: row?.buyPricePerOne ?? null, sellPricePerOne: row?.sellPricePerOne ?? null,
                enabled: row?.status === "disabled" ? 0 : 1, createdAt: String(row?.createdAt ?? now)
            })
        }
        for(const row of [...rows("botData")].sort((a,b) => a.botId-b.botId)){
            const account = rows("accountsData").find(a => a.accountId === row.connectedAccountId)
            let accountId = account?.accountId ?? null
            if(accountId !== null && !row.archived){
                if(assigned.has(accountId)){
                    issue(`bot:${row.botId}`, `Duplicate account ${accountId} detached; assign a different account. Original record preserved.`)
                    accountId = null
                }else assigned.add(accountId)
            }
            if(row.connectedAccountId != null && !account) issue(`bot:${row.botId}`, "Missing legacy account; assignment cleared")
            insert("botData", {
                botId: row.botId, name: row.name || `Bot ${row.botId}`, connectedAccountId: accountId,
                serverId: account?.serverId ?? null, realm: account?.realm ?? null, archived: row.archived ?? 0,
                createdAt: String(row.createdAt ?? now), updatedAt: String(row.updatedAt ?? now)
            })
            const matches = rows("tasksData").filter(task => task.accountId === row.connectedAccountId)
            if(matches.length > 1) issue(`bot:${row.botId}`, "Multiple legacy tasks: first used; remaining records retained as unassigned tasks")
            const task = matches[0]
            if(task) usedTasks.add(task)
            importTask(task, row.botId)
        }
        for(const task of rows("tasksData")){
            if(usedTasks.has(task)) continue
            importTask(task, null)
            issue(`account:${task.accountId}`, "Legacy task preserved as an unassigned task")
        }
        addChangeTracking(db)
        upgradeToVersion2(db)
        upgradeToVersion3(db)
        upgradeToVersion4(db)
        upgradeToVersion5(db)
        upgradeToVersion6(db)
        upgradeToVersion7(db)
        upgradeToVersion8(db)
        upgradeToVersion9(db)
        upgradeToVersion10(db)
        upgradeToVersion11(db)
        upgradeToVersion12(db)
        upgradeToVersion13(db)
        upgradeToVersion14(db)
        upgradeToVersion15(db)
        upgradeToVersion16(db)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(1, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(2, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(3, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(4, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(5, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(6, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(7, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(8, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(9, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(10, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(11, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(12, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(13, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(14, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(15, now)
        db.prepare("INSERT INTO schemaMigrations VALUES(?,?)").run(16, now)
        db.exec(`PRAGMA user_version=${schemaVersion}`)
        if(db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration foreign key check failed")
        if(db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Migration integrity check failed")
        db.exec("COMMIT")
    }catch(error){
        db.exec("ROLLBACK")
        throw new Error(`Migration rolled back; original databases unchanged: ${error.message}`, {cause: error})
    }
}
