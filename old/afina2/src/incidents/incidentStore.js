import {createHash} from 'node:crypto'

export default class IncidentStore{
    constructor(store){this.store=store}
    recordBan(accountId,incident,context={}){
        const i=incident
        const identity=i.punishmentId?'punishment:'+i.punishmentId:JSON.stringify([i.banIssuedAtRaw,i.banReason,
            i.rawMessage?.replace(/разбан\s+через\s*:[^\n]*/gi,'').replace(/\s+/g,' ').trim()])
        const fingerprint=createHash('sha256').update(identity).digest('hex')
        return this.store.transaction(()=>{
            const old=this.store.prepare('SELECT * FROM accountBanHistory WHERE accountId=? AND fingerprint=?').get(accountId,fingerprint)
            if(old){
                const current=this.store.prepare('SELECT banned FROM accountsData WHERE accountId=?').get(accountId)
                if(current?.banned)return {created:false,ban:old}
                // An explicit operator reset does not make a still-banned server identity usable.
                this.store.prepare('UPDATE accountsData SET banned=1,currentBanId=? WHERE accountId=?').run(old.id,accountId)
                this.store.prepare("UPDATE accountPoolState SET status='blocked',reason='ACCOUNT_BANNED',cooldownUntil=NULL WHERE accountId=?").run(accountId)
                return {created:false,reactivated:true,ban:old}
            }
            const account=this.store.prepare('SELECT username FROM accountsData WHERE accountId=?').get(accountId)
            if(!account)throw new Error('ACCOUNT_NOT_FOUND')
            const row=this.store.prepare(`INSERT INTO accountBanHistory(accountId,detectedAt,issuedAt,issuedAtRaw,reason,expiresAt,durationRaw,punishmentId,rawMessage,source,fingerprint,context)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(accountId,i.banDetectedAt ?? i.timestamp,i.banIssuedAt ?? null,i.banIssuedAtRaw ?? null,
                i.banReason ?? null,i.banExpiresAt ?? null,i.banDurationRaw ?? null,i.punishmentId ?? null,i.rawMessage,'funtime',fingerprint,JSON.stringify({nickname:account.username,...context}))
            this.store.prepare('UPDATE accountsData SET banned=1,currentBanId=? WHERE accountId=?').run(row.id,accountId)
            this.store.prepare(`INSERT INTO accountPoolState(accountId,status,reason) VALUES(?,'blocked','ACCOUNT_BANNED')
                ON CONFLICT(accountId) DO UPDATE SET status='blocked',reason='ACCOUNT_BANNED',cooldownUntil=NULL`).run(accountId)
            return {created:true,ban:row}
        })
    }
}
