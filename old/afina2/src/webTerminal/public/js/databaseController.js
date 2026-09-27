import TelegramAuthorization from "./telegramAuthorization.js"
const el = id => document.getElementById(id)
const tableHelp = {
    telegramAccounts: "Особисті Telegram-акаунти для @FunAuthBot. Максимум 8 Minecraft-акаунтів на номер. Сесії приховані; додавання та повторна авторизація — через код Telegram.",
    botData: "Акаунт, сервер, анархія та профіль належать боту. Перед зміною акаунта зупиніть бота.",
    accountsData: "Облікові дані для входу. Заміна акаунта не змінює завдання або сервер бота.",
    tasksData: "Одне завдання на бота через botId. NULL — непризначене завдання. Для reseller потрібні предмет і додатні ціни купівлі та продажу; enabled=0 вимикає виконання.",
    resellerSettings: "Загальні значення. Профіль і персональні налаштування бота мають вищий пріоритет.",
    settingProfiles: "Створіть профіль, додайте його параметри в profileSettings і вкажіть settingsProfileId у ботів.",
    profileSettings: "Параметри спільного профілю. settingName і тип значення мають відповідати resellerSettings.",
    botSettings: "Персональні параметри бота за botId. Перевизначають профіль і загальні значення.",
    changeLog: "Історія змін даних. Паролі замасковані; журнал доступний лише для перегляду.",
    migrationIssues: "Примітки перенесення старих даних. Оригінали збережені у резервних копіях."
}
function node(tag, text = "", className = ""){
    const element = document.createElement(tag)
    element.textContent = text
    element.className = className
    return element
}

export default class DatabaseController{
    constructor({api, onChanged}){
        this.api = api
        this.onChanged = onChanged
        this.selection = null
        this.offset = 0
        this.version = 0
        this.visible = false
        this.saving = false
        this.catalog = null
        this.data = null
        this.telegramAuthorization = new TelegramAuthorization({api,onComplete:async data=>{
            this.message(data.status === "connected" ? "Telegram підключено. Акаунт доступний для прив’язок." : "Авторизацію збережено. З’єднання з @FunAuthBot буде повторено автоматично.")
            await this.refresh()
        }})
        el("databaseRefresh").onclick = () => this.refresh().catch(error => this.message(error.message, true))
        el("databaseAdd").onclick = () => this.data?.table === "telegramAccounts" ? this.telegramAuthorization.open() : this.edit(null)
        el("databasePrevious").onclick = () => this.page(-50)
        el("databaseNext").onclick = () => this.page(50)
        el("databaseSearch").oninput = () => {
            clearTimeout(this.searchTimer)
            this.version++
            this.offset = 0
            this.searchTimer = setTimeout(() => this.refresh().catch(error => this.message(error.message, true)), 250)
        }
        el("databaseCancel").onclick = () => el("databaseDialog").close()
        el("databaseDialog").addEventListener("cancel", event => {if(this.saving) event.preventDefault()})
        el("databaseForm").onsubmit = event => {event.preventDefault(); this.save()}
        el("generateAccountsForm").onsubmit = event => {event.preventDefault(); this.generateAccounts()}
        this.timer = setInterval(() => {
            if(this.visible && this.api.isConnected() && !this.saving){
                this.refresh().catch(error => this.message(error.message, true))
            }
        }, 3000)
    }

    async show(){
        this.visible = true
        try{
            if(!this.catalog){
                const response = await this.api.request("query", "database.catalog")
                if(!response.ok) throw new Error(response.error.message)
                this.catalog = response.data
                this.renderCatalog()
                const first = this.catalog.find(db => db.tables.length)
                if(first) this.selection = {database: first.database, table: first.tables[0].table}
            }
            await this.refresh()
        }catch(error){this.message(error.message, true)}
    }

    renderCatalog(){
        const container = el("databaseTables")
        container.replaceChildren()
        for(const database of this.catalog){
            container.append(node("h3", database.database))
            for(const {table} of database.tables){
                const button = node("button", table, "database-table-button")
                button.dataset.database = database.database
                button.dataset.table = table
                button.onclick = () => {
                    this.selection = {database: database.database, table}
                    this.offset = 0
                    this.version++
                    this.data = null
                    el("databaseSearch").value = ""
                    this.message("")
                    this.refresh().catch(error => this.message(error.message, true))
                }
                container.append(button)
            }
        }
    }

    async refresh(){
        if(!this.selection || !this.api.isConnected()) return
        const version = ++this.version
        const response = await this.api.request("query", "database.read", {
            ...this.selection, offset: this.offset, search: el("databaseSearch").value
        })
        if(version !== this.version) return
        if(!response.ok) throw new Error(response.error.message)
        if(this.offset && this.offset >= response.data.total){
            this.offset = Math.max(0, Math.floor((response.data.total - 1) / 50) * 50)
            return this.refresh()
        }
        if(JSON.stringify(this.data) === JSON.stringify(response.data)) return
        this.data = response.data
        this.render()
    }

