import {randomUUID,createHash} from 'node:crypto'

export const activeActionStates=['RESERVED','DISPATCHED','RUNNING']
const terminal=new Set(['COMPLETED','FAILED','CANCELLED','EXPIRED'])
const decode=r=>r?{...r,metadata:JSON.parse(r.metadata),resourceKeys:JSON.parse(r.resourceKeys)}:null
export const actionSchema=`
CREATE TABLE coreActions(
 actionId TEXT PRIMARY KEY,idempotencyKey TEXT NOT NULL UNIQUE,logicalKey TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('START','STOP','ASSIGN','GENERATE','REPLACE')),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','RUNNING','COMPLETED','FAILED','CANCELLED','EXPIRED')),
 botId INTEGER,accountId INTEGER,role TEXT,quantity INTEGER NOT NULL CHECK(quantity>=0),created INTEGER NOT NULL DEFAULT 0,
 policyRevision INTEGER NOT NULL,desiredRevision INTEGER NOT NULL,inputRevision INTEGER NOT NULL,
 decisionId TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,deadlineAt INTEGER NOT NULL,
 attempt INTEGER NOT NULL,reason TEXT,resourceKeys TEXT NOT NULL CHECK(json_valid(resourceKeys)),metadata TEXT NOT NULL CHECK(json_valid(metadata))
) STRICT;
CREATE UNIQUE INDEX coreActions_active_logical ON coreActions(logicalKey) WHERE state IN ('RESERVED','DISPATCHED','RUNNING');
CREATE INDEX coreActions_state ON coreActions(state,createdAt);
CREATE TABLE coreActionResources(resourceKey TEXT PRIMARY KEY,actionId TEXT NOT NULL REFERENCES coreActions(actionId) ON DELETE CASCADE) STRICT;
CREATE TABLE coreGenerationResults(requestId TEXT PRIMARY KEY,quantity INTEGER NOT NULL,accountIds TEXT NOT NULL CHECK(json_valid(accountIds)),createdAt INTEGER NOT NULL) STRICT;
`

