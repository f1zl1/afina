import WorkerWorkload from '../../../../workloads/workerWorkload.js'
import EconomicExecution from './economicExecution.js'
import {emptyEconomicProgress} from '../../../../workloads/economicContract.js'

// Production Reseller has no configured-cycle switch or autonomous task loop.
export default class ResellerTask{
 constructor({bot,taskData,logger,eventBus,settings}){
  Object.assign(this,{bot,taskData,logger,eventBus,settings});this.running=false;this.state='idle'
  this.workload=new WorkerWorkload({role:'reseller',incarnation:()=>bot.incarnationId,requestDrain:()=>this.requestQuiesce(),completion:()=>this.finished,uncertainty:()=>bot.lifecycleUncertain})
  this.workload.manualEconomicSupported=true
 }
 async start(){
  if(this.running||this.quiescing)return
  this.running=true;this.state='idle'
  let drained;this.finished=new Promise(resolve=>{drained=resolve})
  const assign=task=>{void this.assignEconomic(task)}
  const cancel=task=>{const job=this.economicJob;if(job&&['workloadId','incarnationId','lifecycleEpoch','workloadGeneration'].every(k=>job.task[k]===task?.[k]))job.execution.cancel()}
  this.eventBus.on('core:economic.assign',assign);this.eventBus.on('core:economic.cancel',cancel)
  this.eventBus.emit('bot:resellerStateUpdated',{botId:this.bot.botId,state:'idle'})
  try{await new Promise(resolve=>{this.finishRole=resolve})}
  finally{
   this.eventBus.off('core:economic.assign',assign);this.eventBus.off('core:economic.cancel',cancel)
   await this.economicJob?.finished;this.running=false;this.state='stopped';drained()
  }
 }
 stop(){this.running=false;this.economicJob?.execution.cancel();this.finishRole?.()}
 requestQuiesce(){this.quiescing=true;this.stop()}
 async assignEconomic(task){
  if(!this.running||this.quiescing||this.economicJob)return
  if(this.workload.begin({workloadId:task?.workloadId,type:'manual_economic',owner:task?.source==='AUTONOMOUS_TRADING'?'core':'manual',incarnationId:task?.incarnationId,generation:task?.workloadGeneration}))return
  let execution
  try{execution=new EconomicExecution({bot:this.bot,eventBus:this.eventBus,logger:this.logger,settings:this.settings,task,workload:this.workload})}
  catch{this.workload.finish(task.workloadId,'FAILED','INVALID_ECONOMIC_REQUEST');this.eventBus.emit('bot:economic.result',{workloadId:task.workloadId,incarnationId:task.incarnationId,lifecycleEpoch:task.lifecycleEpoch,workloadGeneration:task.workloadGeneration,sequence:1,status:'FAILED',progress:emptyEconomicProgress(),reason:'INVALID_ECONOMIC_REQUEST'});return}
  const job={task,execution};this.economicJob=job;this.state='economic_workload'
  job.finished=execution.run()
  try{await job.finished}finally{this.economicJob=null;this.state=this.running?'idle':'stopped';this.eventBus.emit('bot:resellerStateUpdated',{botId:this.bot.botId,state:this.state})}
 }
}