    render(){
        const {columns, rows, total, table, database} = this.data
        el("databaseTitle").textContent = table
        el("databaseSummary").textContent = `${database} / ${columns.length} полів / ${total} записів${this.data.readOnly ? " · лише перегляд" : ""}`
        el("databaseAdd").disabled = this.data.readOnly && table !== "telegramAccounts"
        el("databaseAdd").textContent = table === "telegramAccounts" ? "+ Telegram-акаунт" : "+ Запис"
        el("generateAccountsForm").classList.toggle("hidden", !["accountsData","accountPoolState"].includes(table))
        el("databaseTableHelp").textContent = tableHelp[table] ?? ""
        for(const button of el("databaseTables").querySelectorAll("button")){
            button.classList.toggle("active", button.dataset.database === database && button.dataset.table === table)
        }
        const heading = node("tr")
        for(const column of columns) heading.append(node("th", column.name))
        heading.append(node("th", "Дії"))
        el("databaseHead").replaceChildren(heading)
        el("databaseRows").replaceChildren()
        for(const row of rows){
            const tr = node("tr")
            for(const column of columns){
                const value = row.values[column.name]
                const secret = /password|token|secret/i.test(column.name)
                const td = node("td", value === null ? "NULL" : secret ? "••••••••" : column.name === "linkedMinecraftAccounts" ? `${value} / 8` : String(value))
                if(value === null) td.classList.add("database-null")
                if(!secret) td.title = value === null ? "NULL" : String(value)
                tr.append(td)
            }
            const actions = node("td", "", "database-row-actions")
            const edit = node("button", "Змінити")
            edit.onclick = () => this.edit(row)
            const remove = node("button", "Видалити", "danger-button")
            remove.onclick = () => this.remove(row)
            if(!this.data.readOnly) actions.append(edit, remove)
            if(table === "telegramAccounts"){
                const authorize = node("button","Авторизувати")
                authorize.onclick=()=>this.telegramAuthorization.open(row.values.phone)
                remove.disabled=row.values.linkedMinecraftAccounts>0
                remove.title=remove.disabled ? "Спочатку приберіть прив’язки Minecraft-акаунтів." : ""
                const active=node('button',row.values.active?'Вимкнути':'Увімкнути')
                active.onclick=async()=>{try{const response=await this.api.request('command','telegram.setActive',{telegramAccountId:row.values.telegramAccountId,active:!row.values.active});if(!response.ok)throw new Error(response.error.message);await this.refresh()}catch(error){this.message(error.message,true)}}
                actions.append(node('span',row.values.active?'Активний — доступний для нових призначень':'Вимкнений — нові прив’язки заборонено'),authorize,active,remove)
            }
            tr.append(actions)
            el("databaseRows").append(tr)
        }
        if(!rows.length){
            const tr = node("tr")
            const td = node("td", "Записів немає")
            td.colSpan = columns.length + 1
            tr.append(td)
            el("databaseRows").append(tr)
        }
        el("databasePageInfo").textContent = `${total ? this.offset + 1 : 0}–${this.offset + rows.length} / ${total}`
        el("databasePrevious").disabled = this.offset === 0
        el("databaseNext").disabled = this.offset + rows.length >= total
    }

    page(delta){
        this.offset = Math.max(0, this.offset + delta)
        this.refresh().catch(error => this.message(error.message, true))
    }

    edit(row){
        if(!this.data || this.data.readOnly || this.saving) return
        this.editing = {row, database: this.data.database, table: this.data.table}
        this.fields = []
        el("databaseFields").replaceChildren()
        el("databaseFormError").textContent = ""
        el("databaseDialogTitle").textContent = `${row ? "Редагувати" : "Додати"}: ${this.data.table}`
        for(const column of this.data.columns){
            if(column.readOnly) continue
            const label = node("label")
            label.append(node("span", `${column.name} · ${column.type || "ANY"}${column.pk ? " · ключ" : ""}`))
            const value = row?.values[column.name]
            let input
            const options = this.data.table === "tasksData" && column.name === "type"
                ? ["reseller", "test", "afk"]
                : column.name === "settingType" ? ["integer", "float", "boolean", "string", "json"] : null
            if(options){
                input = node("select")
                if(value != null && !options.includes(String(value))) options.push(String(value))
                for(const option of options) input.append(new Option(option, option))
            }else{
                input = node(column.name === "matcher" || String(value ?? "").length > 100 ? "textarea" : "input")
                if(input.tagName === "INPUT") input.type = /password|token|secret/i.test(column.name) ? "password" : "text"
            }
            input.value = value == null || column.writeOnly ? "" : String(value)
            if(column.writeOnly && row) input.placeholder="Залиште порожнім, щоб зберегти пароль"
            input.autocomplete = "off"
            const mode = node("select", "", "database-value-mode")
            mode.setAttribute("aria-label", `${column.name}: спосіб запису`)
            mode.append(new Option("Значення", "value"))
            if(!column.notnull) mode.append(new Option("NULL", "null"))
            if(!row) mode.append(new Option("За замовчуванням / авто", "default"))
            mode.value = row ? value === null ? "null" : "value" : column.pk || column.dflt_value !== null ? "default" : "value"
            const update = () => {
                input.disabled = mode.value !== "value"
            }
            mode.onchange = update
            update()
            label.append(input, mode)
            if(input.type === "password"){
                const reveal = node("button", "Показати / приховати")
                reveal.type = "button"
                reveal.onclick = () => {input.type = input.type === "password" ? "text" : "password"}
                label.append(reveal)
            }
            el("databaseFields").append(label)
            this.fields.push({column, input, mode})
        }
        el("databaseDialog").showModal()
    }

