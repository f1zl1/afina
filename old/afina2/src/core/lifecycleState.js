// Durable intent/backoff, never a cache of process liveness or scheduler state.
export const lifecycleSchema=`
CREATE TABLE coreLifecycle(
 botId INTEGER PRIMARY KEY REFERENCES botData(botId) ON DELETE CASCADE,
 intent TEXT NOT NULL DEFAULT 'stopped' CHECK(intent IN ('running','stopped')),
 owner TEXT NOT NULL DEFAULT 'core' CHECK(owner IN ('core','manual')),
 epoch INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 retryAt INTEGER,lastFailureAt INTEGER,lastStartAt INTEGER,lastStopAt INTEGER,stableSince INTEGER,
 requestReason TEXT,requestIncarnation TEXT,requestAt INTEGER,blockedReason TEXT,
 updatedAt INTEGER NOT NULL
) STRICT;
`

export default class LifecycleState{
 constructor(store){this.store=store}
 get(botId){return this.store.prepare('SELECT * FROM coreLifecycle WHERE botId=?').get(botId)??null}
 rows(){return this.store.prepare('SELECT * FROM coreLifecycle ORDER BY botId').all()}
 update(botId,values){
  const keys=Object.keys(values),allowed=new Set(['intent','owner','epoch','failures','retryAt','lastFailureAt','lastStartAt','lastStopAt','stableSince','requestReason','requestIncarnation','requestAt','blockedReason'])
  if(keys.some(k=>!allowed.has(k)))throw new Error('INVALID_LIFECYCLE_FIELD')
  this.store.prepare('INSERT OR IGNORE INTO coreLifecycle(botId,updatedAt) VALUES(?,?)').run(botId,Date.now())
  this.store.prepare(`UPDATE coreLifecycle SET ${keys.map(k=>k+'=?,').join('')}updatedAt=? WHERE botId=?`).run(...keys.map(k=>values[k]),Date.now(),botId)
  return this.get(botId)
 }
}
