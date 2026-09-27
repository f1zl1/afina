import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import DatabaseEditor from "../src/data/databaseEditor.js"
import DatabaseStore from "../src/data/databaseStore.js"

async function fixture(t){
    const dir = mkdtempSync(path.join(tmpdir(), "afina-editor-"))
    const store=new DatabaseStore({databasePath:path.join(dir,"afina.db")})
    await store.init()
    store.db.exec(`
        INSERT INTO serverData VALUES(1,'localhost','1','Test');
        INSERT INTO accountsData(accountId,username,password) VALUES(1,'first','secret');
        INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(1,'First',1,1,101);
        INSERT INTO itemsData(itemId,name,searchQuery,matcher) VALUES(1,'Item','Item','{}');
        INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne) VALUES(1,'reseller',1,10,20);
        INSERT INTO resellerSettings(id,settingName,settingType,settingValue) VALUES(1,'delay','integer','100');
    `)
    t.after(() => {store.close();rmSync(dir,{recursive:true,force:true})})
    return new DatabaseEditor({store})

}

test("all databases, search/paging, CRUD, nullable values and optimistic concurrency", async t => {
    const editor = await fixture(t)
    assert.equal(editor.catalog().length, 10)
    const request = {database: "tasks", table: "tasksData"}
    const row = editor.read(request).rows[0]
    assert.equal(editor.read({...request, search: "resell"}).total, 1)
    assert.equal(editor.read({...request, search: "' OR 1=1 --"}).total, 0)
    editor.mutate({...request, operation: "update", rowId: row.rowId, expectedRevision: row.revision, values: {buyPricePerOne: 20}})
    assert.equal(editor.read(request).rows[0].values.buyPricePerOne, 20)
    assert.throws(() => editor.mutate({...request, operation: "delete", rowId: row.rowId, expectedRevision: row.revision}), /повторно/)
    const current = editor.read(request).rows[0]
    editor.mutate({...request, operation: "delete", rowId: current.rowId, expectedRevision: current.revision})
    assert.equal(editor.read(request).total, 0)
    editor.mutate({...request, operation: "insert", values: {botId: 1, type: "test", itemId: null, buyPricePerOne: 0}})
    assert.equal(editor.read(request).rows[0].values.itemId, null)
})

test("rejects injection, invalid relationships/JSON and protects referenced records", async t => {
    const editor = await fixture(t)
    assert.throws(() => editor.read({database: "../accounts", table: "accountsData"}))
    assert.throws(() => editor.read({database: "accounts", table: 'accountsData"; DROP TABLE accountsData;--'}))
    assert.throws(() => editor.mutate({database: "tasks", table: "tasksData", operation: "insert", values: {botId: 999, type: "test"}}))
    const row = editor.read({database: "accounts", table: "accountsData"}).rows[0]
    assert.throws(() => editor.mutate({database: "accounts", table: "accountsData", operation: "delete", rowId: row.rowId, expectedRevision: row.revision}), /використовується/)
    assert.throws(() => editor.mutate({database: "items", table: "itemsData", operation: "insert", values: {matcher: "{"}}))
    const setting = editor.read({database: "reseller", table: "resellerSettings"}).rows[0]
    assert.throws(() => editor.mutate({database: "reseller", table: "resellerSettings", operation: "update", rowId: setting.rowId, expectedRevision: setting.revision, values: {settingValue: "NaN"}}))
    assert.equal(editor.read({database: "reseller", table: "resellerSettings"}).rows[0].values.settingValue, "100")
})
