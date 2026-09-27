import test from "node:test"
import assert from "node:assert/strict"
import Core from "../src/core/coreMain.js"
import InterfaceGateway from "../src/interfaces/interfaceGateway.js"

test("database queries and mutations pass through the existing interface and report sync failure without retrying a committed write", async () => {
    const calls = []
    const logs = []
    const logger = {child(){return this}, info(message, context){logs.push(context)}, error(){}, warn(){}}
    const editor = {
        catalog: () => [{database: "accounts", tables: []}],
        read: payload => ({rows: [], table: payload.table}),
        mutate: payload => {calls.push(payload); return {changes: 1}}
    }
    const eventBus = {publish: (...args) => calls.push(args)}
    const core = new Core({logger, eventBus, databaseEditor: editor, configurationService: {async sync(){throw new Error("sync unavailable")}}})
    const gateway = new InterfaceGateway({logger, core, eventBus})
    const catalog = await gateway.handleRequest(gateway.createQuery("database.catalog"))
    assert.equal(catalog.ok, true)
    assert.equal(catalog.data[0].database, "accounts")
    const response = await gateway.handleRequest(gateway.createCommand("database.mutate", {database: "accounts", table: "accountsData", operation: "update", values: {password: "private-value"}}))
    assert.equal(response.ok, true)
    assert.equal(response.data.changes, 1)
    assert.equal(response.data.syncError, "sync unavailable")
    assert.equal(calls.length, 2)
    assert.equal(JSON.stringify(logs).includes("private-value"), false)
})
