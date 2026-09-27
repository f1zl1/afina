import AnalystExecution from './analyst/analystExecution.js'
import WorkerWorkload from '../../../workloads/workerWorkload.js'

export default class AnalystTask{
    constructor({bot,eventBus,logger}){
        Object.assign(this,{bot,eventBus,logger});this.job=null
        this.workload=new WorkerWorkload({role:'analyst',incarnation:()=>bot.incarnationId,requestDrain:()=>this.stop('CANCELLED'),completion:()=>this.roleFinished??this.job?.finished,uncertainty:()=>bot.lifecycleUncertain})
    }
    async start(){
        this.stopped=false
        let drained;this.roleFinished=new Promise(resolve=>{drained=resolve})
        const assign=task=>{void this.assign(task)}
        const cancel=({analysisId,incarnationId,workloadGeneration})=>{
            if(this.bot.incarnationId!=null&&incarnationId!==this.bot.incarnationId)return
            if(this.workload.generation!=null&&workloadGeneration!==this.workload.generation)return
            if(this.job?.id===analysisId)this.job.controller.abort(new Error('CANCELLED'))
        }
        this.eventBus.on('core:analysis.assign',assign);this.eventBus.on('core:analysis.cancel',cancel)
        this.emit('status',{state:'idle'})
        try{await new Promise(resolve=>{this.finish=resolve})}
        finally{
            this.eventBus.off('core:analysis.assign',assign);this.eventBus.off('core:analysis.cancel',cancel)
            const job=this.job
            await job?.finished
            this.emit('status',{state:'unavailable',analysisId:job?.id ?? null,code:this.stopReason ?? 'ROLE_ENDED'})
            drained()
        }
    }
    emit(type,data){this.eventBus.emit('bot:analysis.'+type,{botId:this.bot.botId,workloadGeneration:this.workload.generation,...data})}
    async assign(task){
        if(this.stopped || this.job) return
        if(this.workload.begin({workloadId:task?.analysisId,type:'analysis',incarnationId:task?.incarnationId,generation:task?.workloadGeneration}))return
        const job={id:task?.analysisId,controller:new AbortController()};this.job=job
        job.finished=new Promise(resolve=>{job.finish=resolve})
        this.emit('status',{state:'busy',analysisId:job.id})
        const safeCodes=new Set(['AFK_INTERRUPTED','INVALID_ANALYSIS_TASK','INVALID_ANALYSIS_TIMING','DISCONNECTED','WINDOW_CLOSED','UNEXPECTED_WINDOW','WINDOW_BUSY','CANCELLED','REFRESH_TIMEOUT','WINDOW_TIMEOUT','AUCTION_ACTION_FAILED'])
        try{
            if(this.bot.positionStatus!=='realm') throw new Error('DISCONNECTED')
            await this.bot.realmReadyGate?.ready(task.timing,job.controller.signal)
            await this.bot.antiAfk?.performIfDue()
            job.controller.signal.throwIfAborted()
            this.workload.progress(job.id,'auction_analysis')
            await new AnalystExecution({client:this.bot.client,logger:this.logger,antiAfk:this.bot.antiAfk}).execute(task,{signal:job.controller.signal,
                onObservation:data=>{if(this.workload.current(job.id))this.emit('observation',data)},onProgress:data=>{if(this.workload.current(job.id))this.emit('progress',data)}})
            job.controller.signal.throwIfAborted()
            this.workload.finish(job.id,'COMPLETED')
            this.emit('completed',{analysisId:job.id})
        }catch(error){
            const failure=job.controller.signal.aborted?job.controller.signal.reason:error
            const code=safeCodes.has(failure?.message)?failure.message:'ANALYSIS_EXECUTION_FAILED'
            this.workload.finish(job.id,job.controller.signal.aborted?'CANCELLED':'FAILED',code)
            this.logger.warn('Analyst execution ended',{analysisId:job.id,code})
            this.emit('failed',{analysisId:job.id,code})
        }
        finally{this.job=null;job.finish();if(!this.stopped) this.emit('status',{state:'idle'})}
    }
    stop(reason='CANCELLED'){this.stopped=true;this.stopReason=reason;this.job?.controller.abort(new Error(reason));this.finish?.()}
}
