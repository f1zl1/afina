import { TelegramClient, Api } from "teleproto"
import { StringSession } from "teleproto/sessions/index.js"
import { NewMessage } from "teleproto/events/index.js"
import { Logger } from "teleproto/extensions/Logger.js"
import { computeCheck } from "teleproto/Password.js"
import { telegramError } from "./telegramErrors.js"

export function channelDestination(value){
    if(typeof value !== "string") return null
    try{
        const url=new URL(value)
        if(url.username || url.password || url.port || url.hash) return null
        let username,invite
        if(url.protocol === "tg:"){
            if(url.hostname === "resolve") username=url.searchParams.get("domain")
            else if(url.hostname === "join") invite=url.searchParams.get("invite")
        }else if(["https:","http:"].includes(url.protocol) && ["t.me","telegram.me"].includes(url.hostname)){
            const part=url.pathname.replace(/\/$/,"")
            invite=part.match(/^\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)$/)?.[1]
            if(!invite) username=part.match(/^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/\d+)?$/)?.[1]
        }
        if(invite && /^[A-Za-z0-9_-]+$/.test(invite)) return {kind:"invite",value:invite}
        if(username && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) return {kind:"public",value:username.toLowerCase()}
    }catch{}
    return null
}

function subscriptionDestination(message){
    const urls=[]
    for(const row of message.replyMarkup?.rows ?? []) for(const button of row.buttons){
        if(button instanceof Api.KeyboardInlineButton && button.type instanceof Api.InlineButtonTypeUrl) urls.push(button.type.url)
    }
    if(message.media?.webpage?.url) urls.push(message.media.webpage.url)
    for(const entity of message.entities ?? []){
        if(entity instanceof Api.MessageEntityTextUrl) urls.push(entity.url)
        else if(entity instanceof Api.MessageEntityUrl) urls.push((message.message ?? "").slice(entity.offset,entity.offset+entity.length))
    }
    const destinations=new Map(urls.map(channelDestination).filter(Boolean).map(value=>[`${value.kind}:${value.value}`,value]))
    return destinations.size === 1 ? [...destinations.values()][0] : null
}