    async save(){
        if(this.saving) return
        const {row, database, table} = this.editing
        const values = {}
        for(const {column, input, mode} of this.fields){
            if(column.writeOnly && row && input.value === "") continue
            if(mode.value === "default") continue
            let value = mode.value === "null" ? null : input.value
            if(value !== null && /INT|REAL|FLOA|DOUB|NUM/i.test(column.type) && value.trim() !== "" && Number.isFinite(Number(value))){
                value = Number(value)
            }
            if(!row || value !== row.values[column.name]) values[column.name] = value
        }
        if(row && !Object.keys(values).length){el("databaseDialog").close(); return}
        this.saving = true
        el("databaseSave").disabled = true
        el("databaseCancel").disabled = true
        el("databaseFormError").textContent = ""
        try{
            const response = await this.api.request("command", "database.mutate", {
                database, table, operation: row ? "update" : "insert",
                rowId: row?.rowId, expectedRevision: row?.revision, values
            })
            if(!response.ok) throw new Error(response.error.message)
            el("databaseDialog").close()
            this.message(response.data.syncError ? `Збережено. Оновлення ботів: ${response.data.syncError}` : "Зміни збережено. Налаштування ботів перевірено.", Boolean(response.data.syncError))
            await this.refresh()
            this.onChanged()
        }catch(error){el("databaseFormError").textContent = error.message}
        finally{
            this.saving = false
            el("databaseSave").disabled = false
            el("databaseCancel").disabled = false
        }
    }

    async remove(row){
        if(this.saving || !window.confirm(`Видалити запис #${row.rowId} з ${this.data.table}?`)) return
        const {database, table} = this.data
        this.saving = true
        try{
            const response = table === "telegramAccounts"
                ? await this.api.request("command","telegram.delete",{telegramAccountId:row.values.telegramAccountId})
                : await this.api.request("command", "database.mutate", {
                database, table, operation: "delete", rowId: row.rowId, expectedRevision: row.revision
            })
            if(!response.ok) throw new Error(response.error.message)
            this.message("Запис видалено.")
            await this.refresh()
            this.onChanged()
        }catch(error){this.message(error.message, true)}
        finally{this.saving = false}
    }

    async generateAccounts(){
        if(this.saving) return
        const count = Number(el("generateAccountsCount").value)
        if(!Number.isInteger(count) || count < 1 || count > 100){
            this.message("Вкажіть кількість від 1 до 100.",true)
            return
        }
        this.saving = true
        el("generateAccountsButton").disabled = true
        let created = false
        try{
            const response = await this.api.request("command","accounts.generate",{count})
            if(!response.ok) throw new Error(response.error?.message ?? "Не вдалося створити акаунти.")
            created = true
            const accounts = response.data.accounts
            this.message(`Створено акаунтів: ${response.data.count}. ${accounts.slice(0,5).map(account=>account.username).join(", ")}${accounts.length>5 ? "…" : ""}. Статус у пулі: available.`)
            // Show the newest records without an old search hiding them.
            this.selection = {database:"accounts",table:"accountsData"}
            el("databaseSearch").value = ""
            const page = await this.api.request("query","database.read",{...this.selection,limit:1})
            if(page.ok) this.offset = Math.max(0,Math.floor((page.data.total-1)/50)*50)
            await this.refresh()
            this.onChanged()
        }catch(error){
            this.message(created ? "Акаунти створено, але таблиця не оновилася. Натисніть «Оновити»." : error.message,true)
        }finally{
            this.saving = false
            el("generateAccountsButton").disabled = false
        }
    }

    message(text, error = false){
        el("databaseMessage").textContent = text
        el("databaseMessage").classList.toggle("error", error)
    }
}
