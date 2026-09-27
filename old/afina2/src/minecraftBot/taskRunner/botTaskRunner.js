import ResellerTask from "./modes/reseller/resellerTask.js"
import AnalystTask from "./modes/analystTask.js"
import IdleTask from "./modes/idleTask.js"
import WorkerWorkload from '../../workloads/workerWorkload.js'

export default class BotTaskRunner{
    constructor({
        bot,
        logger,
        eventBus,
        resellerSettingsStore
    }){
        this.bot = bot
        this.logger = logger
        this.eventBus = eventBus
        this.resellerSettingsStore = resellerSettingsStore

        this.activeTask = null
        this.stopGeneration=0
        this.workloadGeneration=0;this.workloadSeen=new Set()
    }

    async start(taskData){
        if(this.quiescing)return
        if(!taskData){
            throw new Error(
                `Bot ${this.bot.botId}: taskData is missing`
            )
        }

        if(this.activeTask){
            if(!this.stopping)return
            const generation=this.stopGeneration
            await this.completion
            if(generation===this.stopGeneration && this.bot.positionStatus==='realm')return this.start(taskData)
            return
        }

        const task = this.#createTask(taskData)

        if(!task){
            throw new Error(
                `Unknown task type: ${taskData.type}`
            )
        }

        this.activeTask = task
        this.stopping=false
        let completed
        this.completion=new Promise(resolve=>{completed=resolve})
        this.workload=task.workload??new WorkerWorkload({role:taskData.type,incarnation:()=>this.bot.incarnationId,requestDrain:()=>task.stop('QUIESCING'),uncertainty:()=>this.bot.lifecycleUncertain})
        this.workload.generation=++this.workloadGeneration;this.workload.seen=this.workloadSeen
        this.workload.completion=()=>this.completion

        try{
            await this.activeTask.start()
        }finally{
            this.activeTask = null
            this.workload.ended()
            const release=this.cleanupRelease;this.cleanupRelease=null
            release?.()
            completed()
        }
    }

    stop(){
        this.stopGeneration++
        this.bot.antiAfk?.cancel('ROLE_STOPPED')
        if(!this.activeTask) return

        // The interrupted role owns movement safety until its asynchronous finally completes.
        if(!this.stopping)this.cleanupRelease=this.bot.antiAfk?.acquireBlock('ROLE_CLEANUP')
        this.stopping=true
        this.workload?.interrupt(this.bot.positionStatus==='afk'?'AFK_INTERRUPTED':'CANCELLED')
        this.activeTask.stop(this.bot.positionStatus==='afk'?'AFK_INTERRUPTED':'CANCELLED')
    }

    async quiesce(context={}){
        this.quiescing=true
        this.bot.lifecycleQuiescing=true
        this.bot.afkRecovery?.cancel('QUIESCING')
        this.bot.antiAfk?.stop('QUIESCING')
        // Injected legacy roles use the compatibility adapter; production roles
        // register their workload adapter when they start.
        if(!this.workload){const task=this.activeTask;this.workload=new WorkerWorkload({role:this.bot.taskData?.type,incarnation:()=>this.bot.incarnationId,requestDrain:()=>task?.requestQuiesce?task.requestQuiesce():task?.stop('QUIESCING'),completion:()=>this.completion,uncertainty:()=>this.bot.lifecycleUncertain})}
        return this.workload.drain(context)
    }

    #createTask(taskData){
        const common = {
            bot: this.bot,
            taskData,
            logger: this.logger,
            eventBus: this.eventBus
        }

        switch(taskData.type){
            case null:
            case undefined:
            case "null":
            case "test":
            case "afk":
                return new IdleTask({
                    ...common,
                    settings: this.resellerSettingsStore
                })

            case "reseller":
                return new ResellerTask({
                    ...common,
                    settings: this.resellerSettingsStore
                })

            case "analyst":
                return new AnalystTask(common)

            default:
                return null
        }
    }
}
