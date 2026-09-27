import { randomUUID } from "node:crypto"
import {
    InterfaceMessageType,
    InterfaceProtocolVersion,
    createResponse,
    createEventMessage,
    validateInterfaceRequest
} from "./interfaceProtocol.js"

export default class InterfaceGateway{
    constructor({
        logger,
        core,
        eventBus
    }){
        this.logger = logger.child("InterfaceGateway")
        this.core = core
        this.eventBus = eventBus

        this.logger.info("InterfaceGateway started")
    }

    async handleRequest(request, actor = null){
        const requestId = this.#requestId(request)
        const validation = validateInterfaceRequest(request)

        if(!validation.ok){
            return createResponse({
                requestId,
                result: {
                    ok: false,
                    error: {
                        code: validation.code,
                        message: validation.message,
                        details: null
                    }
                }
            })
        }

        const normalizedActor = this.#normalizeActor(actor)

        this.logger.info("Interface request", {
            requestId,
            type: request.type,
            name: request.name,
            actor: normalizedActor
        })

        try{
            let result

            if(request.type === InterfaceMessageType.COMMAND){
                result = await this.core.executeCommand({
                    command: request.name,
                    payload: request.payload ?? {},
                    actor: normalizedActor
                })
            }else{
                result = await this.core.executeQuery({
                    query: request.name,
                    payload: request.payload ?? {},
                    actor: normalizedActor
                })
            }

            return createResponse({
                requestId,
                result
            })
        }catch(error){
            this.logger.error("Interface request failed", {
                requestId,
                type: request.type,
                name: request.name,
                actor: normalizedActor,
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })

            return createResponse({
                requestId,
                result: {
                    ok: false,
                    error: {
                        code: "INTERFACE_REQUEST_FAILED",
                        message: error?.message ?? String(error),
                        details: null
                    }
                }
            })
        }
    }

    createCommand(name, payload = {}, id = null){
        return {
            version: InterfaceProtocolVersion,
            id: id ?? randomUUID(),
            type: InterfaceMessageType.COMMAND,
            name,
            payload
        }
    }

    createQuery(name, payload = {}, id = null){
        return {
            version: InterfaceProtocolVersion,
            id: id ?? randomUUID(),
            type: InterfaceMessageType.QUERY,
            name,
            payload
        }
    }

    subscribe(handler){
        if(typeof handler !== "function"){
            throw new TypeError("Event handler must be a function")
        }

        const listener = event => {
            handler(createEventMessage(event))
        }

        this.eventBus.onAny(listener)

        return () => {
            this.eventBus.offAny(listener)
        }
    }

    #requestId(request){
        if(
            request &&
            typeof request.id === "string" &&
            request.id
        ){
            return request.id
        }

        return randomUUID()
    }

    #normalizeActor(actor){
        if(!actor || typeof actor !== "object"){
            return {
                type: "unknown",
                id: null
            }
        }

        return {
            type:
                typeof actor.type === "string" && actor.type
                    ? actor.type
                    : "unknown",
            id:
                actor.id === null ||
                actor.id === undefined
                    ? null
                    : String(actor.id)
        }
    }
}