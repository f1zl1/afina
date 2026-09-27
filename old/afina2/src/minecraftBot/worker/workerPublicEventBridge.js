import { createEvent } from "../../events/eventFactory.js"
import { WorkerPublicEventMap } from "../../events/events.js"
import { normalizeWorkerEvent } from "../../events/workerEventNormalizer.js"
import { validateEventPayload } from "../../events/eventContracts.js"
import {semanticFactEvents} from './workerFacts.js'

export default class WorkerPublicEventBridge{
    constructor({
        eventBus,
        logger,
        botId,
        accountId,
        incarnationId=null,
        getFacts=()=>null
    }){
        this.eventBus = eventBus
        this.logger = logger.child("PublicEventBridge")
        this.botId = botId
        this.accountId = accountId
        this.incarnationId=incarnationId;this.getFacts=getFacts
        this.handlers = new Map()
    }

    register(){
        for(const [localType, publicType] of Object.entries(WorkerPublicEventMap)){
            const handler = payload => {
                this.#forward(
                    localType,
                    publicType,
                    payload
                )
            }

            this.handlers.set(
                localType,
                handler
            )

            this.eventBus.on(
                localType,
                handler
            )
        }
    }

    publish(type, payload = {}){
        return this.#sendPublicEvent(
            type,
            payload
        )
    }

    destroy(){
        for(const [event, handler] of this.handlers){
            this.eventBus.off(
                event,
                handler
            )
        }

        this.handlers.clear()
    }

    #forward(
        localType,
        publicType,
        payload
    ){
        try{
            const normalized = normalizeWorkerEvent(
                localType,
                publicType,
                payload
            )

            return this.#sendPublicEvent(
                publicType,
                normalized
            )
        }catch(error){
            this.logger.error(
                `Failed to normalize event: ${localType}`,
                {
                    publicType,
                    error: error?.message ?? String(error)
                }
            )

            return false
        }
    }

    #sendPublicEvent(type, payload){
        const errors = validateEventPayload(
            type,
            payload
        )

        if(errors.length > 0){
            this.logger.error(
                `Invalid public event rejected: ${type}`,
                {
                    errors,
                    payload
                }
            )

            return false
        }

        if(!process.connected){
            return false
        }

        const event = createEvent({
            type,
            payload,
            source: {
                kind: "bot",
                botId: this.botId,
                accountId: this.accountId,
                workerPid: process.pid,
                incarnationId:this.incarnationId
            }
        })

        try{
            process.send({
                type: "publicEvent",
                event,
                incarnationId:this.incarnationId,
                facts:semanticFactEvents.has(type)?this.getFacts():undefined
            })

            return true
        }catch(error){
            this.logger.error(
                `Failed to publish event: ${type}`,
                {
                    error: error?.message ?? String(error)
                }
            )

            return false
        }
    }
}
