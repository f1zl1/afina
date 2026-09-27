import path from "node:path"
import RotatingLogWriter from "../logger/rotatingLogWriter.js"
import { PersistedEvents } from "./eventPersistence.js"

export default class PublicEventLogStore{
    constructor({eventBus, logger, config = {}}){
        this.eventBus = eventBus
        this.logger = logger.child("PublicEventLogStore")
        this.baseDirectory = path.resolve(config.baseDirectory ?? "./logs/events")
        this.maxBytes = config.maxFileSizeBytes ?? 20 * 1024 * 1024
        this.maxEntries = config.maxEntriesPerFile ?? 50_000
        this.systemWriter = null
        this.botWriters = new Map()
        this.handlers = new Map()

        this.#subscribe()

        this.logger.info("PublicEventLogStore started", {
            directory: this.baseDirectory,
            persistedEvents: PersistedEvents.length
        })
    }

    destroy(){
        for(const [type, handler] of this.handlers){
            this.eventBus.offEnvelope(type, handler)
        }

        this.handlers.clear()
        this.botWriters.clear()
        this.systemWriter = null
    }

    #subscribe(){
        for(const type of PersistedEvents){
            const handler = event => this.#persist(event)

            this.handlers.set(type, handler)
            this.eventBus.onEnvelope(type, handler)
        }
    }

    #persist(event){
        const writer = this.#getWriter(event)

        writer.write(event).catch(error => {
            this.logger.error("Failed to persist public event", {
                eventId: event?.id ?? null,
                eventType: event?.type ?? null,
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })
        })
    }

    #getWriter(event){
        const botId = event.source?.botId
        const accountId = event.source?.accountId

        if(botId !== null && botId !== undefined){
            return this.#getBotWriter(botId, accountId)
        }

        return this.#getSystemWriter()
    }

    #getSystemWriter(){
        if(this.systemWriter) return this.systemWriter

        this.systemWriter = new RotatingLogWriter({
            directory: path.join(this.baseDirectory, "system"),
            prefix: "events",
            maxBytes: this.maxBytes,
            maxEntries: this.maxEntries
        })

        return this.systemWriter
    }

    #getBotWriter(botId, accountId){
        const safeBotId = this.#safeName(botId)
        const safeAccountId = this.#safeName(accountId ?? "unknown")
        const key = `${safeBotId}:${safeAccountId}`

        let writer = this.botWriters.get(key)
        if(writer) return writer

        writer = new RotatingLogWriter({
            directory: path.join(
                this.baseDirectory,
                "bots",
                `bot-${safeBotId}-account-${safeAccountId}`
            ),
            prefix: "events",
            maxBytes: this.maxBytes,
            maxEntries: this.maxEntries
        })

        this.botWriters.set(key, writer)

        return writer
    }

    #safeName(value){
        return String(value).replace(/[^a-zA-Z0-9_-]/g, "_")
    }
}