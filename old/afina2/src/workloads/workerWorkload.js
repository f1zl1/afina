import {failureKind,workloadEvidence} from './workloadContract.js'

// Work only: no process, account, transport or lifecycle executor is available here.
export default class WorkerWorkload{
 constructor({role,incarnation=()=>null,requestDrain=()=>{},completion=()=>Promise.resolve(),uncertainty=()=>null,now=Date.now}){
  Object.assign(this,{role,incarnation,requestDrain,completion,uncertainty,now});this.seen=new Set();this.generation=null
  this.value={role,type:null,workloadId:null,owner:null,state:'IDLE',startedAt:null,updatedAt:now(),draining:false,safe:true,uncertain:false,reason:null,failureKind:null}
 }
 begin({workloadId,type,owner='core',incarnationId=null,generation=null}){
  if(typeof workloadId!=='string'||!workloadId||workloadId.length>128)return 'INVALID_WORKLOAD'
  if(this.value.draining||this.uncertainty())return 'WORKLOAD_DRAINING'
  if(this.incarnation()!=null&&incarnationId!==this.incarnation())return 'STALE_INCARNATION'
  if(this.generation!=null&&generation!==this.generation)return 'STALE_WORKLOAD_GENERATION'
  if(this.role==='reseller'&&owner!=='configured_role'&&!(['manual','core'].includes(owner)&&type==='manual_economic'))return 'ECONOMIC_ADMISSION_REQUIRED'
  if(this.seen.has(workloadId))return 'DUPLICATE_WORKLOAD'
  if(['STARTING','RUNNING','DRAINING'].includes(this.value.state))return 'WORKLOAD_BUSY'
  this.seen.add(workloadId);if(this.seen.size>256)this.seen.delete(this.seen.values().next().value)
  this.value={role:this.role,type,workloadId,owner,state:'STARTING',startedAt:this.now(),updatedAt:this.now(),draining:false,safe:false,uncertain:false,reason:null,failureKind:null,operation:null}
  return null
 }
 current(id,{draining=false}={}){return this.value.workloadId===id&&(draining||!this.value.draining)&&['STARTING','RUNNING','DRAINING'].includes(this.value.state)}
 progress(id,operation=null){if(!this.current(id))return false;this.change({state:'RUNNING',operation});return true}
 finish(id,state='COMPLETED',reason=null){
  if(!this.current(id,{draining:true}))return false
  if(!['COMPLETED','FAILED','CANCELLED'].includes(state))return false
  this.change({state,reason,failureKind:reason?failureKind(reason):null,safe:!this.value.draining&&!this.uncertainty()});return true
 }
 change(patch){if(Object.entries(patch).some(([k,v])=>this.value[k]!==v))Object.assign(this.value,patch,{updatedAt:this.now()})}
 async drain({actionId=null}={}){
  this.change({drainActionId:actionId})
  if(!this.drainPromise){
   this.change({draining:true,safe:false,state:'DRAINING'})
   this.drainPromise=Promise.resolve().then(()=>this.requestDrain()).then(()=>this.completion()).then(()=>{
    this.change({...(this.value.state==='DRAINING'?{state:'COMPLETED'}:{}),safe:!this.uncertainty()})
   }).catch(()=>this.change({state:'FAILED',reason:'QUIESCENCE_FAILED',failureKind:'ROLE_FAILURE',safe:false}))
  }
  await this.drainPromise
  return this.read()
 }
 interrupt(reason){this.change({state:'DRAINING',draining:true,safe:false,reason,failureKind:failureKind(reason)})}
 ended(reason='ROLE_ENDED'){
  if(['IDLE','STARTING','RUNNING'].includes(this.value.state)||this.value.state==='DRAINING'&&!this.drainPromise)this.change({state:'CANCELLED',reason,failureKind:'ROLE_FAILURE',safe:!this.uncertainty()})
 }
 read(){
  const reason=this.uncertainty()
  if(reason)this.change({state:'UNCERTAIN',uncertain:true,safe:false,reason,failureKind:'UNCERTAIN_RESULT'})
  return workloadEvidence({...this.value,incarnationId:this.incarnation(),generation:this.generation,manualEconomicSupported:this.manualEconomicSupported===true})
 }
}