// Durable execution state, separate from the explanatory decision journal.
export default class ActionLedger{
 constructor({store,eventBus}){Object.assign(this,{store,eventBus})}
 get(id){return decode(this.store.prepare('SELECT * FROM coreActions WHERE actionId=?').get(id))}
 active(){return this.store.prepare("SELECT * FROM coreActions WHERE state IN ('RESERVED','DISPATCHED','RUNNING') ORDER BY createdAt,actionId").all().map(decode)}
 recent(limit=50){return this.store.prepare("SELECT * FROM coreActions WHERE state NOT IN ('RESERVED','DISPATCHED','RUNNING') ORDER BY updatedAt DESC LIMIT ?").all(limit).map(decode)}
 resources(){return this.store.prepare('SELECT * FROM coreActionResources ORDER BY resourceKey').all()}
 annotate(id,metadata,{inTransaction=false}={}){const write=()=>{const a=this.get(id);if(!a||terminal.has(a.state))return a;this.store.prepare('UPDATE coreActions SET metadata=?,updatedAt=? WHERE actionId=?').run(JSON.stringify({...a.metadata,...metadata}),Date.now(),id);return this.get(id)};return inTransaction?write():this.store.transaction(write)}
 reserve({type,botId=null,accountId=null,role=null,quantity=1,policyRevision,desiredRevision,inputRevision,decisionId=null,deadlineAt,metadata={},resourceKeys=[],logicalKey}){
  const result=this.store.transaction(()=>{
   const existing=decode(this.store.prepare("SELECT * FROM coreActions WHERE logicalKey=? AND state IN ('RESERVED','DISPATCHED','RUNNING')").get(logicalKey))
   if(existing)return {action:existing,reused:true}
   const keys=[...new Set([...resourceKeys,...(botId!=null?['bot:'+botId]:[]),...(accountId!=null?['account:'+accountId]:[])])].sort()
   for(const key of keys)if(this.store.prepare('SELECT 1 FROM coreActionResources WHERE resourceKey=?').get(key))throw new Error('ACTIVE_CONFLICTING_ACTION')
   const attempt=this.store.prepare('SELECT COALESCE(MAX(attempt),0)+1 n FROM coreActions WHERE logicalKey=?').get(logicalKey).n
   const actionId=randomUUID(),now=Date.now(),idempotencyKey=createHash('sha256').update(JSON.stringify([logicalKey,policyRevision,desiredRevision,attempt])).digest('hex')
   this.store.prepare(`INSERT INTO coreActions(actionId,idempotencyKey,logicalKey,type,state,botId,accountId,role,quantity,policyRevision,desiredRevision,inputRevision,decisionId,createdAt,updatedAt,deadlineAt,attempt,resourceKeys,metadata) VALUES(?,?,?,?,'RESERVED',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(actionId,idempotencyKey,logicalKey,type,botId,accountId,role,quantity,policyRevision,desiredRevision,inputRevision,decisionId,now,now,deadlineAt,attempt,JSON.stringify(keys),JSON.stringify(metadata))
   for(const key of keys)this.store.prepare('INSERT INTO coreActionResources VALUES(?,?)').run(key,actionId)
   this.onReserve?.(this.get(actionId))
   return {action:this.get(actionId),reused:false}
  })
  if(!result.reused)this.emit('created',result.action)
  return result
 }
 claim(actionId,key,{inTransaction=false}={}){const write=()=>{
  const a=this.get(actionId);if(!a||terminal.has(a.state))throw new Error('ACTION_NOT_ACTIVE')
  const owner=this.store.prepare('SELECT actionId FROM coreActionResources WHERE resourceKey=?').get(key)
  if(owner&&owner.actionId!==actionId)throw new Error('ACTIVE_CONFLICTING_ACTION')
  this.store.prepare('INSERT OR IGNORE INTO coreActionResources VALUES(?,?)').run(key,actionId)
  const keys=[...new Set([...a.resourceKeys,key])];this.store.prepare('UPDATE coreActions SET resourceKeys=? WHERE actionId=?').run(JSON.stringify(keys),actionId)
 };return inTransaction?write():this.store.transaction(write)}
 transition(id,state,reason=null,patch={}){
  const changed=this.store.transaction(()=>{
   const a=this.get(id);if(!a||terminal.has(a.state)||a.state===state)return null
   if(!terminal.has(state)&&!({RESERVED:['DISPATCHED'],DISPATCHED:['RUNNING']}[a.state]??[]).includes(state))throw new Error('INVALID_ACTION_TRANSITION')
   this.store.prepare('UPDATE coreActions SET state=?,reason=?,updatedAt=?,created=?,metadata=? WHERE actionId=?').run(state,reason,Date.now(),patch.created??a.created,JSON.stringify({...a.metadata,...patch.metadata}),id)
   if(terminal.has(state))this.store.prepare('DELETE FROM coreActionResources WHERE actionId=?').run(id)
   this.onTransition?.(a,state,reason)
   return this.get(id)
  })
  if(changed)this.emit(state.toLowerCase(),changed)
  return changed??this.get(id)
 }
 emit(kind,action){this.eventBus?.publish('core.action.'+kind,{actionId:action.actionId,type:action.type,state:action.state,botId:action.botId,reason:action.reason})}
 reconcile(actual,{policyRevision,now=Date.now(),startup=false}={}){
  for(const a of this.active()){
   const b=actual.bots.find(b=>b.botId===a.botId),replacement=actual.observation.pending.replacements.rows.find(r=>r.botId===a.botId)
   const generated=this.store.prepare('SELECT * FROM coreGenerationResults WHERE requestId=?').get(a.actionId)
   if(a.type==='GENERATE'&&generated){this.transition(a.actionId,'COMPLETED',null,{created:JSON.parse(generated.accountIds).length});continue}
   const account=a.type==='REPLACE'?replacement?.replacementAccountId:a.accountId
   const taskMatches=!a.metadata.expectedTask||Object.entries(a.metadata.expectedTask).every(([k,v])=>(b?.activeTask?.[k]??null)===v)
   if(['START','REPLACE'].includes(a.type)&&!a.metadata.bindingRequested&&(!a.metadata.lifecycle||a.metadata.spawnIssued&&a.metadata.phase==='starting')&&b?.workReady&&b.role===a.role&&taskMatches&&(account==null||b.accountId===account)&&(!a.metadata.incarnationId||b.incarnationId===a.metadata.incarnationId)){
    this.transition(a.actionId,'COMPLETED');continue
   }
   if(a.type==='STOP'&&b?.observationQuality==='PROCESS_MISSING'){this.transition(a.actionId,'COMPLETED');continue}
   if(a.state==='RESERVED'&&(startup||a.policyRevision!==policyRevision||b?.manualHold)){this.transition(a.actionId,'CANCELLED',startup?'STARTUP_UNDISPATCHED':'STALE_REVISION');continue}
   if(a.type==='REPLACE'&&replacement&&['failed','deficit','cancelled'].includes(replacement.state)){this.transition(a.actionId,replacement.state==='cancelled'?'CANCELLED':'FAILED',replacement.reason??'REPLACEMENT_EXECUTION_FAILED');continue}
   if(a.botId!=null&&!b){this.transition(a.actionId,'CANCELLED','RESOURCE_REMOVED');continue}
   if(now>=a.deadlineAt)this.transition(a.actionId,'EXPIRED','ACTION_TIMEOUT')
  }
 }
 cancelBot(botId){for(const a of this.active().filter(a=>a.botId===botId))this.transition(a.actionId,'CANCELLED','USER_BOT_HOLD')}
 prune(limit){this.store.prepare("DELETE FROM coreActions WHERE state NOT IN ('RESERVED','DISPATCHED','RUNNING') AND actionId NOT IN (SELECT actionId FROM coreActions ORDER BY updatedAt DESC LIMIT ?) AND updatedAt<?").run(limit,Date.now()-7*86400000)}
}
