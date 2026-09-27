import { randomUUID } from "node:crypto"
import { EventVersion } from "./events.js"

export function createEvent({
    type,
    payload = {},
    source = {}
}){
    if(typeof type !== "string" || !type){
        throw new Error("Event type is required")
    }

    if(!payload || typeof payload !== "object" || Array.isArray(payload)){
        throw new TypeError("Event payload must be an object")
    }

    return {
        id: randomUUID(),
        version: EventVersion,
        type,
        timestamp: Date.now(),
        source: {
            kind: source.kind ?? "system",
            botId: source.botId ?? null,
            accountId: source.accountId ?? null,
            workerPid: source.workerPid ?? null,
            incarnationId: source.incarnationId ?? null
        },
        payload
    }
}

export function isEventEnvelope(event){
    return Boolean(
        event &&
        typeof event === "object" &&
        typeof event.id === "string" &&
        event.version === EventVersion &&
        typeof event.type === "string" &&
        Number.isFinite(event.timestamp) &&
        event.source &&
        typeof event.source === "object" &&
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
    )
}
