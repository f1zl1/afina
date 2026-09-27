const el = id => document.getElementById(id)

export default class TelegramAuthorization{
    constructor({api,onComplete}){
        this.api=api
        this.onComplete=onComplete
        this.authRequestId=null
        this.busy=false
        el("telegramAuthForm").onsubmit=event=>{event.preventDefault();void this.submit()}
        el("telegramAuthCancel").onclick=()=>this.cancel()
        el("telegramAuthDialog").addEventListener("cancel",event=>{event.preventDefault();if(!this.busy) this.cancel()})
    }
    open(phone=""){
        this.state="PHONE_REQUIRED"
        this.authRequestId=null
        el("telegramAuthError").textContent=""
        this.render()
        el("telegramAuthValue").value=phone
        el("telegramAuthDialog").showModal()
        el("telegramAuthValue").focus()
    }
    render(){
        const input=el("telegramAuthValue")
        input.value=""
        input.type=this.state === "PHONE_REQUIRED" ? "tel" : "password"
        input.autocomplete="off"
        input.inputMode=this.state === "PASSWORD_REQUIRED" ? "text" : this.state === "PHONE_REQUIRED" ? "tel" : "numeric"
        input.maxLength=this.state === "PASSWORD_REQUIRED" ? 256 : 16
        input.placeholder=this.state === "PHONE_REQUIRED" ? "+4712345678" : ""
        el("telegramAuthLabel").textContent={PHONE_REQUIRED:"Номер телефону Telegram",CODE_REQUIRED:"Код підтвердження Telegram",PASSWORD_REQUIRED:"Пароль двоетапної перевірки (2FA)"}[this.state]
        el("telegramAuthHint").textContent=this.state === "PHONE_REQUIRED"
            ? "Додайте наявний особистий Telegram-акаунт. Для повторної авторизації введіть той самий номер."
            : "Введіть дані до завершення 5 хвилин. Код і пароль не зберігаються."
        el("telegramAuthSubmit").textContent=this.state === "PHONE_REQUIRED" ? "Отримати код" : "Підтвердити"
    }
    async submit(){
        if(this.busy) return
        this.busy=true
        el("telegramAuthSubmit").disabled=true
        el("telegramAuthCancel").disabled=true
        el("telegramAuthError").textContent=""
        const input=el("telegramAuthValue")
        const action={PHONE_REQUIRED:"startAuthorization",CODE_REQUIRED:"submitCode",PASSWORD_REQUIRED:"submitPassword"}[this.state]
        const key={PHONE_REQUIRED:"phone",CODE_REQUIRED:"code",PASSWORD_REQUIRED:"password"}[this.state]
        const payload={authRequestId:this.authRequestId,[key]:input.value}
        input.value=""
        try{
            const promise=this.api.request("command",`telegram.${action}`,payload)
            delete payload[key]
            const response=await promise
            if(!response.ok) throw new Error(response.error.message)
            if(response.data.state === "AUTHORIZED"){
                this.authRequestId=null
                el("telegramAuthDialog").close()
                await this.onComplete(response.data)
            }else{
                this.authRequestId=response.data.authRequestId
                this.state=response.data.state
                this.render()
                input.focus()
            }
        }catch(error){el("telegramAuthError").textContent=error.message}
        finally{delete payload[key];this.busy=false;el("telegramAuthSubmit").disabled=false;el("telegramAuthCancel").disabled=false}
    }
    cancel(){
        if(this.busy) return
        if(this.authRequestId) void this.api.request("command","telegram.cancelAuthorization",{authRequestId:this.authRequestId}).catch(()=>{})
        this.authRequestId=null
        el("telegramAuthValue").value=""
        el("telegramAuthDialog").close()
    }
}
