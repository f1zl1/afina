export const economicSchema=`CREATE TABLE IF NOT EXISTS economicWorkloads(
 workloadId TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, itemId INTEGER NOT NULL REFERENCES itemsData(itemId),
 botId INTEGER REFERENCES botData(botId), status TEXT NOT NULL CHECK(status IN ('PENDING','ADMITTED','RUNNING','DRAINING','COMPLETED','FAILED','CANCELLED','UNCERTAIN')),
 createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)));
 CREATE UNIQUE INDEX IF NOT EXISTS economic_active_bot ON economicWorkloads(botId) WHERE status IN ('ADMITTED','RUNNING','DRAINING','UNCERTAIN');`
const decode=r=>r?{source:'MANUAL',...JSON.parse(r.document),botId:r.botId,status:r.status,updatedAt:r.updatedAt}:null
export default class EconomicStore{
 constructor(store){this.store=store;store.db.exec('PRAGMA synchronous=FULL')}
 get(id){return decode(this.store.prepare('SELECT * FROM economicWorkloads WHERE workloadId=?').get(id))}
 request(id){return decode(this.store.prepare('SELECT * FROM economicWorkloads WHERE requestId=?').get(id))}
 plan(id){return decode(this.store.prepare("SELECT * FROM economicWorkloads WHERE json_extract(document,'$.sourcePlanId')=?").get(id))}
 rows(){return this.store.prepare('SELECT * FROM economicWorkloads ORDER BY createdAt,workloadId').all().map(decode)}
 save(row){const next={...row,updatedAt:Date.now()};this.store.prepare(`INSERT INTO economicWorkloads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workloadId) DO UPDATE SET botId=excluded.botId,status=excluded.status,updatedAt=excluded.updatedAt,document=excluded.document`).run(next.workloadId,next.requestId,next.itemId,next.botId,next.status,next.createdAt,next.updatedAt,JSON.stringify(next));return next}
}
