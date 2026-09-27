import { DatabaseSync } from "node:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { migrateDatabase } from "./databaseMigration.js"

export default class DatabaseStore{
    constructor(config){this.config = config; this.db = null; this.statements = new Map()}
    async init(){
        if(this.db) return
        if(!this.config.databasePath) throw new Error("databasePath is required")
        await fs.mkdir(path.dirname(this.config.databasePath), {recursive: true})
        this.db = new DatabaseSync(this.config.databasePath)
        try{
            this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL")
            await migrateDatabase(this.db, this.config)
        }catch(error){this.close();throw error}
    }
    prepare(sql){
        if(!this.db) throw new Error("Database is not initialized")
        if(!this.statements.has(sql)){
            if(this.statements.size >= 256) this.statements.delete(this.statements.keys().next().value)
            this.statements.set(sql, this.db.prepare(sql))
        }
        return this.statements.get(sql)
    }
    transaction(callback){
        this.db.exec("BEGIN IMMEDIATE")
        try{const result=callback();this.db.exec("COMMIT");return result}
        catch(error){this.db.exec("ROLLBACK");throw error}
    }
    revision(){return this.prepare("SELECT revision FROM dataRevision WHERE id=1").get().revision}
    close(){this.statements.clear();this.db?.close();this.db=null}
}
