// Acknowledges a fenced, drained runtime. It never terminates the process.
export default class GracefulStop{
 constructor({bot,incarnationId,send}){Object.assign(this,{bot,incarnationId,send});this.sequence=0;this.state=null}
 async request(request){
  if(request?.incarnationId!==this.incarnationId||typeof request.actionId!=='string'||!request.actionId||request.actionId.length>128)return
  if(this.state?.actionId===request.actionId){this.publish();return}
  const sequence=++this.sequence
  this.state={actionId:request.actionId,incarnationId:this.incarnationId,state:'quiescing',safe:false,reason:null}
  this.publish()
  try{
   const workload=await this.bot.taskRunner.quiesce({actionId:request.actionId,incarnationId:this.incarnationId})
   if(sequence!==this.sequence)return
   const reason=workload?(workload.safe?null:workload.reason??'UNSAFE_STOP'):this.bot.lifecycleUncertain??null
   Object.assign(this.state,{state:reason?'unsafe':'safe',safe:!reason,reason})
  }catch{if(sequence!==this.sequence)return;Object.assign(this.state,{state:'unsafe',safe:false,reason:'QUIESCENCE_FAILED'})}
  this.publish()
 }
 publish(){this.send({type:'lifecycle:quiescence',...this.state})}
}
