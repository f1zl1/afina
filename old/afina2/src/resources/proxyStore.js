import {randomUUID} from 'node:crypto'
import {isIP} from 'node:net'

export const proxySchema=`
CREATE TABLE proxies(proxyId INTEGER PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),protocol TEXT NOT NULL CHECK(protocol='socks5'),username TEXT NOT NULL DEFAULT '',password TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL) STRICT;
CREATE TABLE proxyReservations(reservationId TEXT PRIMARY KEY,proxyId INTEGER NOT NULL REFERENCES proxies(proxyId) ON DELETE RESTRICT,botId INTEGER NOT NULL,actionId TEXT NOT NULL,incarnationId TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('RESERVED','RUNNING','RELEASED')),pid INTEGER,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,releasedReason TEXT) STRICT;
CREATE UNIQUE INDEX proxy_bot_owned ON proxyReservations(botId) WHERE state!='RELEASED';
CREATE INDEX proxy_usage ON proxyReservations(proxyId,state);
CREATE TABLE proxyDiagnostics(proxyId INTEGER PRIMARY KEY REFERENCES proxies(proxyId) ON DELETE CASCADE,code TEXT NOT NULL,at INTEGER NOT NULL) STRICT;
`
export function validateProxy(input){
 const p={name:input.name,host:input.host,port:input.port,protocol:input.protocol??'socks5',username:input.username??'',password:input.password??'',active:input.active??true}
 if(typeof p.name!=='string'||!p.name.trim()||p.name.length>100||/[\x00-\x1f\x7f]/.test(p.name))throw new Error('INVALID_PROXY_NAME')
 if(typeof p.host!=='string'||p.host.length>253||!(isIP(p.host)||/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(p.host))||p.host.includes('..'))throw new Error('INVALID_PROXY_HOST')
 if(!Number.isSafeInteger(p.port)||p.port<1||p.port>65535)throw new Error('INVALID_PROXY_PORT')
 if(p.protocol!=='socks5')throw new Error('INVALID_PROXY_PROTOCOL')
 for(const k of ['username','password'])if(typeof p[k]!=='string'||Buffer.byteLength(p[k])>255||/[\x00-\x1f\x7f]/.test(p[k]))throw new Error('INVALID_PROXY_CREDENTIALS')
 if(Boolean(p.username)!==Boolean(p.password))throw new Error('INVALID_PROXY_CREDENTIALS')
 if(typeof p.active!=='boolean')throw new Error('INVALID_PROXY_ACTIVE')
 return {...p,name:p.name.trim()}
}
export const processExists=pid=>{try{process.kill(pid,0);return true}catch(e){return e.code==='ESRCH'?false:null}}
export default class ProxyStore{
 constructor({store,capacity,probe=processExists}){Object.assign(this,{store,capacity,probe});this.connections=new Map()}
 rows(){return this.store.prepare('SELECT * FROM proxies ORDER BY proxyId').all()}
 owned(){return this.store.prepare("SELECT * FROM proxyReservations WHERE state!='RELEASED' ORDER BY createdAt,reservationId").all()}
 public(p){return {proxyId:p.proxyId,name:p.name,host:p.host,port:p.port,protocol:p.protocol,active:Boolean(p.active),hasCredentials:Boolean(p.username),createdAt:p.createdAt,updatedAt:p.updatedAt}}
 save(input){
  return this.store.transaction(()=>{
   const old=input.proxyId==null?null:this.store.prepare('SELECT * FROM proxies WHERE proxyId=?').get(input.proxyId)
   if(input.proxyId!=null&&!old)throw new Error('PROXY_NOT_FOUND')
   const p=validateProxy({...old,...input,active:input.active??(old?Boolean(old.active):true)})
   if(old&&this.owned().some(r=>r.proxyId===old.proxyId)&&['host','port','protocol','username','password'].some(k=>p[k]!==old[k]))throw new Error('PROXY_IN_USE')
   const now=Date.now(),id=old?.proxyId??null
   const row=this.store.prepare(`INSERT INTO proxies VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(proxyId) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,protocol=excluded.protocol,username=excluded.username,password=excluded.password,active=excluded.active,updatedAt=excluded.updatedAt RETURNING *`).get(id,p.name,p.host,p.port,p.protocol,p.username,p.password,Number(p.active),old?.createdAt??now,now)
   return this.public(row)
  })
 }
 remove(proxyId){return this.store.transaction(()=>{if(this.owned().some(r=>r.proxyId===proxyId))throw new Error('PROXY_IN_USE');this.store.prepare("DELETE FROM proxyReservations WHERE proxyId=? AND state='RELEASED'").run(proxyId);if(!this.store.prepare('DELETE FROM proxies WHERE proxyId=?').run(proxyId).changes)throw new Error('PROXY_NOT_FOUND');return {proxyId}})}
 reserve({botId,actionId,incarnationId}){
  return this.store.transaction(()=>{
   if(this.owned().some(r=>r.botId===botId))throw new Error('PROXY_OWNERSHIP_UNRESOLVED')
   const counts=new Map();for(const r of this.owned())counts.set(r.proxyId,(counts.get(r.proxyId)??0)+1)
   const active=this.rows().filter(p=>p.active),p=active.filter(p=>(counts.get(p.proxyId)??0)<this.capacity()).sort((a,b)=>(counts.get(a.proxyId)??0)-(counts.get(b.proxyId)??0)||a.proxyId-b.proxyId)[0]
   if(!p)throw new Error(active.length?'PROXY_CAPACITY_EXHAUSTED':'NO_ELIGIBLE_PROXY')
   const reservationId=randomUUID(),now=Date.now();this.store.prepare('INSERT INTO proxyReservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(reservationId,p.proxyId,botId,actionId,incarnationId,'RESERVED',null,now,now,null)
   return {...validateProxy({...p,active:Boolean(p.active)}),proxyId:p.proxyId,reservationId,incarnationId}
  })
 }
 spawned(incarnationId,pid,confirmed=true){if(Number.isSafeInteger(pid)&&pid>0)this.store.prepare("UPDATE proxyReservations SET pid=?,state=?,updatedAt=? WHERE incarnationId=? AND state='RESERVED'").run(pid,confirmed?'RUNNING':'RESERVED',Date.now(),incarnationId)}
 release(incarnationId,reason){this.clearTransport(incarnationId);this.store.prepare("UPDATE proxyReservations SET state='RELEASED',updatedAt=?,releasedReason=? WHERE incarnationId=? AND state!='RELEASED'").run(Date.now(),reason,incarnationId)}
 clearTransport(incarnationId){this.connections.delete(incarnationId)}
 transport(incarnationId,code,connectionId){
  if(typeof connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(connectionId))return false
  const row=this.owned().find(r=>r.incarnationId===incarnationId&&r.state==='RUNNING');if(!row)return false
  const connections=this.connections.get(incarnationId)??new Map()
  if(code==='PROXY_TRANSPORT_CONNECTED'){if(connections.size>=8)return false;connections.set(connectionId,Date.now())}
  else if(['PROXY_TRANSPORT_CLOSED','PROXY_TRANSPORT_FAILED'].includes(code))connections.delete(connectionId)
  else return false
  this.connections.set(incarnationId,connections);return true
 }
 forBot(botId,currentIncarnationId){
  const row=this.owned().find(r=>r.botId===botId);if(!row)return null
  const p=this.rows().find(p=>p.proxyId===row.proxyId);if(!p)return null
  const current=row.incarnationId===currentIncarnationId,connections=current&&row.state==='RUNNING'?this.connections.get(row.incarnationId):null
  return {proxyId:p.proxyId,label:p.name,host:p.host,port:p.port,protocol:p.protocol,active:Boolean(p.active),reservationState:row.state,incarnationId:row.incarnationId,currentIncarnation:current,transportConnected:Boolean(connections?.size),transportConnectedAt:connections?.size?Math.max(...connections.values()):null,diagnostic:this.store.prepare('SELECT code,at FROM proxyDiagnostics WHERE proxyId=?').get(p.proxyId)??null}
 }
 reconcile(){for(const r of this.owned())if(r.pid&&this.probe(r.pid)===false)this.release(r.incarnationId,'PROCESS_ABSENT')}
 diagnostic(incarnationId,code){if(!['PROXY_AUTHENTICATION_FAILED','PROXY_CONNECTION_FAILED','PROXY_TRANSPORT_FAILED'].includes(code))return;const r=this.owned().find(r=>r.incarnationId===incarnationId);if(r)this.store.prepare('INSERT INTO proxyDiagnostics VALUES(?,?,?) ON CONFLICT(proxyId) DO UPDATE SET code=excluded.code,at=excluded.at').run(r.proxyId,code,Date.now())}
 snapshot(){
  const owned=this.owned(),capacity=this.capacity(),diagnostics=this.store.prepare('SELECT * FROM proxyDiagnostics').all()
  const proxies=this.rows().map(p=>{const allocations=owned.filter(r=>r.proxyId===p.proxyId),used=allocations.length,blocker=!p.active?'PROXY_INACTIVE':used>=capacity?'PROXY_CAPACITY_EXHAUSTED':null;return {...this.public(p),capacity,used,reserved:allocations.filter(r=>r.state==='RESERVED').length,running:allocations.filter(r=>r.state==='RUNNING').length,available:p.active?Math.max(0,capacity-used):0,overCapacity:used>capacity,blocker,allocations,diagnostic:diagnostics.find(d=>d.proxyId===p.proxyId)??null,status:!p.active?'Вимкнений':used>=capacity?'Заповнений':used?'Використовується':'Активний'}})
  return {maximumBotsPerProxy:capacity,configured:proxies.length,active:proxies.filter(p=>p.active).length,used:owned.length,available:proxies.reduce((n,p)=>n+p.available,0),proxies}
 }
}
