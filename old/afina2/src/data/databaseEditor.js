import { createHash } from "node:crypto"
import { editableTables, readOnlyTables } from "./databaseSchema.js"
import { parseSettingValue } from "./dataBaseManagerMain.js"

const quote = name => '"' + name.replaceAll('"', '""') + '"'
const revision = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export default class DatabaseEditor{
    constructor({store, beforeMutation = null}){
        this.store = store
        this.beforeMutation = beforeMutation
    }

    open(database, callback, write = false){
        if(!Object.hasOwn(editableTables, database)) throw new Error("Unknown database section")
        return callback(this.store.db)
    }

    tables(db){
        return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    }

    schema(db, table, database){
        if(!editableTables[database]?.includes(table)) throw new Error("Unknown table")
        const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter(c => table !== "telegramAccounts" || c.name !== "session")
        if(table === "telegramAccounts") columns.push({name:"linkedMinecraftAccounts",type:"INTEGER",notnull:1,pk:0,dflt_value:null})
        return columns.map(c => ({...c,writeOnly:table === "accountsData" && c.name === "password",readOnly:table === "accountsData" && c.name === "telegramAccountId"}))
    }

    catalog(){
        return Object.keys(editableTables).map(database => this.open(database, db => ({
            database,
            tables: editableTables[database].map(table => ({table, readOnly: readOnlyTables.has(table), columns: this.schema(db, table, database)}))
        })))
    }

    read({database, table, offset = 0, limit = 50, search = ""}){
        if(!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100){
            throw new Error("Invalid page")
        }
        if(typeof search !== "string" || search.length > 200) throw new Error("Invalid search")
        return this.open(database, db => {
            const columns = this.schema(db, table, database)
            const searchable = columns.filter(c => !c.writeOnly && c.name !== "linkedMinecraftAccounts")
            const where = search ? " WHERE " + searchable.map(c => `instr(lower(CAST(${quote(c.name)} AS TEXT)), lower(?)) > 0`).join(" OR ") : ""
            const params = search ? searchable.map(() => search) : []
            const source = table === "telegramAccounts" ? `(SELECT t.telegramAccountId AS rowid,t.telegramAccountId,t.phone,t.status,t.active,t.createdAt,
                (SELECT count(*) FROM accountsData a WHERE a.telegramAccountId=t.telegramAccountId) AS linkedMinecraftAccounts FROM telegramAccounts t)` : quote(table)
            const total = db.prepare(`SELECT COUNT(*) AS count FROM ${source}${where}`).get(...params).count
            const rows = db.prepare(`SELECT rowid AS __editorRowId, * FROM ${source}${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...params, limit, offset)
            return {database, table, columns, total, offset, limit, readOnly: readOnlyTables.has(table), rows: rows.map(row => {
                const {__editorRowId: rowId, ...values} = row
                if(table === "telegramAccounts") delete values.rowid
                const rowRevision = revision(values)
                if(table === "accountsData") values.password = "[redacted]"
                return {rowId, values, revision: rowRevision}
            })}
        })
    }

    mutate({database, table, operation, rowId, expectedRevision, values = {}}){
        if(!["insert", "update", "delete"].includes(operation)) throw new Error("Unknown operation")
        if(!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid values")
        return this.open(database, db => {
            const columns = this.schema(db, table, database)
            if(readOnlyTables.has(table)) throw new Error("Table is read-only; use its dedicated actions")
            const allowed = new Set(columns.filter(c => !c.readOnly).map(c => c.name))
            for(const [key, value] of Object.entries(values)){
                if(!allowed.has(key)) throw new Error(`Unknown column: ${key}`)
                if(value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))){
                    throw new Error(`Invalid value: ${key}`)
                }
            }
            db.exec("BEGIN IMMEDIATE")
            try{
                let before = null
                if(operation !== "insert"){
                    if(!Number.isSafeInteger(rowId)) throw new Error("Invalid row ID")
                    before = db.prepare(`SELECT * FROM ${quote(table)} WHERE rowid = ?`).get(rowId)
                    if(!before || revision(before) !== expectedRevision){
                        throw new Error("Запис уже змінено або видалено. Оновіть таблицю та відкрийте його повторно.")
                    }
                }
                const after = operation === "delete" ? null : {...before, ...values}
                this.beforeMutation?.({table,operation,before,after})
                this.validate(database, table, before, after)
                const keys = Object.keys(values)
                let result
                if(operation === "delete"){
                    result = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid = ?`).run(rowId)
                }else if(operation === "insert"){
                    if(!keys.length) throw new Error("No values supplied")
                    result = db.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => values[k]))
                }else{
                    if(!keys.length) throw new Error("No changes supplied")
                    result = db.prepare(`UPDATE ${quote(table)} SET ${keys.map(k => quote(k) + " = ?").join(",")} WHERE rowid = ?`).run(...keys.map(k => values[k]), rowId)
                }
                db.exec("COMMIT")
                return {database, table, operation, changes: Number(result.changes)}
            }catch(error){
                db.exec("ROLLBACK")
                throw error
            }
        }, true)
    }

    exists(database, table, column, value){
        return this.open(database, db => Boolean(db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(column)} = ? LIMIT 1`).get(value)))
    }

    validate(database, table, before, after){
        const links = [
            ["bots", "botData", "connectedAccountId", "accounts", "accountsData", "accountId"],
            ["tasks", "tasksData", "botId", "bots", "botData", "botId"],
            ["accounts", "accountPoolState", "accountId", "accounts", "accountsData", "accountId"],
            ["bots", "botData", "serverId", "servers", "serverData", "serverId"],
            ["tasks", "tasksData", "itemId", "items", "itemsData", "itemId"]
        ]
        for(const [source, sourceTable, field, target, targetTable, key] of links){
            if(after && database === source && table === sourceTable && after[field] != null &&
                !this.exists(target, targetTable, key, after[field])){
                throw new Error(`${field}: запис ${after[field]} відсутній у ${targetTable}`)
            }
            if(before && database === target && table === targetTable && (!after || after[key] !== before[key]) &&
                this.exists(source, sourceTable, field, before[key])){
                throw new Error(`Запис використовується в ${sourceTable}.${field}. Спочатку змініть зв’язок.`)
            }
        }
        if(!after) return
        if(table === "itemsData" && after.matcher) JSON.parse(after.matcher)
        if(table === "tasksData" && after.type !== undefined && !["reseller", "test", "afk", "analyst"].includes(after.type)){
            throw new Error("Тип завдання: reseller, test або afk")
        }
        if(table === "resellerSettings"){
            const value = after.settingValue
            if(after.settingType === "json") JSON.parse(value)
            if(["integer", "float"].includes(after.settingType) &&
                (String(value).trim() === "" || !Number.isFinite(Number(value)) ||
                    (after.settingType === "integer" && !Number.isInteger(Number(value))))){
                throw new Error("Налаштування повинно містити коректне число")
            }
            if(after.settingType === "boolean" && !["true", "false"].includes(value)) throw new Error("Вкажіть true або false")
        }
        if(["profileSettings", "botSettings"].includes(table)){
            const setting = this.store.prepare("SELECT settingType FROM resellerSettings WHERE settingName=?").get(after.settingName)
            if(!setting) throw new Error("Unknown settingName")
            parseSettingValue(after.settingValue, setting.settingType)
        }
    }
}
