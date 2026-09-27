export const workloadStates=Object.freeze(['IDLE','STARTING','RUNNING','DRAINING','COMPLETED','FAILED','CANCELLED','UNCERTAIN'])
export function failureKind(code){
 if(/UNCERTAIN$/.test(code??''))return 'UNCERTAIN_RESULT'
 if(['PROCESS_MISSING','DISCONNECTED','WORKER_IPC_DISCONNECTED'].includes(code))return 'TRANSPORT_FAILURE'
 if(['WORKER_RUNTIME_FAILED','WORKER_NOT_READY','fatal_error'].includes(code))return 'RUNTIME_FAILURE'
 if(['AFK_INTERRUPTED','ANALYST_ROLE_ENDED'].includes(code))return 'ROLE_FAILURE'
 if(['CANCELLED','QUIESCING','USER_CANCELLED_ANALYSIS','APPLICATION_RESTARTED','CORE_STOPPED','ANALYSIS_CANCELLED'].includes(code))return 'CANCELLATION'
 return 'WORKLOAD_FAILURE'
}
const text=v=>typeof v==='string'?v.slice(0,128):null
export function workloadEvidence(value){
 if(!value||!workloadStates.includes(value.state))return null
 return {role:text(value.role),type:text(value.type),workloadId:text(value.workloadId),owner:text(value.owner),incarnationId:text(value.incarnationId),
  generation:Number.isSafeInteger(value.generation)?value.generation:null,state:value.state,startedAt:Number.isFinite(value.startedAt)?value.startedAt:null,
  updatedAt:Number.isFinite(value.updatedAt)?value.updatedAt:null,draining:value.draining===true,safe:value.safe===true,uncertain:value.uncertain===true,
  operation:text(value.operation),reason:text(value.reason),failureKind:text(value.failureKind),drainActionId:text(value.drainActionId),manualEconomicSupported:value.manualEconomicSupported===true}
}
