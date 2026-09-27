import {roleLabels,stopModeLabels,startupLabels,weekdays,sectionFields,sectionLabels,help,durationPresentation,durationMilliseconds,deepClone,supportLabels,metadataHelp,explicitPolicyChanges} from './operationsPolicyUi.js'
import {renderProxyResources} from './proxyResourcesUi.js'
const el=id=>document.getElementById(id)
const node=(tag,text="",className="")=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n}
const date=value=>value ? new Date(value).toLocaleTimeString() : "—"
export default class CoreController{
    constructor({api}){
        this.api=api;this.visible=false;this.data=null;this.policyDirty=false;this.overrideDirty=false;this.version=0
        el("coreRefresh").onclick=()=>{this.policyDirty=false;this.overrideDirty=false;this.refresh().catch(e=>this.message(e.message,true))}
        el("corePolicyForm").oninput=()=>{this.policyDirty=true}
        el("coreOverrideForm").oninput=()=>{this.overrideDirty=true}
        el("coreOverrideItem").onchange=()=>{this.overrideDirty=false;this.fillOverride()}
        el("corePolicyForm").onsubmit=e=>{e.preventDefault();void this.savePolicy()}
        el('coreOperationsForm').onsubmit=e=>{e.preventDefault();void this.saveOperations()}
        el('coreOperationsForm').oninput=e=>this.operationsInput(e)
        el('coreOperationsForm').onchange=e=>this.operationsInput(e)
        el('coreOperationsForm').onclick=e=>this.operationsClick(e)
        el('coreOperationsCancel').onclick=()=>this.cancelOperations()
        el('coreOperationsForm').onkeydown=e=>{if(e.key==='Escape')this.closeOperationsHelp()}
        el("coreOverrideForm").onsubmit=e=>{e.preventDefault();void this.saveOverride()}
        el("coreOverrideDelete").onclick=()=>this.deleteOverride()
        el('coreMarketItem').onchange=()=>{this.renderMarketDetails();void this.loadMarketLots()}
        el('coreMarketDiagnostics').ontoggle=()=>{if(el('coreMarketDiagnostics').open) void this.loadMarketLots()}
    }
    async show(){this.visible=true;try{await this.refresh()}catch(error){this.message(error.message,true)}}
    async refresh(){
        if(!this.api.isConnected()) return
        const version=++this.version
        const response=await this.api.request("query","core.getSnapshot")
        if(version!==this.version) return
        if(!response.ok) throw new Error(response.error.message)
        this.data=response.data
        this.render()
    }
    handleEvent(event){
        if(!event.type.startsWith("core.") || !this.visible) return
        if(this.data && event.type.startsWith("core.decision.")){
            const decisions=this.data.recentDecisions
            const index=decisions.findIndex(d=>d.decisionId===event.payload.decisionId)
            if(index>=0) decisions[index]=event.payload
            else decisions.unshift(event.payload)
            this.data.recentDecisions=decisions.slice(0,50)
            this.renderDecisions()
        }
        if(this.data && event.type === "core.status.updated"){
            this.data.status=event.payload;this.renderOverview()
        }
        clearTimeout(this.refreshTimer)
        this.refreshTimer=setTimeout(()=>{if(this.visible) this.refresh().catch(e=>this.message(e.message,true))},150)
    }
    render(){
        this.renderOverview();this.renderObservation();this.renderActions();this.renderCycle();this.renderLifecycle();this.renderWorkloads();this.renderEconomic();renderProxyResources(this);this.renderDecisions();this.renderMarket()
        const data=this.data
        this.renderOperationsSummary();this.renderCapabilities()
        this.renderAutomationDiagnostic()
        if(data.operationsPolicy&&!this.operationsDirty)this.loadOperations(data.operationsPolicy)
        if(!el('coreAccountReplacements')){
            const title=node('h3','Заміна тестових акаунтів'),table=node('div');table.id='coreAccountReplacements'
            el('coreAssessment').after(title,table)
        }
        this.table('coreAccountReplacements',['Бот','Заблокований акаунт','Новий акаунт','Етап','Причина'],(data.accountReplacements ?? []).map(r=>[
            r.botId,r.bannedAccountId,r.replacementAccountId,({requested:'Запитано',generating:'Генерація',created:'Створено',selected:'Вибрано',initializing:'Реєстрація / вхід / готовність',completed:'Роботу відновлено',failed:'Помилка',deficit:'Дефіцит',cancelled:'Скасовано'})[r.state] ?? r.state,r.reason]))
        const reasonLabels={CORE_DISABLED:'Core спостерігає за системою, але не виконує автоматичних змін.',OPERATIONS_POLICY_UPDATED:'Налаштування операційної автоматизації оновлено.',RESELLER_DEFICIT:'Кількість перепродажників нижча за бажану.',ANALYST_DEFICIT:'Кількість аналітиків нижча за бажану.',DESIRED_MATCHES_ACTUAL:'Бажаний і фактичний стани збігаються.'}
        el("coreAssessment").replaceChildren(...data.assessment.map(r=>node("li",reasonLabels[r.code]??r.message)))
        this.table("coreAllocations",["Товар","Desired","Actual","Дефіцит","Надлишок","Стан"],data.allocations.map(a=>[a.name,a.desiredBots,a.actualBots,a.deficit,a.excess,a.status]))
        this.table("coreOverrides",["Товар","Desired / Actual","Min","Max","Forced","Max buy","Min sell","Disabled"],data.overrides.map(o=>{
            const a=data.allocations.find(a=>a.itemId===o.itemId)
            return [a?.name ?? o.itemId,`${a?.desiredBots ?? 0} / ${a?.actualBots ?? 0}`,o.minBots,o.maxBots,o.forcedBots,o.maxBuyPrice,o.minSellPrice,o.disabled ? "Так" : "Ні"]
        }))
        if(!this.policyDirty){this.fields("corePolicyFields",data.fields.policy,data.policy,"corePolicy_");this.policyRevision=data.inputRevision}
        if(!this.overrideDirty){
            const selected=el("coreOverrideItem").value
            el("coreOverrideItem").replaceChildren(...data.actualState.items.map(i=>new Option(i.name,String(i.itemId))))
            if(data.actualState.items.some(i=>String(i.itemId)===selected)) el("coreOverrideItem").value=selected
            this.fillOverride()
        }
        el("coreManualHolds").replaceChildren()
        for(const bot of data.actualState.bots.filter(b=>b.manualHold)){
            const row=node("div",`Бот #${bot.botId}: ручне керування. `,"core-hold")
            const button=node("button","Повернути ядру")
            button.onclick=async()=>{
                try{await this.command("core.bot.release",{botId:bot.botId});await this.refresh()}
                catch(error){this.message(error.message,true)}
            }
            row.append(button);el("coreManualHolds").append(row)
        }
    }
    renderOverview(){
        const s=this.data.status
        const statusLabels={stable:'Стабільно',reconciling:'Синхронізація',degraded:'Обмежений стан',observing:'Спостереження',disabled:'Ядро вимкнено',maintenance:'Обслуговування',evaluating:'Оцінювання',error:'Помилка'}
        const cards=[["Стан",statusLabels[s.status]??s.status],
            ["Перепродажники · готові до роботи / потрібно",`${s.actualResellers ?? 0} / ${s.desiredResellers ?? this.data.effectiveOperationsPolicy?.roles.reseller.target??0}`],
            ["Аналітики · готові до роботи / потрібно",`${s.actualAnalysts ?? 0} / ${s.desiredAnalysts ?? this.data.effectiveOperationsPolicy?.roles.analyst.target??0}`],
            ["Дії · очікують / заблоковані",`${s.pendingActions} / ${s.blockedActions}`],
            ["Остання оцінка",date(s.lastEvaluationAt)],["Останнє рішення",date(s.lastDecisionAt)]]
        const counts=this.data.observationCounts
        if(counts)cards.push(['Процеси / готові до роботи',`${counts.processes} / ${counts.workReady}`],['Непідтверджені спостереження',counts.uncertain])
        el("coreOverview").replaceChildren(...cards.map(([label,value])=>{const card=node("div","","core-stat");card.append(node("span",label),node("strong",String(value)));return card}))
        el("coreActivity").textContent=[s.activity?.phase,s.activity?.trigger?.type].filter(Boolean).join(" · ")
    }
    renderObservation(){
        let root=el('coreObservation')
        if(!root){root=node('details','','core-panel');root.id='coreObservation';el('coreOverview').after(root)}
        const observation=this.data.observation,counts=this.data.observationCounts
        root.replaceChildren(node('summary','Спостереження за процесами та готовністю'))
        if(!observation){root.append(node('p','Спостереження ще не отримано.','muted'));return}
        const metrics=observation.metrics??{}
        root.append(node('p',`Остання повна перевірка: ${date(observation.lastAuthoritativeAt)} · запитано: ${metrics.queried??0} · отримано: ${metrics.refreshed??0} · тайм-аути: ${metrics.timeouts??0} · тривалість: ${metrics.durationMs??0} мс.`))
        if(counts)root.append(node('p',`Процеси: ${counts.processes}; підключені: ${counts.connected}; світ готовий: ${counts.realmReady}; готові до роботи: ${counts.workReady}; невизначені: ${counts.uncertain}.`))
        const rows=node('div','','table-wrapper');rows.style.overflowX='auto';rows.id='coreObservationRows';root.append(rows)
        const quality={FRESH:'Свіже',STALE:'Застаріле',UNAVAILABLE:'Недоступне',PROCESS_MISSING:'Процес відсутній',INCARNATION_MISMATCH:'Інший запуск процесу'}
        const position={realm:'Цільовий світ',lobby:'Лобі',hub:'Лобі',afk:'АФК',authentication:'Вхід',captcha:'Капча',dead:'Загибель',unknown:'Невідомо'}
        const yes=value=>value?'Так':'Ні'
        this.table(rows.id,['Бот','Процес','З’єднання','Положення','Світ готовий','Роль готова','Робота готова','Якість','Останній запит / подія','Остання зміна готовності','Джерело / запуск','Причина'],(this.data.actualState.bots??[]).map(b=>[
            b.botId,yes(b.processAlive),yes(b.minecraftConnected),position[b.positionStatus]??'Невідомо',yes(b.realmReady),yes(b.roleReady),yes(b.workReady),quality[b.observationQuality]??'Невідомо',`${date(b.lastObservedAt)} / ${date(b.lastEventAt)}`,date(b.lastProgressAt),`${b.factSource??'—'} / ${b.incarnationId??'—'}`,b.blocker??'—']))
    }
    renderCycle(){
        let root=el('coreCycle')
        if(!root){root=node('details','','core-panel');root.id='coreCycle';el('coreActions').after(root)}
        root.replaceChildren(node('summary','Планування циклів ядра'))
        const c=this.data.activeCycle??this.data.cycle
        if(!c){root.append(node('p','Цикл ще не завершено.'));return}
        const outcomes={running:'Виконується',completed:'Завершено',deferred:'Відкладено',partial:'Частково виконано',failed:'Помилка',cancelled:'Скасовано',superseded:'Вхідні дані змінилися'}
        const stages={OBSERVE:'Спостереження',ACCOUNT:'Облік переходів',PLAN:'Планування',SELECT:'Вибір',RESERVE:'Резервування',DISPATCH:'Передача виконавцю',SETTLE_WAIT:'Підтвердження / очікування'}
        const budgets={ACTION_LIMIT:'Ліміт дій',CANDIDATE_LIMIT:'Ліміт кандидатів',CYCLE_TIME_BUDGET:'Час циклу вичерпано'}
        root.append(node('p',`Цикл №${c.cycleId} · ${outcomes[c.outcome]??'Невідомо'} · ${stages[c.stage]??'Очікування'}`))
        root.append(node('p',`Початок: ${date(c.startedAt)} · кінець: ${date(c.endedAt)} · тривалість: ${Math.round(c.durationMs??0)} мс · версія входів: ${c.inputRevision??'—'} · версія даних: ${c.dataRevision??'—'} · спостереження: ${date(c.observationAt)}`))
        root.append(node('p',`Кандидатів розглянуто: ${c.candidatesConsidered} · вибрано: ${c.selected} · зарезервовано: ${c.reserved} · передано: ${c.dispatched} · аналізів передано: ${c.workloadDispatched??0} · відкладено: ${c.deferred} · заблоковано: ${c.blocked} · конфліктів: ${c.conflicts} · помилок: ${c.failures?.length??0}`))
        root.append(node('p',`Сигналів об’єднано: ${c.triggerCount??c.coalescedTriggers} · наступний цикл запитано: ${c.anotherCycleRequested?'Так':'Ні'} · обмеження: ${budgets[c.budgetReason]??'Немає'}`))
        root.append(node('p',`Кандидатів у плані: ${c.candidatesProduced??0} · об’єктів поза поточним вікном планування: ${c.unvisited??0}`))
    }
    renderLifecycle(){
        let root=el('coreLifecycle')
        if(!root){root=node('details','','core-panel');root.id='coreLifecycle';el('coreCycle').after(root)}
        root.replaceChildren(node('summary','Керування життєвим циклом ботів'))
        root.append(node('p','Звичайна зупинка чекає безпечного завершення роботи. Тайм-аут не дозволяє примусове завершення. Ручне керування блокує автономне відновлення.'))
        const rows=node('div');rows.id='coreLifecycleRows';rows.style.overflowX='auto';root.append(rows)
        const stops={quiescing:'Завершує роботу',unsafe:'Зупинка небезпечна',safe:'Безпечна зупинка підтверджена'}
        const supervisors={offline:'Поза мережею',stopped:'Зупинено',starting:'Запускається',running:'Працює',quiescing:'Завершує роботу',stopping:'Зупиняється',recovery_pending:'Очікує відновлення',blocked:'Заблоковано'}
        const reasons={MANUAL_OWNERSHIP:'Ручне керування',RECOVERY_BACKOFF:'Пауза після відмови',RECOVERY_EXHAUSTED:'Ліміт спроб вичерпано',TRANSITION_SPACING:'Інтервал між переходами',TRANSITION_CONCURRENCY:'Ліміт одночасних переходів',MINIMUM_LIFETIME:'Мінімальна тривалість роботи / простою',CORE_DISABLED:'Автоматизацію вимкнено',MAINTENANCE_MODE:'Режим обслуговування',TRADING_EXECUTION_DISABLED:'Автономну торгівлю заблоковано'}
        const requests={worker_crash:'Аварія процесу',configuration:'Зміна конфігурації',binding:'Прив’язування акаунта',heartbeat_timeout:'Процес не відповідає',unexpected_stop:'Неочікувана зупинка',disconnect:'З’єднання втрачено'}
        this.table(rows.id,['Бот','Власник','Намір','Дія','Стан наглядача','Запуск процесу','Відмови','Повтор після','Причина запиту','Безпека зупинки','Перешкода','Наступний перехід'],(this.data.lifecycle??[]).map(b=>[
            b.botId,b.owner==='manual'?'Оператор':'Ядро',b.intent==='running'?'Працювати':'Зупинено',b.action?.actionId??'—',supervisors[b.supervisorState]??b.supervisorState??'—',b.incarnationId??'—',b.failures??0,date(b.retryAt),requests[b.requestReason]??b.requestReason??'—',stops[b.stopEvidence?.state]??'Немає підтвердження',b.blockedReason?`${reasons[b.blockedReason]??'Перехід заблоковано'} (${b.blockedReason})`:'—',b.nextTransition??'—']))
    }
    renderWorkloads(){
        let root=el('coreWorkloads')
        if(!root){root=node('details','','core-panel');root.id='coreWorkloads';el('coreLifecycle').after(root)}
        root.replaceChildren(node('summary','Навантаження та безпечне завершення роботи'))
        root.append(node('p','Навантаження виконується лише на дозволеному процесі. Завершення роботи не означає зупинку процесу. Автономна торгівля вимкнена.'))
        const rows=node('div');rows.id='coreWorkloadRows';rows.style.overflowX='auto';root.append(rows)
        const states={IDLE:'Очікує роботу',STARTING:'Приймає завдання',RUNNING:'Виконує роботу',DRAINING:'Завершує поточну роботу',COMPLETED:'Роботу завершено',FAILED:'Помилка роботи',CANCELLED:'Роботу скасовано',UNCERTAIN:'Результат непідтверджений'}
        const roles={analyst:'Аналітик',reseller:'Перепродажник'},owners={core:'Ядро',manual:'Оператор',configured_role:'Налаштована роль'}
        this.table(rows.id,['Бот / роль','Тип / завдання','Стан','Власник','Запуск процесу','Початок / оновлення','Завершує роботу','Безпечна межа','Операція','Причина'],(this.data.workloads??[]).map(w=>[
            `${w.botId} / ${roles[w.role]??w.role??'—'}`,`${w.type??'—'} / ${w.workloadId??'—'}`,states[w.state]??'Невідомо',owners[w.owner]??'—',w.incarnationId??'—',`${date(w.startedAt)} / ${date(w.updatedAt)}`,w.draining?'Так':'Ні',w.uncertain?'Невизначено':w.safe?'Підтверджено':'Не підтверджено',w.operation??'—',w.reason??'—']))
    }
    renderEconomic(){
        let root=el('coreEconomic')
        if(!root){
            root=node('section','','core-panel');root.id='coreEconomic';el('coreWorkloads').after(root)
            root.append(node('h3','Ручне торгове завдання'),node('p','Вкажіть власні ціни. Ядро не визначає прибутковість. Завершення означає купівлю та виставлення, а не продаж. Для нового завдання потрібен перепродажник без ручного утримання та попереднього товару в інвентарі.'))
            const form=node('form');form.id='coreEconomicForm'
            for(const [id,title,tag] of [['Item','Товар','select'],['Bot','Готовий бот','select'],['Buy','Максимальна ціна купівлі за одиницю','input'],['Sell','Ціна виставлення за одиницю','input'],['Quantity','Кількість (1–64)','input']]){
                const label=node('label',title),input=node(tag);input.id='coreEconomic'+id
                if(tag==='input'){input.type='number';input.min='1';input.step='1';input.required=true;if(id==='Quantity')input.max='64'}
                label.append(input);form.append(label)
            }
            const submit=node('button','Подати завдання');submit.type='submit';submit.id='coreEconomicSubmit';form.append(submit);root.append(form)
            const message=node('p');message.id='coreEconomicMessage';root.append(message)
            const rows=node('div');rows.id='coreEconomicRows';rows.style.overflowX='auto';root.append(rows)
            form.oninput=()=>{this.economicRequestId=null}
            form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;this.economicRequestId??=crypto.randomUUID();try{
                const row=await this.command('core.economic.submit',{requestId:this.economicRequestId,itemId:Number(el('coreEconomicItem').value),botId:Number(el('coreEconomicBot').value)||null,maxBuyPricePerItem:Number(el('coreEconomicBuy').value),targetSellPricePerItem:Number(el('coreEconomicSell').value),targetQuantity:Number(el('coreEconomicQuantity').value)})
                message.textContent='Завдання прийнято. Повторення цього запиту не створить другу угоду.';await this.refresh()
            }catch(error){message.textContent='Завдання не прийнято: '+error.message}finally{submit.disabled=false}}
        }
        for(const [id,values] of [['Item',(this.data.actualState?.items??[]).map(i=>[i.itemId,i.name])],['Bot',[[0,'Автоматичний вибір готового бота'],...(this.data.economic?.eligibleBots??[]).map(b=>[b.botId,b.name??b.botId])]]]){
            const input=el('coreEconomic'+id),old=input.value;input.replaceChildren(...values.map(([value,title])=>{const option=node('option',String(title));option.value=String(value);return option}));if(values.some(([v])=>String(v)===old))input.value=old
        }
        const states={PENDING:'Очікує допуску',ADMITTED:'Передано виконавцю',RUNNING:'Виконується',DRAINING:'Безпечно завершується',COMPLETED:'Куплено та виставлено',FAILED:'Помилка / частковий результат',CANCELLED:'Скасовано',UNCERTAIN:'Результат непідтверджений'}
        const rows=el('coreEconomicRows');rows.replaceChildren()
        const readiness=node('div');readiness.id='coreEconomicReadiness';readiness.append(node('p','Старий торговий цикл і автоматичне перевиставлення вимкнені.'))
        for(const b of this.data.economic?.botReadiness??[])readiness.append(node('p',`Бот ${b.botId}: ${b.message} · ${b.reason??'READY_FOR_ADMISSION'} · Працівник: ${b.workerUncertain?'невизначений':b.workerSafe?'безпечна межа підтверджена':'безпека не підтверджена'}`))
        rows.append(readiness)
        for(const w of this.data.economic?.workloads??[]){
            const p=w.progress??{},entry=node('div');entry.append(node('p',`${w.workloadId} [${w.source??'MANUAL'}] · Бот ${w.botId??'—'} · ${states[w.status]??w.status} · Куплено ${p.boughtQuantity??0}/${w.targetQuantity}, виставлено ${p.listedQuantity??0}, сума цін отриманих лотів ${p.purchaseValue??0}; інвентар ${p.remainingInventory??'невідомо'}. Продано, списання коштів та дохід: невідомо. ${p.certainty==='UNCERTAIN'?'Облік непідтверджений. ':''}${w.reason??''}`))
            if(['PENDING','ADMITTED','RUNNING','DRAINING'].includes(w.status)){const cancel=node('button','Скасувати / дочекатися операції');cancel.dataset.workloadId=w.workloadId;cancel.onclick=async()=>{try{await this.command('core.economic.cancel',{workloadId:w.workloadId});await this.refresh()}catch(e){el('coreEconomicMessage').textContent=e.message}};entry.append(cancel)}
            const o=w.operator
            if(o){
                const details=node('details'),summary=node('summary','Докази, залишки та ручна звірка');details.append(summary)
                details.append(node('p',`Товар: ${w.item?.name??w.itemId}; купівля до ${w.maxBuyPricePerItem}, виставлення за ${w.targetSellPricePerItem}, кількість ${w.targetQuantity}. Запуск завдання: ${w.incarnationId??'—'}; поточний: ${o.currentIncarnationId??'—'}.`))
                details.append(node('p',`Остання операція: ${w.operation??'—'}; підтверджена: ${o.confirmedOperation??'—'}. Останній знімок інвентарю: ${o.observedMatchingInventory??'невідомо'} (${date(o.inventoryEvidenceAt)}); підтверджений залишок завдання: ${o.attributedRemainingQuantity??'не встановлено'}; сторонній запас до завдання: ${o.unrelatedInventoryAtStart??'не встановлено'}. Кількість виставлень не є поточним станом лотів.`))
                details.append(node('p',o.unresolvedEffects??'Непідтверджені економічні ефекти не заявлено.'),node('p',o.guidance),node('p',`Допуск: ${o.admissionReason??'READY_FOR_ADMISSION'}. Невизначеність працівника: ${o.workerUncertain?'так — закриття запису її не скидає':'не спостерігається'}.`))
                if(w.residualReview)details.append(node('p',`Перевірив ${w.residualReview.actorId}, ${date(w.residualReview.at)}: ${w.residualReview.note}`))
                entry.append(details)
            }
            if(o?.reviewRequired){
                const note=node('input');note.placeholder='Що перевірено оператором (мінімум 10 символів)';note.dataset.resolutionNote=w.workloadId
                const resolve=node('button',o.reviewKind==='RESIDUAL'?'Записати перевірку залишку':'Зафіксувати перевірку без повтору');resolve.dataset.resolveWorkload=w.workloadId;resolve.disabled=!o.canResolve
                resolve.onclick=async()=>{try{await this.command('core.economic.resolve',{workloadId:w.workloadId,note:note.value});await this.refresh()}catch(e){el('coreEconomicMessage').textContent=e.message}};entry.append(note,resolve)
                if(!o.canResolve)entry.append(node('p','Потрібне підтвердження завершення старого процесу. Спочатку звичайний STOP; примусова зупинка — лише окреме явне рішення оператора. Після неї перевірте відсутність процесу, виконайте звірку та запустіть нового працівника.'))
            }
            rows.append(entry)
        }
    }
    renderActions(){
        let root=el('coreActions')
        if(!root){root=node('details','','core-panel');root.id='coreActions';el('coreObservation').after(root)}
        root.replaceChildren(node('summary','Автономні дії та переходи'))
        const coverage=node('div');coverage.id='coreTransitionCoverage';root.append(coverage)
        this.table(coverage.id,['Роль','Потрібно','Готові до роботи','У процесі','Непокрито','Надлишок'],Object.entries(this.data.transitionAccounting?.roles??{}).map(([role,r])=>[role,r.desired,r.workReady,r.inProgress,r.uncovered,r.overshoot]))
        const labels={START:'Запуск',STOP:'Зупинка',ASSIGN:'Призначення',GENERATE:'Створення акаунтів',REPLACE:'Заміна акаунта',RESERVED:'Зарезервовано',DISPATCHED:'Передано виконавцю',RUNNING:'Виконується',COMPLETED:'Завершено',FAILED:'Помилка',CANCELLED:'Скасовано',EXPIRED:'Час вичерпано'}
        const rows=node('div');rows.id='coreActionRows';rows.style.overflowX='auto';root.append(rows)
        this.table(rows.id,['Дія','Бот / акаунт','Роль','Стан','Створено','Кінцевий термін','Спроба','Версія політики','Кількість / створено','Причина'],[...(this.data.activeActions??[]),...(this.data.recentActions??[])].map(a=>[labels[a.type]??a.type,`${a.botId??'—'} / ${a.accountId??'—'}`,a.role??'—',labels[a.state]??a.state,date(a.createdAt),date(a.deadlineAt),a.attempt,a.policyRevision,`${a.quantity} / ${a.created}`,a.reason??'—']))
    }
    renderLiveValidation(){
        const root=el('coreLiveValidation'),v=this.data.trading?.liveValidation;root.replaceChildren()
        root.append(node('h3','Live validation'))
        if(!v){root.append(node('p','Оцінка backend ще недоступна.'));return}
        root.append(node('p',`Live validation: ${v.policy.enabled?'Увімкнено':'Вимкнено'} · Товар: ${v.policy.itemId??'—'} · Максимальна кількість: 1 · Максимальна покупка: ${v.policy.maxPurchaseCommitment??'не задано'} · Fuse: ${v.fuse.state}`))
        const labels={VALIDATION_ENABLED:'Режим увімкнено',FUSE_ARMED:'Fuse озброєно',ITEM_ENABLED:'Товар існує та увімкнений',AUTONOMOUS_ENABLED:'Автономну торгівлю дозволено',PLAN_CURRENT_BUY_RESELL:'TradingPlan актуальний · BUY_RESELL',RESELLER_READY:'Reseller готовий',PROXY_CONNECTED:'Проксі підключено',QUANTITY_ONE:'Кількість = 1',PURCHASE_CAP_VALID:'Обидва ліміти покупки дозволяють операцію'}
        for(const check of v.checks)root.append(node('p',`${check.ok?'✓':'✗'} ${labels[check.code]??check.code}`))
        root.append(node('p',v.ready?'Preflight: усі поточні перевірки пройдено.':'Live trade заблоковано: '+v.blockers.join(', ')))
        const p=v.preview
        if(p){
            root.append(node('p',`Бот: ${p.botName??p.botId??'—'} · запуск ${p.incarnationId??'—'} · Товар: ${p.itemName??p.itemId} · сервер / realm: ${p.serverId} / ${p.realm}`))
            root.append(node('p',`Проксі: ${p.proxy?`${p.proxy.label} (#${p.proxy.proxyId}) ${p.proxy.host}:${p.proxy.port} · ${p.proxy.reservationState} · SOCKS ${p.proxy.transportConnected?'підключено':'не підтверджено'}`:'не призначено'}`))
            root.append(node('p',`Кількість: ${p.targetQuantity}${p.quantityReduced?` (зменшено з ${p.planQuantity} у плані)`:''} · Макс. ціна купівлі: ${p.maxBuyPricePerItem} · Ціль продажу: ${p.targetSellPricePerItem} · Максимальне зобов’язання: ${p.maximumPurchaseCommitment} · Plan ID: ${p.planId}`))
        }
        const message=node('p'),arm=node('button','Озброїти / перезарядити fuse'),disable=node('button','Вимкнути validation і автономну торгівлю')
        arm.disabled=!v.policy.enabled||this.data.operationsPolicy?.autonomousTradingEnabled===true
        arm.onclick=async()=>{try{await this.command('core.liveValidation.arm',{expectedGeneration:v.fuse.generation});await this.refresh()}catch(e){message.textContent=e.message}}
        disable.onclick=async()=>{try{await this.command('core.liveValidation.disable',{expectedRevision:this.data.operationsPolicy.revision});await this.refresh()}catch(e){message.textContent=e.message}}
        root.append(node('p','Озброюйте лише при вимкненій автономній торгівлі. Перегляд не споживає fuse. Після озброєння ввімкнення автономної торгівлі дозволяє одну реальну спробу.'),arm,disable,message)
        if(v.execution){
            root.append(node('p',`Plan ${v.execution.planId} → Economic workload ${v.execution.workloadId} → бот ${v.execution.botId??'—'} → запуск ${v.execution.incarnationId??'—'} · ${v.execution.status}`))
            root.append(node('p',`Кількість у виконанні: ${v.execution.effectiveTerms.targetQuantity} · у плані: ${v.execution.liveValidation.planQuantity}`))
            const details=node('details'),summary=node('summary','Хронологія доказів');details.append(summary)
            for(const event of v.execution.timeline)details.append(node('p',`${date(event.at)} · ${event.code} · seq ${event.sequence??'—'} · ${JSON.stringify(event.data)}`))
            root.append(details)
        }
    }
    renderMarket(){
        this.renderLiveValidation()
        el('coreTradingExecutionStatus').textContent=`Автономна торгівля: ${this.data.trading?.executionEnabled?'Увімкнено':'Вимкнено'} · ${this.data.trading?.mode??'SHADOW'} · ${this.data.trading?.executionBlocker??''}`
        const itemNames=new Map((this.data.actualState?.items??[]).map(i=>[i.itemId,i.name]))
        const executionStates={PENDING:'очікує',ADMITTED:'допущено',RUNNING:'виконується',DRAINING:'завершує операцію',COMPLETED:'завершено',FAILED:'помилка',CANCELLED:'скасовано',BLOCKED:'заблоковано',UNCERTAIN:'невизначено'}
        this.table('coreTradingRows',['Товар · сервер / realm','Рішення','Макс. купівля','Ціль продажу','Прибуток / шт.','Маржа','Кількість','Впевненість %','Дані ринку','Діє до','Причини','Виконання','Бот','Economic workload','Причина блокування'],(this.data.trading?.plans??[]).map(p=>[
            `${itemNames.get(p.itemId)??p.itemId} · ${p.serverId??'—'} / ${p.realm??'—'}`,
            p.decision==='BUY_RESELL'&&p.expiresAt>Date.now()?'КУПУВАТИ':'УТРИМАТИСЯ',p.maxBuyPricePerItem,p.targetSellPricePerItem,
            p.expectedProfitPerItem,p.expectedMargin==null?'—':`${(100*p.expectedMargin).toFixed(1)}%`,p.targetQuantity,p.confidence,
            date(p.sourceTimestamp),date(p.expiresAt),p.reasons.join(', '),executionStates[p.execution?.status]??'—',p.execution?.botId,p.execution?.workloadId,p.execution?.reason
        ]))

        const market=this.data.market ?? {items:[],status:'unavailable',revision:0},analysis=this.data.analysis ?? {analysts:[],activeSessions:[],priorities:[]}
        const format=n=>n==null?'—':typeof n==='number'?Number(n.toFixed(2)).toLocaleString():n
        const key=m=>`${m.serverId}:${m.realm}:${m.itemId}`
        el('coreMarketStatus').textContent=`${market.status} · revision ${market.revision} · Видима сторінка auction, без оцінки попиту чи продажів.`
        this.table('coreMarketRows',['Товар · сервер / realm','Вік, с','Confidence %','Лоти','Supply','Наш supply','High outliers','Median','Retail','Bulk','Volatility','Стан'],market.items.map(m=>[
            `${m.name} · ${m.serverId} / ${m.realm}`,m.dataAgeMs==null?'—':Math.round(m.dataAgeMs/1000),format(m.confidence),m.independentLotCount,m.independentSupply,m.ownSupply,m.excludedHighOutlierCount,
            format(m.medianPricePerItem),format(m.retail?.medianPricePerItem),format(m.bulk?.medianPricePerItem),format(m.volatility),m.freshness]))
        const selected=el('coreMarketItem').value
        el('coreMarketItem').replaceChildren(...market.items.map(m=>new Option(`${m.name} · ${m.serverId} / ${m.realm}`,key(m))))
        if(market.items.some(m=>key(m)===selected)) el('coreMarketItem').value=selected
        this.renderMarketDetails()
        if(this.marketRevision!==market.revision || el('coreMarketItem').value!==selected){this.marketRevision=market.revision;if(el('coreMarketDiagnostics').open) void this.loadMarketLots()}
        this.table('coreAnalysts',['Бот','Ринок','Стан','Товар','Спостереження','Next refresh','Початок'],analysis.analysts.map(b=>{
            const session=analysis.activeSessions.find(s=>s.botId===b.botId)
            return [b.botId,`${b.serverId} / ${b.realm}`,b.manualHold?'Ручне керування':b.state,session?.itemId ?? '—',session?`${session.completedObservations} / ${session.requestedObservations}`:'—',date(session?.nextRefreshAt),date(session?.startedAt)]
        }))
        this.table('coreAnalysisPriorities',['Товар','Ринок','Priority','Доступний','Причини'],analysis.priorities.map(p=>[p.name,`${p.serverId} / ${p.realm}`,format(p.priority),p.eligible?'Так':p.reserved?'В аналізі':'Пауза',p.reasons.map(r=>`${r.code} +${format(r.data?.contribution)}`).join(' · ')]))
    }
    selectedMarket(){const [serverId,realm,itemId]=el('coreMarketItem').value.split(':').map(Number);return this.data.market?.items.find(m=>m.itemId===itemId && m.serverId===serverId && m.realm===realm)}
    renderMarketDetails(){
        const m=this.selectedMarket()
        if(!m){el('coreMarketDetails').replaceChildren(node('p','Ринкових спостережень ще немає.','muted'));return}
        const rows=[['Останнє спостереження',date(m.lastObservedAt)],['Спостережень (до 60 за 24 год)',m.observationCount],['Незалежні лоти',m.independentLotCount],['Наші лоти',m.ownLotCount],['Виключені high outliers',m.excludedHighOutlierCount],['Invalid',m.invalidLotCount],['Продавці',m.sellerCount],['Min',m.minPricePerItem],...['p10','p25','p50','p75','p90'].map(k=>[k,m[k]])]
        for(const segment of ['retail','medium','bulk']) rows.push([`${segment} · лоти / supply / median`,m[segment]?`${m[segment].lotCount} / ${m[segment].supply} / ${m[segment].medianPricePerItem ?? '—'}`:'—'])
        rows.push(['Potential wholesale',m.potentialWholesaleOpportunities?.map(o=>`${o.seller}: ${o.amount} × ${o.pricePerItem}; potential spread ${o.potentialSpread ?? '—'}`).join(' · ') || '—'])
        this.table('coreMarketDetails',['Показник','Значення'],rows)
    }
    async loadMarketLots(){
        const m=this.selectedMarket(),version=(this.lotVersion ?? 0)+1;this.lotVersion=version
        if(!m){el('coreMarketLots').replaceChildren();return}
        try{
            const response=await this.api.request('query','core.market.details',{itemId:m.itemId,serverId:m.serverId,realm:m.realm,limit:45})
            if(version!==this.lotVersion) return
            if(!response.ok) throw new Error(response.error.message)
            this.table('coreMarketLots',['Час','Seller','Amount','Total','Price/item','Класифікація','Причина'],response.data.lots.map(l=>[date(l.observedAt),l.seller,l.amount,l.totalPrice,l.pricePerItem,l.classification,l.exclusionReason ?? l.parseReason]))
        }catch(error){this.message(error.message,true)}
    }
    fields(id,descriptors,values,prefix){
        const expanded=Object.fromEntries([...el(id).querySelectorAll('details')].map(details=>[details.dataset.group,details.open]))
        el(id).replaceChildren(...Object.entries(descriptors).map(([key,field])=>{
            const label=node("label",field.label)
            const metadata=(id==='corePolicyFields'?this.data.policyMetadata?.core:this.data.policyMetadata?.overrides)?.[key]
            label.title=[field.description,metadataHelp(metadata)].filter(Boolean).join(' ')
            label.dataset.support=metadata?.status??'UNSUPPORTED'
            if(id==='corePolicyFields')label.dataset.market=metadata?.domain==='market'?'true':metadata?.domain??'workload'
            const input=node("input");input.id=prefix+key;input.name=key
            input.type=field.type === "boolean" ? "checkbox" : "number"
            if(field.type === "boolean") input.checked=values[key] === true
            else{
                input.value=values[key] ?? "";input.min=field.min;input.max=field.max
                input.step=field.type === "integer" ? "1" : "any";input.required=!field.nullable
                if(field.nullable) input.placeholder="Без override"
            }
            input.disabled=metadata?.editable!==true
            label.append(input);return label
        }))
        if(id==='corePolicyFields'){
            const legacy=[...el(id).children].filter(n=>['LEGACY','UNSUPPORTED'].includes(n.dataset.support))
            if(legacy.length&&this.data?.operationsPolicy){const details=node('details'),fields=node('div','','core-fields');details.style.gridColumn='1 / -1';details.dataset.group='legacy';fields.append(node('p','Ці поля збережено для сумісності зі старими конфігураціями. Після налаштування Operations Policy цілі ролей та головний перемикач задаються у розділі «Операційне керування».','muted'),...legacy);details.append(node('summary','Сумісність старої політики'),fields);el(id).append(details)}
            const runtime=[...el(id).children].filter(n=>n.dataset.market==='runtime')
            if(runtime.length){
                const details=node('details'),fields=node('div','','core-fields')
                details.style.gridColumn='1 / -1'
                details.dataset.group='runtime';details.open=expanded.runtime ?? false
                fields.append(...runtime);details.append(node('summary','Виконання ботів · Anti-AFK та готовність'),fields);el(id).append(details)
            }
            const advanced=[...el(id).children].filter(n=>n.dataset.market==='true')
            if(advanced.length){
                const details=node('details'),fields=node('div','','core-fields')
                details.style.gridColumn='1 / -1';details.dataset.group='market';details.open=expanded.market ?? false
                fields.append(...advanced);details.append(node('summary','Market / Analyst · параметри'),fields);el(id).append(details)
            }
            for(const [domain,title] of [['controller','Налаштування поточного циклу ядра'],['workload','Обмеження товарів і навантаження']]){
                const inputs=[...el(id).children].filter(n=>n.dataset.market===domain)
                if(inputs.length){const details=node('details'),fields=node('div','','core-fields');details.style.gridColumn='1 / -1';details.dataset.group=domain;details.open=expanded[domain]??false;fields.append(...inputs);details.append(node('summary',title),fields);el(id).append(details)}
            }
        }
    }
    readFields(descriptors,prefix){
        return Object.fromEntries(Object.entries(descriptors).map(([key,field])=>{
            const input=el(prefix+key)
            return [key,field.type === "boolean" ? input.checked : input.value === "" && field.nullable ? null : Number(input.value)]
        }))
    }
    renderOperationsSummary(){
        const ops=this.data.effectiveOperationsPolicy,next=ops?.nextTransition,reserve=this.data.accountReserve
        const states={stable:'Стабільно',reconciling:'Синхронізація',degraded:'Обмежений стан',disabled:'Спостереження',observing:'Спостереження',maintenance:'Обслуговування'}
        const profile=(ops?.currentScheduleProfile ?? []).join(', ')||'базовий'
        el('coreOperationsSummary').textContent=`${ops?.maintenanceMode?'Обслуговування':ops?.automationActive?'Автоматизацію ввімкнено':'Спостереження'} · стан: ${states[this.data.status.status]??this.data.status.status} · ${ops?.timezone??'—'} · профіль: ${profile} · резерв: ${reserve?.ready??0}/${reserve?.target??0} · наступна зміна: ${next?new Date(next.at).toLocaleString('uk-UA'):'—'}`
    }
    operationMetadata(path){return this.data.policyMetadata?.operations?.[path]??this.data.policyMetadata?.operations?.[path.replace(/^schedules\.\d+\./,'schedules.*.')]}
    renderCapabilities(){
        let root=el('coreCapabilities')
        if(!root){root=node('div');root.id='coreCapabilities';el('coreOperationsSummary').after(root)}
        const expanded=root.querySelector('details')?.open??false
        root.replaceChildren(node('h4','Можливості виконання'))
        for(const [role,r] of Object.entries(this.data.effectiveOperationsPolicy?.roles??{})){
            const capability=role==='reseller'?this.data.capabilities?.resellerTrading:role==='analyst'?this.data.capabilities?.analystExecution:null
            const explanation=r.blocker?`${capability?.description??'Виконавець цієї ролі не підтримується.'} [${r.blocker}]`:''
            root.append(node('p',`${roleLabels[role]??role}: налаштована ціль ${r.configuredTarget}; ціль за розкладом ${r.scheduledTarget}; ефективна ціль ${r.target}. Можливість виконання: ${r.executable?'доступна':'недоступна'}. ${explanation} ${(r.reasons??[]).map(reason=>reason.message).join(' ')}`))
        }
        const details=node('details');details.open=expanded;details.append(node('summary','Підтримка функцій та обмеження'))
        for(const capability of Object.values(this.data.capabilities??{}))if(capability&&typeof capability==='object')details.append(node('p',`${capability.label}: ${supportLabels[capability.status]??capability.status}. ${capability.description}`))
        root.append(details)
    }
    renderAutomationDiagnostic(){
        const d=this.data.reconciliation,root=el('coreAutomationDiagnostic');root.replaceChildren(node('h4','Стан автоматизації'))
        if(!d){root.append(node('p','Очікується перша синхронізація.','muted'));return}
        const triggerLabels={OPERATIONS_POLICY_UPDATED:'Змінено налаштування',SCHEDULE_TRANSITION:'Зміна розкладу',CORE_STARTED:'Запуск Core',SAFETY_RECONCILIATION:'Контрольна перевірка'}
        const states={stable:'Стабільно',reconciling:'Синхронізація',degraded:'Обмежений стан'},meta=node('div','','diagnostic-meta');meta.append(node('span',`Стан: ${states[d.status]??d.status}`),node('span',`Версія політики: ${d.policyRevision}`),node('span',`Останній перерахунок: ${new Date(d.evaluatedAt).toLocaleTimeString('uk-UA')}`),node('span',`Причина: ${triggerLabels[d.trigger?.type]??d.trigger?.type??'—'}`));root.append(meta)
        const blockerLabels={NO_ELIGIBLE_BOT:'Немає доступного бота або акаунта',NO_ELIGIBLE_ANALYST:'Немає доступного бота для аналітика',ACCOUNT_UNAVAILABLE:'Немає доступного акаунта',AUTOMATIC_ACCOUNT_GENERATION_DISABLED:'Автоматичне створення акаунтів вимкнено',ACCOUNT_TOTAL_LIMIT_REACHED:'Досягнуто максимальну кількість акаунтів',ACCOUNT_PENDING_LIMIT_REACHED:'Досягнуто ліміт одночасного створення',ACCOUNT_GENERATOR_UNAVAILABLE:'Генератор акаунтів недоступний',ACCOUNT_GENERATION_FAILED:'Створення акаунта завершилося помилкою',ACCOUNT_GENERATION_BACKOFF:'Пауза після невдалої генерації',USER_BOT_HOLD:'Ручне керування має пріоритет',ACTION_IN_PROGRESS:'Попередня дія ще виконується',CORE_DISABLED:'Автоматизацію вимкнено',SAFE_TRANSITION_UNAVAILABLE:'Очікується безпечний момент переходу',FAILURE_BACKOFF:'Пауза після невдалої дії',BOT_TARGET_MISSING:'Не налаштовано сервер або анархію',PRICES_UNAVAILABLE:'Немає придатних налаштованих цін',TRADING_EXECUTION_DISABLED:'Автоматичне виконання торгівлі недоступне'}
        const grid=node('div','','diagnostic-roles');for(const [id,r] of Object.entries(d.roles)){const card=node('article','','diagnostic-role'),title=node('h5',(roleLabels[id]??id).toUpperCase()),values=node('dl');for(const [label,value] of [['Налаштована ціль',r.configured.target],['Ефективна ціль',r.effective.target],['Потрібно зараз',r.desired],['Працює зараз',r.actual],['Запускається',r.starting],['Зупиняється',r.stopping],['Залишилося запустити',r.remainingStartDeficit],['Залишилося зупинити',r.remainingStopExcess]]){values.append(node('dt',label),node('dd',String(value)))}card.append(title,values);if(r.effective.scheduleId)card.append(node('p',`Причина ефективної політики: активний інтервал «${r.effective.scheduleId}».`,'muted'));if(r.effective.reason==='MAINTENANCE_MODE')card.append(node('p','Причина: режим обслуговування.','muted'));if(r.blockers.length){const list=node('ul');for(const b of r.blockers)list.append(node('li',blockerLabels[b.code]??b.message));card.append(node('strong','Обмеження:'),list)}grid.append(card)}root.append(grid)
        const generation=d.accountGeneration;if(generation){const card=node('article','','diagnostic-role'),values=node('dl');card.append(node('h5','АКАУНТИ'));for(const [label,value] of [['Усього',generation.totalAccounts],['Готово в резерві',generation.eligibleReadyAccounts],['Створюється',generation.pendingAccountCreations],['Дефіцит для роботи',generation.workCapacityDeficit],['Дефіцит резерву',generation.reserveDeficit],['Залишковий дефіцит',generation.uncoveredAccountDeficit],['Ліміт акаунтів',generation.maximumTotalAccounts],['Ліміт одночасного створення',generation.maximumPendingAccountGeneration]])values.append(node('dt',label),node('dd',String(value??0)));card.append(values,node('p',generation.status==='planned'?`Створення активне: запитано ${generation.requested}.`:generation.blocker?`Створення заблоковано: ${blockerLabels[generation.blocker]??generation.blocker}.`:'Нові акаунти зараз не потрібні.','muted'));root.append(card)}
        const next=d.nextAction;root.append(node('p',next?`Наступна дія: ${next.action}${next.target?.botId?` · бот #${next.target.botId}`:''}.`:'Наступна дія: немає — система стабільна.','diagnostic-next'))
        const transition=this.data.effectiveOperationsPolicy?.nextTransition;if(transition){const effects=transition.changes.map(c=>`${roleLabels[c.role]??c.role}: ціль ${c.before.target} → ${c.after.target}`).join('; ');root.append(node('p',`Наступна зміна розкладу: ${new Date(transition.at).toLocaleString('uk-UA')} · ${effects}`,'muted'))}
    }
    loadOperations(value){
        const {revision,updatedAt,...policy}=value;this.operationsRevision=revision;this.operationsActive=deepClone(policy);this.operationsDraft=deepClone(policy)
        el('coreOperationsRevision').textContent=`Версія політики: ${revision}`;this.renderOperationsForm();this.setOperationsDirty(false)
    }
    setOperationsDirty(dirty){this.operationsDirty=dirty;el('coreOperationsDirty').textContent=dirty?'Є незбережені зміни':'';el('coreOperationsCancel').disabled=!dirty;el('coreOperationsSave').disabled=!dirty;this.renderOperationsImpact()}
    fieldLabel(text,path,helpText=null){
        const label=node('label');const title=node('span','','operations-label');title.append(node('span',text))
        if(helpText){const wrap=node('span','','help-control'),button=node('button','ⓘ','help-button'),tip=node('span',helpText,'help-popover');button.type='button';button.dataset.help='';button.setAttribute('aria-label',`Довідка: ${text}`);button.setAttribute('aria-expanded','false');tip.id=`help-${path.replaceAll('.','-')}`;tip.setAttribute('role','tooltip');button.setAttribute('aria-describedby',tip.id);wrap.append(button,tip);title.append(wrap)}
        label.append(title);return label
    }
    policyInput(path,value,type='number',options=null,helpText=null,labelText=''){
        const meta=this.operationMetadata(path);const label=this.fieldLabel(labelText,path,metadataHelp(meta)),input=type==='select'?node('select'):node('input');input.dataset.path=path;input.id='operations_'+path.replaceAll('.','_')
        if(type==='boolean'){input.type='checkbox';input.checked=Boolean(value)}
        else if(type==='select'){for(const [key,text] of Object.entries(options))input.append(new Option(text,key));if(!Object.hasOwn(options,value))input.append(new Option(String(value),String(value)));input.value=value}
        else{input.type=type;input.value=value;input.min='0';if(type==='number')input.step='1'}
        input.disabled=meta?.editable!==true;label.dataset.support=meta?.status??'UNSUPPORTED'
        if(meta?.status==='PARTIALLY_SUPPORTED')label.append(node('small',supportLabels[meta.status],'muted'))
        label.append(input);return label
    }
    durationInput(path,value,labelText){
        const label=this.fieldLabel(labelText,path,metadataHelp(this.operationMetadata(path))),row=node('span','','duration-control'),shown=durationPresentation(value),input=node('input'),select=node('select')
        input.type='number';input.min='0';input.step='any';input.value=shown.value;input.dataset.durationPath=path
        for(const [unit,multiplier] of [['секунд',1000],['хвилин',60000],['годин',3600000]])select.append(new Option(unit,String(multiplier)))
        select.value=String(shown.unit);select.dataset.durationUnit=path;input.disabled=select.disabled=this.operationMetadata(path)?.editable!==true;label.dataset.support=this.operationMetadata(path)?.status??'UNSUPPORTED';row.append(input,select);label.append(row);return label
    }
    group(title,open=true){const details=node('details','','operations-group');details.open=open;details.append(node('summary',title));const body=node('div','','operations-grid');details.append(body);return {details,body}}
    renderOperationsForm(){
        const p=this.operationsDraft,root=el('coreOperationsFields');root.replaceChildren()
        const general=this.group('Загальні')
        const live=p.liveValidation??{enabled:false,itemId:null,maxPurchaseCommitment:null}
        general.body.append(this.policyInput('liveValidation.enabled',live.enabled,'boolean',null,null,'Live validation — обмежити один реальний тест'))
        general.body.append(this.policyInput('liveValidation.itemId',live.itemId??'','number',null,null,'ID єдиного тестового товару'))
        general.body.append(this.policyInput('liveValidation.maxPurchaseCommitment',live.maxPurchaseCommitment??'','number',null,null,'Явний малий ліміт тестової покупки'))
        general.body.append(this.policyInput('autonomousTradingEnabled',p.autonomousTradingEnabled,'boolean',null,null,'Автономна торгівля — дозволити реальні купівлі та виставлення'))
        general.body.append(this.policyInput('autonomousTradingMaxPurchaseValue',p.autonomousTradingMaxPurchaseValue,'number',null,null,'Максимальна сума купівлі на автономне завдання'))
        general.body.append(this.policyInput('autonomousTradingMaxConcurrentWorkloads',p.autonomousTradingMaxConcurrentWorkloads,'number',null,null,'Максимум одночасних автономних завдань'))
        general.body.append(this.policyInput('allocationEnabled',p.allocationEnabled,'boolean',null,null,'Автоматичне призначення ботів'))
        general.body.append(this.policyInput('automationEnabled',p.automationEnabled,'boolean',null,help.automationEnabled,'Автоматизація'),this.policyInput('maintenanceMode',p.maintenanceMode,'boolean',null,help.maintenanceMode,'Режим обслуговування'),this.policyInput('timezone',p.timezone,'select',{'Europe/Oslo':'Europe/Oslo','Europe/Kyiv':'Europe/Kyiv','UTC':'UTC'},help.timezone,'Часовий пояс'),this.policyInput('startupPolicy',p.startupPolicy,'select',startupLabels,null,'Поведінка після запуску системи'));root.append(general.details)
        const capacity=this.group('Кількість ботів');const derived=this.data.effectiveOperationsPolicy?.capacity.target??0,derivedField=this.fieldLabel('Загальна бажана кількість', 'capacity.derived',help.target);derivedField.append(node('output',String(derived),'derived-capacity'));capacity.body.append(this.policyInput('capacity.minimum',p.capacity.minimum,'number',null,help.minimum,'Мінімум активних ботів'),derivedField,this.policyInput('capacity.maximum',p.capacity.maximum,'number',null,help.maximum,'Максимум активних ботів'));root.append(capacity.details)
        const roles=this.group('Ролі');roles.body.classList.add('operations-role-list');for(const [id,r] of Object.entries(p.roles)){const card=node('fieldset','','role-card');card.dataset.role=id;card.append(node('legend',roleLabels[id]??id));const grid=node('div','','operations-grid');grid.append(this.policyInput(`roles.${id}.enabled`,r.enabled,'boolean',null,null,'Увімкнено'),this.policyInput(`roles.${id}.minimum`,r.minimum,'number',null,help.minimum,'Мінімум'),this.policyInput(`roles.${id}.target`,r.target,'number',null,help.target,'Ціль'),this.policyInput(`roles.${id}.maximum`,r.maximum,'number',null,help.maximum,'Максимум'),this.policyInput(`roles.${id}.priority`,r.priority,'number',null,help.priority,'Пріоритет'),this.policyInput(`roles.${id}.autoStart`,r.autoStart,'boolean',null,null,'Автозапуск'),this.policyInput(`roles.${id}.autoReplace`,r.autoReplace,'boolean',null,null,'Автозаміна'),this.policyInput(`roles.${id}.stopMode`,r.stopMode,'select',stopModeLabels,help.stopMode,'Режим автоматичної зупинки'));card.append(grid);roles.body.append(card)}root.append(roles.details)
        root.append(this.renderSchedules())
        for(const key of ['controller','transitions','stability','recovery','health','reserve']){const group=this.group(sectionLabels[key],false);for(const [field,label,type] of sectionFields[key])group.body.append(type==='duration'?this.durationInput(`${key}.${field}`,p[key][field],label):this.policyInput(`${key}.${field}`,p[key][field],type,null,key==='reserve'?(help[field]??help.reserve):null,label));root.append(group.details)}
        const compatibility=this.group('Збережені непідтримувані параметри · лише читання',false)
        compatibility.details.dataset.compatibility='true'
        compatibility.body.append(node('p','Ці значення збережено для сумісності. Вони не мають поточного виконавця.','muted'))
        for(const label of [...root.querySelectorAll('label[data-support="UNSUPPORTED"], label[data-support="LEGACY"]')]){
            const context=label.closest('fieldset')?.querySelector('legend')?.textContent??label.closest('details')?.querySelector('summary')?.textContent
            if(context)label.prepend(node('small',context))
            compatibility.body.append(label)
        }
        for(const group of [...root.children])if(!group.querySelector('input,select,button,output'))group.remove()
        root.append(compatibility.details)
    }
    renderSchedules(){
        const group=this.group('Розклад',false);group.details.classList.add('schedule-group');const intro=node('p','Розклад змінює ефективну політику ролі; часовий пояс указано в загальних налаштуваннях.','muted');group.body.append(intro)
        for(const [index,w] of this.operationsDraft.schedules.entries()){const card=node('fieldset','','schedule-card');card.dataset.schedule=String(index);card.append(node('legend',`${roleLabels[w.role]??w.role} · ${w.id}`));const days=node('div','','weekday-picker');days.title=metadataHelp(this.operationMetadata(`schedules.${index}.weekdays`));weekdays.forEach((text,i)=>{const button=node('button',text,w.weekdays.includes(i+1)?'selected':'');button.type='button';button.dataset.weekday=String(i+1);button.dataset.scheduleIndex=String(index);button.setAttribute('aria-pressed',String(w.weekdays.includes(i+1)));days.append(button)});card.append(days)
            const grid=node('div','','operations-grid');grid.append(this.policyInput(`schedules.${index}.role`,w.role,'select',Object.fromEntries(Object.keys(this.operationsDraft.roles).map(id=>[id,roleLabels[id]??id])),null,'Роль'),this.policyInput(`schedules.${index}.start`,w.start,'time',null,help.schedule,'Початок'),this.policyInput(`schedules.${index}.end`,w.end,'time',null,help.schedule,'Кінець'),this.policyInput(`schedules.${index}.enabled`,w.enabled,'boolean',null,null,'Інтервал увімкнено'),this.policyInput(`schedules.${index}.roleEnabled`,w.roleEnabled==null?'inherit':String(w.roleEnabled),'select',{inherit:'Використовувати базове значення',true:'Роль увімкнена',false:'Роль вимкнена'},null,'Стан ролі'))
            const override=this.fieldLabel('Перевизначити кількість ботів',`schedules.${index}.capacity`,metadataHelp(this.operationMetadata(`schedules.${index}.capacity`))),toggle=node('input');toggle.type='checkbox';toggle.dataset.scheduleCapacity=String(index);toggle.checked=w.capacity!=null;override.append(toggle);grid.append(override)
            if(w.capacity)for(const key of ['minimum','target','maximum'])grid.append(this.policyInput(`schedules.${index}.capacity.${key}`,w.capacity[key],'number',null,help[key],{minimum:'Мінімум',target:'Ціль',maximum:'Максимум'}[key]))
            card.append(grid);const remove=node('button','Видалити інтервал');remove.type='button';remove.className='danger-button';remove.dataset.removeSchedule=String(index);card.append(remove);group.body.append(card)}
        const add=node('button','+ Додати інтервал');add.type='button';add.dataset.addSchedule='';group.body.append(add);return group.details
    }
    operationsInput(event){
        if(!this.operationsDraft)return;const target=event.target,path=target.dataset.path
        if(path){let value=target.type==='checkbox'?target.checked:target.type==='number'?Number(target.value):target.value;if(path.endsWith('.roleEnabled'))value=value==='inherit'?null:value==='true';this.setPath(this.operationsDraft,path,value)}
        if(target.dataset.durationPath){const unit=el('coreOperationsForm').querySelector(`[data-duration-unit="${target.dataset.durationPath}"]`);this.setPath(this.operationsDraft,target.dataset.durationPath,durationMilliseconds(target.value,unit.value))}
        if(target.dataset.durationUnit){const input=el('coreOperationsForm').querySelector(`[data-duration-path="${target.dataset.durationUnit}"]`);this.setPath(this.operationsDraft,target.dataset.durationUnit,durationMilliseconds(input.value,target.value))}
        if(path||target.dataset.durationPath||target.dataset.durationUnit){this.setOperationsDirty(true);this.validateOperations()}
    }
    operationsClick(event){
        const target=event.target
        if(target.dataset.help!==undefined){const open=target.getAttribute('aria-expanded')!=='true';this.closeOperationsHelp();target.setAttribute('aria-expanded',String(open));target.parentElement.classList.toggle('open',open);return}
        if(target.dataset.weekday){const w=this.operationsDraft.schedules[Number(target.dataset.scheduleIndex)],day=Number(target.dataset.weekday);w.weekdays=w.weekdays.includes(day)?w.weekdays.filter(v=>v!==day):[...w.weekdays,day].sort();this.setOperationsDirty(true);this.renderOperationsForm();return}
        if(target.dataset.scheduleCapacity!==undefined){const w=this.operationsDraft.schedules[Number(target.dataset.scheduleCapacity)];w.capacity=target.checked?{minimum:0,target:0,maximum:0}:null;this.setOperationsDirty(true);this.renderOperationsForm();return}
        if(target.dataset.removeSchedule!==undefined){this.operationsDraft.schedules.splice(Number(target.dataset.removeSchedule),1);this.setOperationsDirty(true);this.renderOperationsForm();return}
        if(target.dataset.addSchedule!==undefined){const role=Object.keys(this.operationsDraft.roles)[0];if(!role)return;this.operationsDraft.schedules.push({id:`interval-${Date.now()}`,role,weekdays:[1,2,3,4,5],start:'07:00',end:'23:00',enabled:true,roleEnabled:null,capacity:null});this.setOperationsDirty(true);this.renderOperationsForm()}
    }
    setPath(object,path,value){const keys=path.split('.');let cursor=object;for(const key of keys.slice(0,-1))cursor=cursor[key];cursor[keys.at(-1)]=value}
    closeOperationsHelp(){for(const item of el('coreOperationsForm').querySelectorAll('.help-control.open'))item.classList.remove('open');for(const button of el('coreOperationsForm').querySelectorAll('.help-button'))button.setAttribute('aria-expanded','false')}
    validateOperations(){
        const p=this.operationsDraft,errors=[];const triple=(v,label)=>{if([v.minimum,v.target,v.maximum].some(n=>!Number.isFinite(n)||n<0))errors.push(`${label}: значення не може бути від’ємним.`);if(v.target>v.maximum)errors.push(`${label}: ціль не може перевищувати максимум.`)};/* Global target is a derived alias. */triple({...p.capacity,minimum:0,target:0},'Кількість ботів');for(const [id,r] of Object.entries(p.roles))triple(r,roleLabels[id]??id);for(const w of p.schedules)if(w.capacity)triple(w.capacity,`Інтервал ${w.id}`);if(!p.schedules.every(w=>w.weekdays.length))errors.push('Для кожного інтервалу виберіть хоча б один день.');if(p.recovery.restartDelayMinMs>p.recovery.restartDelayMaxMs)errors.push('Мінімальна затримка перезапуску не може перевищувати максимальну.');el('coreOperationsValidation').textContent=errors.join(' ');el('coreOperationsSave').disabled=!this.operationsDirty||Boolean(errors.length);return !errors.length
    }
    renderOperationsImpact(){if(!this.operationsDirty||!this.operationsDraft)return el('coreOperationsImpact').classList.add('hidden');const messages=[];if(this.operationsDraft.maintenanceMode&&!this.operationsActive.maintenanceMode)messages.push(this.data.capabilities?.maintenance?.description);if(this.operationsDraft.capacity.maximum!==this.operationsActive.capacity.maximum)messages.push(this.data.capabilities?.gracefulManagedStop?.description);el('coreOperationsImpact').textContent=messages.filter(Boolean).join(' ');el('coreOperationsImpact').classList.toggle('hidden',!messages.filter(Boolean).length)}
    cancelOperations(){this.operationsDraft=deepClone(this.operationsActive);this.renderOperationsForm();this.setOperationsDirty(false);el('coreOperationsValidation').textContent=''}
    localizeOperationsError(message){if(message.includes('CONFLICT'))return 'Політику вже змінено. Оновіть сторінку та повторіть редагування.';if(message.includes('minimum'))return 'Мінімум не може перевищувати ціль.';if(message.includes('target'))return 'Ціль не може перевищувати максимум.';if(message.includes('timezone'))return 'Виберіть коректний часовий пояс.';return `Core відхилив налаштування: ${message}`}
    fillOverride(){
        const itemId=Number(el("coreOverrideItem").value)
        const override=this.data.overrides.find(o=>o.itemId===itemId) ?? {disabled:false}
        this.fields("coreOverrideFields",this.data.fields.override,override,"coreOverride_")
        this.overrideRevision=this.data.inputRevision
        el("coreOverrideSave").disabled=!itemId
        el("coreOverrideDelete").disabled=!override.itemId
    }
    async command(name,payload){
        const response=await this.api.request("command",name,payload)
        if(!response.ok) throw new Error(response.error.message)
        return response.data
    }
    async savePolicy(){
        if(this.savingPolicy) return
        this.savingPolicy=true;el("corePolicySave").disabled=true
        try{
            await this.command("core.policy.update",{values:explicitPolicyChanges(this.readFields(this.data.fields.policy,"corePolicy_"),this.data.policy,this.data.policyMetadata.core),expectedRevision:this.policyRevision})
            this.policyDirty=false;await this.refresh();this.message("Політику збережено. Core переглядає desired state.")
        }catch(error){this.message(error.message,true)}finally{this.savingPolicy=false;el("corePolicySave").disabled=false}
    }
    async saveOperations(){
        if(!this.validateOperations())return
        try{el('coreOperationsSave').disabled=true;await this.command('core.operations.update',{values:this.operationsDraft,expectedRevision:this.operationsRevision});this.operationsDirty=false;await this.refresh();this.message('Налаштування автоматизації збережено.')}
        catch(error){el('coreOperationsValidation').textContent=this.localizeOperationsError(error.message);this.message('Не вдалося зберегти налаштування.',true)}finally{el('coreOperationsSave').disabled=!this.operationsDirty}
    }
    async saveOverride(){
        const itemId=Number(el("coreOverrideItem").value)
        const values=this.readFields(this.data.fields.override,"coreOverride_")
        if(values.minBots!=null && values.maxBots!=null && values.minBots>values.maxBots){this.message("Мінімум ботів не може перевищувати максимум.",true);return}
        try{await this.command("core.override.set",{itemId,values,expectedRevision:this.overrideRevision});this.overrideDirty=false;await this.refresh();this.message("Override збережено.")}
        catch(error){this.message(error.message,true)}
    }
    async deleteOverride(){
        try{await this.command("core.override.delete",{itemId:Number(el("coreOverrideItem").value),expectedRevision:this.overrideRevision});this.overrideDirty=false;await this.refresh();this.message("Override видалено.")}
        catch(error){this.message(error.message,true)}
    }
    renderDecisions(){
        const expanded=new Set([...el("coreDecisions").querySelectorAll("details[open]")].map(n=>n.dataset.decisionId))
        el("coreDecisions").replaceChildren(...this.data.recentDecisions.map(record=>{
            const details=node("details","","core-decision")
            details.dataset.decisionId=record.decisionId;details.open=expanded.has(record.decisionId)
            const summary=node("summary",`${date(record.timestamp)} · ${record.action} · ${record.result}`)
            const target=node("p",`Бот: ${record.target?.botId ?? "—"} · товар: ${record.target?.itemId ?? "—"} · trigger: ${record.trigger?.type ?? "—"}`,"muted")
            const reasons=node("ul")
            for(const r of record.reasons ?? []) reasons.append(node("li",`${r.code}: ${r.message}`))
            details.append(summary,target,reasons,node("pre",JSON.stringify({decisionId:record.decisionId,actionId:record.actionId,desiredRevision:record.desiredRevision,before:record.before,after:record.after,constraintsApplied:record.constraintsApplied,alternatives:record.alternatives},null,2)))
            return details
        }))
        if(!this.data.recentDecisions.length) el("coreDecisions").append(node("p","Значущих рішень ще немає.","muted"))
    }
    table(id,headers,rows){
        const table=node("table","","database-table"),head=node("thead"),tr=node("tr"),body=node("tbody")
        headers.forEach(h=>tr.append(node("th",h)));head.append(tr)
        for(const values of rows){const row=node("tr");values.forEach(v=>row.append(node("td",v==null ? "—" : String(v))));body.append(row)}
        table.append(head,body);el(id).replaceChildren(table)
    }
    message(text,error=false){el("coreMessage").textContent=text;el("coreMessage").classList.toggle("error",error)}
}
