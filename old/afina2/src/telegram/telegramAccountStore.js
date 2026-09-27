import { telegramError } from "./telegramErrors.js"

export default class TelegramAccountStore{
    constructor(store){this.store = store}
    all(){return this.store.prepare("SELECT * FROM telegramAccounts ORDER BY createdAt,telegramAccountId").all()}
    get(id){return this.store.prepare("SELECT * FROM telegramAccounts WHERE telegramAccountId=?").get(id)}
    account(id){return this.store.prepare("SELECT * FROM accountsData WHERE accountId=?").get(id)}
    count(id){return this.store.prepare("SELECT count(*) AS n FROM accountsData WHERE telegramAccountId=?").get(id).n}
    save(phone, session){
        // Reauthorization preserves the ID and all existing Minecraft assignments.
        return this.store.prepare(`INSERT INTO telegramAccounts(phone,session,status) VALUES(?,?,'disconnected')
            ON CONFLICT(phone) DO UPDATE SET session=excluded.session,status='disconnected'
            RETURNING telegramAccountId`).get(phone, session).telegramAccountId
    }
    status(id, status){
        this.store.prepare("UPDATE telegramAccounts SET status=? WHERE telegramAccountId=? AND status!=?").run(status,id,status)
    }
    session(id, session){this.store.prepare("UPDATE telegramAccounts SET session=? WHERE telegramAccountId=? AND session!=?").run(session,id,session)}
    setActive(id,active){if(typeof active!=='boolean')throw telegramError('INVALID_TELEGRAM_ACTIVE');if(!this.get(id))throw telegramError('TELEGRAM_ACCOUNT_NOT_FOUND');this.store.prepare('UPDATE telegramAccounts SET active=? WHERE telegramAccountId=?').run(Number(active),id);return {telegramAccountId:id,active}}
    assign(accountId, availableIds){
        return this.store.transaction(() => {
            const account = this.account(accountId)
            if(!account) throw telegramError("MINECRAFT_ACCOUNT_NOT_FOUND")
            if(account.telegramAccountId !== null){if(!this.get(account.telegramAccountId)?.active)throw telegramError('TELEGRAM_ACCOUNT_INACTIVE');return {telegramAccountId:account.telegramAccountId,changed:false}}
            const candidate = this.store.prepare(`SELECT t.telegramAccountId FROM telegramAccounts t
                WHERE t.active=1 AND t.status='connected' AND t.session!='' AND
                (SELECT count(*) FROM accountsData a WHERE a.telegramAccountId=t.telegramAccountId)<8
                ORDER BY t.createdAt,t.telegramAccountId`).all().find(t => availableIds.has(t.telegramAccountId))
            if(!candidate) throw telegramError("telegram:noAvailableAccount", "No Telegram capacity available. Add another Telegram account.")
            this.store.prepare("UPDATE accountsData SET telegramAccountId=? WHERE accountId=?").run(candidate.telegramAccountId,accountId)
            return {...candidate,changed:true}
        })
    }
    remove(id){
        return this.store.transaction(() => {
            const count = this.count(id)
            if(count) throw telegramError("TELEGRAM_ACCOUNT_IN_USE", `Telegram account is linked to ${count} Minecraft accounts.`)
            if(!this.get(id)) throw telegramError("TELEGRAM_ACCOUNT_NOT_FOUND")
            this.store.prepare("DELETE FROM telegramAccounts WHERE telegramAccountId=?").run(id)
        })
    }
}
