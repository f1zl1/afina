import { EventEmitter } from "node:events"
import { createEvent, isEventEnvelope } from "../events/eventFactory.js"
import { hasEventContract, validateEventPayload } from "../events/eventContracts.js"

export default class EventBus{
    constructor({
        logger,
        config = {}
    }){
        this.logger = logger.child("PublicEventBus")
        this.config = config
        this.eventBus = new EventEmitter()
        this.wrappedHandlers = new Map()

        this.validationMode =
            config.validationMode ??
            (
                process.env.NODE_ENV === "production"
                    ? "warn"
                    : "throw"
            )

        this.logger.info("PublicEventBus started", {
            validationMode: this.validationMode
        })
    }

    emit(type, payload = {}, source = {}){
        return this.publish(
            type,
            payload,
            source
        )
    }

    publish(type, payload = {}, source = {}){
        const event = createEvent({
            type,
            payload,
            source
        })

        return this.publishEnvelope(event)
    }

    publishEnvelope(event){
        if(!isEventEnvelope(event)){
            return this.#handleInvalidEvent(
                event?.type ?? "unknown",
                ["invalid event envelope"]
            )
        }

        if(hasEventContract(event.type)){
            const errors = validateEventPayload(
                event.type,
                event.payload
            )

            if(errors.length > 0){
                return this.#handleInvalidEvent(
                    event.type,
                    errors
                )
            }
        }

        const emitted = this.eventBus.emit(
            event.type,
            event
        )

        this.eventBus.emit(
            "*",
            event
        )

        return emitted
    }

    on(type, handler){
        const wrapped = event => {
            handler(event.payload)
        }

        this.#storeWrappedHandler(
            type,
            handler,
            wrapped
        )

        this.eventBus.on(
            type,
            wrapped
        )

        if(this.config.logAllSubscribe){
            this.logger.info(
                `Subscribed to event: ${type}`
            )
        }

        return handler
    }

    onEnvelope(type, handler){
        this.eventBus.on(
            type,
            handler
        )

        return handler
    }

    onAny(handler){
        this.eventBus.on(
            "*",
            handler
        )

        return handler
    }

    off(type, handler){
        const wrapped = this.#getWrappedHandler(
            type,
            handler
        )

        if(wrapped){
            this.eventBus.off(
                type,
                wrapped
            )

            this.#deleteWrappedHandler(
                type,
                handler
            )
        }else{
            this.eventBus.off(
                type,
                handler
            )
        }

        if(this.config.logAllSubscribe){
            this.logger.info(
                `Unsubscribed from event: ${type}`
            )
        }
    }

    offEnvelope(type, handler){
        this.eventBus.off(
            type,
            handler
        )
    }

    offAny(handler){
        this.eventBus.off(
            "*",
            handler
        )
    }

    once(type, handler){
        const wrapped = event => {
            this.#deleteWrappedHandler(
                type,
                handler
            )

            handler(event.payload)
        }

        this.#storeWrappedHandler(
            type,
            handler,
            wrapped
        )

        this.eventBus.once(
            type,
            wrapped
        )

        if(this.config.logAllOneTimeEvents){
            this.logger.info(
                `Subscribed to one time event: ${type}`
            )
        }

        return handler
    }

    #handleInvalidEvent(type, errors){
        if(this.validationMode === "off"){
            return false
        }

        if(this.validationMode === "throw"){
            throw new Error(
                `Invalid public event "${type}": ${errors.join(", ")}`
            )
        }

        this.logger.error(
            `Invalid public event rejected: ${type}`,
            {
                eventType: type,
                errors
            }
        )

        return false
    }

    #storeWrappedHandler(type, handler, wrapped){
        let handlers =
            this.wrappedHandlers.get(type)

        if(!handlers){
            handlers = new Map()

            this.wrappedHandlers.set(
                type,
                handlers
            )
        }

        handlers.set(
            handler,
            wrapped
        )
    }

    #getWrappedHandler(type, handler){
        return this.wrappedHandlers
            .get(type)
            ?.get(handler) ?? null
    }

    #deleteWrappedHandler(type, handler){
        const handlers =
            this.wrappedHandlers.get(type)

        if(!handlers) return

        handlers.delete(handler)

        if(handlers.size === 0){
            this.wrappedHandlers.delete(type)
        }
    }
}