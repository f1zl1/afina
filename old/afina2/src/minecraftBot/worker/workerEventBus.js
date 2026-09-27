import { EventEmitter } from "node:events"

export default class WorkerEventBus{
    constructor(){
        this.eventBus = new EventEmitter()
    }

    emit(event, context = {}){
        return this.eventBus.emit(event, context)
    }

    emitLocal(event, context = {}){
        return this.emit(event, context)
    }

    on(event, handler){
        this.eventBus.on(event, handler)
        return handler
    }

    off(event, handler){
        this.eventBus.off(event, handler)
    }

    once(event, handler){
        this.eventBus.once(event, handler)
        return handler
    }
}