// The only MTProto boundary. No raw events, credentials or errors reach public logs.
export default class MtprotoClient{
    constructor({apiId, apiHash, session = ""}){
        this.credentials = {apiId,apiHash}
        this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
            baseLogger:new Logger("none"), connectionRetries:2, requestRetries:3,
            timeout:8, retryDelay:1000, floodSleepThreshold:0, autoReconnect:true
        })
        this.client.onError = async () => {}
    }
    get connected(){return this.client.connected === true}
    connect(){return this.client.connect()}
    async authorized(){
        // checkAuthorization() swallows network failures as false. Preserve the
        // RPC error so a temporary outage never invalidates a saved session.
        await this.client.invoke(new Api.updates.GetState())
        return true
    }
    save(){return this.client.session.save()}
    close(){return this.client.destroy()}
    async sendCode(phone){
        const result = await this.client.sendCode(this.credentials, phone)
        if(result.emailRequired || result.emailCodeSent) throw telegramError("TELEGRAM_EMAIL_AUTH_UNSUPPORTED", "Telegram requires email verification; this authorization method is not supported yet.")
        return result.phoneCodeHash
    }
    async signIn(phone, phoneCodeHash, code){
        const result = await this.client.invoke(new Api.auth.SignIn({phoneNumber:phone,phoneCodeHash,phoneCode:code}))
        if(result instanceof Api.auth.AuthorizationSignUpRequired) throw telegramError("TELEGRAM_EXISTING_ACCOUNT_REQUIRED", "Register this Telegram account in the official app first.")
    }
    async password(password){
        const params = await this.client.invoke(new Api.account.GetPassword())
        const check = await computeCheck(params, password)
        await this.client.invoke(new Api.auth.CheckPassword({password:check}))
    }
    async identity(){
        const user = await this.client.getMe()
        if(user.bot || !user.phone) throw telegramError("TELEGRAM_USER_ACCOUNT_REQUIRED")
        return {phone:"+" + user.phone.replace(/^\+/, "")}
    }
    async listen(handler){
        const peer = await this.client.getEntity("FunAuthBot")
        if(!peer.bot || String(peer.username).toLowerCase() !== "funauthbot") throw telegramError("FUNAUTH_PEER_INVALID")
        this.peer = peer
        const peerId = peer.id.toString()
        this.client.addEventHandler(async event => {
            const message = event.message
            if(!message || message.out || !message.isPrivate || message.senderId?.toString() !== peerId || message.chatId?.toString() !== peerId) return
            const buttons = (message.replyMarkup?.rows ?? []).flatMap(row => row.buttons)
                .filter(button => button instanceof Api.KeyboardInlineButton && button.type instanceof Api.InlineButtonTypeCallback)
            await handler({
                id:String(message.id), senderId:peerId, chatId:peerId, peerId,
                text:message.message ?? "", date:Number(message.date) * 1000,
                replyToMessageId:message.replyTo?.replyToMsgId == null ? null : String(message.replyTo.replyToMsgId),
                subscriptionDestination:subscriptionDestination(message),
                buttons:buttons.map(button => button.text),
                // Only a real callback button from this exact message; never URL/recovery buttons.
                accept:async () => {
                    const button = buttons.find(button => button.text === "Принять")
                    if(!button) throw telegramError("TELEGRAM_ACCEPT_BUTTON_MISSING")
                    await this.client.invoke(new Api.messages.GetBotCallbackAnswer({peer, msgId:message.id, data:button.type.data}))
                }
            })
        }, new NewMessage({incoming:true}))
    }
    sendBinding(nick, password){
        return this.client.sendMessage(this.peer, {message:`/bind ${nick} ${password}`, parseMode:false})
    }
    async joinChannel(destination, stillActive = () => true){
        const guard=()=>{if(!stillActive()) throw telegramError("TELEGRAM_OPERATION_CANCELLED")}
        const isChannel=chat=>chat instanceof Api.Channel && chat.broadcast && !chat.megagroup
        guard()
        try{
            if(destination?.kind === "public" && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(destination.value)){
                const channel=await this.client.getEntity(destination.value)
                if(!isChannel(channel)) throw telegramError("TELEGRAM_DESTINATION_NOT_CHANNEL")
                guard()
                if(!channel.left) return
                const result=await this.client.invoke(new Api.channels.JoinChannel({channel}))
                if(result instanceof Api.messages.ChatInviteJoinResultWebView) throw telegramError("TELEGRAM_JOIN_VERIFICATION_REQUIRED")
                return
            }
            if(destination?.kind === "invite" && /^[A-Za-z0-9_-]+$/.test(destination.value)){
                const invite=await this.client.invoke(new Api.messages.CheckChatInvite({hash:destination.value}))
                guard()
                if(invite instanceof Api.ChatInviteAlready){
                    if(!isChannel(invite.chat)) throw telegramError("TELEGRAM_DESTINATION_NOT_CHANNEL")
                    return
                }
                const channel=invite instanceof Api.ChatInvitePeek ? invite.chat : invite
                if(!channel.broadcast || channel.megagroup) throw telegramError("TELEGRAM_DESTINATION_NOT_CHANNEL")
                if(invite.subscriptionPricing) throw telegramError("STARS_PAYMENT_REQUIRED")
                const result=await this.client.invoke(new Api.messages.ImportChatInvite({hash:destination.value}))
                if(result instanceof Api.messages.ChatInviteJoinResultWebView) throw telegramError("TELEGRAM_JOIN_VERIFICATION_REQUIRED")
                return
            }
            throw telegramError("TELEGRAM_CHANNEL_LINK_MISSING")
        }catch(error){
            if(error?.errorMessage === "USER_ALREADY_PARTICIPANT") return
            throw error
        }
    }
}
