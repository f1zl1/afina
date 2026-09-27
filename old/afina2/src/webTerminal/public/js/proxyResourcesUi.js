const node=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e}
export function renderProxyResources(controller){
 let root=document.getElementById('coreProxies')
 if(!root){
  root=node('section');root.id='coreProxies';root.className='core-panel';document.getElementById('coreWorkloads').after(root)
  root.append(node('h3','Проксі та місткість підключень'),node('p','SOCKS5 обов’язковий для всіх ботів. Вимкнення забороняє нові призначення та не зупиняє поточні процеси. Пароль після збереження не показується.'))
  const capacity=node('form');capacity.id='proxyCapacityForm';const label=node('label','Максимум ботів на один проксі'),limit=node('input');limit.type='number';limit.min='1';limit.max='1000';limit.id='proxyCapacity';label.append(limit);capacity.append(label,node('button','Зберегти місткість'));root.append(capacity,node('p','Зниження ліміту не зупиняє ботів; нові призначення чекають вільного місця.'))
  const form=node('form');form.id='proxyForm'
  for(const [key,title,type] of [['name','Назва','text'],['host','Host','text'],['port','Port','number'],['username','Користувач (залиште порожнім без змін)','text'],['password','Пароль (залиште порожнім без змін)','password']]){const label=node('label',title),input=node('input');input.name=key;input.type=type;input.autocomplete='off';input.required=['name','host','port'].includes(key);if(key==='port'){input.min='1';input.max='65535'}label.append(input);form.append(label)}
  form.append(node('button','Додати / зберегти проксі'));const reset=node('button','Скасувати редагування');reset.type='button';reset.onclick=()=>{form.reset();delete form.dataset.proxyId};form.append(reset);root.append(form)
  const message=node('p');message.id='proxyMessage';root.append(message);const rows=node('div');rows.id='proxyRows';root.append(rows)
  const execute=async(name,payload)=>{try{await controller.command(name,payload);message.textContent='Збережено';await controller.refresh()}catch(e){message.textContent=e.message}}
  capacity.onsubmit=e=>{e.preventDefault();void execute('core.operations.update',{values:{maximumBotsPerProxy:Number(limit.value)},expectedRevision:controller.data.operationsPolicy.revision})}
  form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));data.port=Number(data.port);data.protocol='socks5';if(form.dataset.proxyId){data.proxyId=Number(form.dataset.proxyId);if(!data.username&&!data.password){delete data.username;delete data.password}}form.elements.password.value='';await execute('core.proxy.save',data);delete data.password}
 }
 const data=controller.data.proxyResources,rows=document.getElementById('proxyRows');rows.replaceChildren()
 if(!data){rows.append(node('p','Дані ресурсів недоступні'));return}
 if(document.activeElement!==document.getElementById('proxyCapacity'))document.getElementById('proxyCapacity').value=data.maximumBotsPerProxy
 rows.append(node('p',`Проксі: ${data.configured}; активні: ${data.active}; зайнято/зарезервовано: ${data.used}; вільно: ${data.available}. Доступність мережі не перевірялась.`))
 const table=node('table'),head=node('tr');for(const text of ['Назва','Host','Port','Тип','Стан','Боти','Місткість','Дії'])head.append(node('th',text));table.append(head)
 for(const p of data.proxies){const tr=node('tr');for(const value of [p.name,p.host,p.port,p.protocol,`${p.status}${p.used?' — використовується '+p.used+' ботами':''}${p.overCapacity?' — понад ліміт':''}${p.blocker?' · '+p.blocker:''}${p.diagnostic?' · остання помилка '+p.diagnostic.code:''}`,p.allocations.map(a=>`${a.botId} (${a.state})`).join(', '),`${p.used}/${p.capacity}; вільно ${p.available}`])tr.append(node('td',String(value)))
  const actions=node('td'),edit=node('button','Редагувати'),toggle=node('button',p.active?'Вимкнути':'Увімкнути'),remove=node('button','Видалити');remove.disabled=p.used>0
  edit.onclick=()=>{const f=document.getElementById('proxyForm');f.reset();f.dataset.proxyId=p.proxyId;for(const k of ['name','host','port'])f.elements[k].value=p[k]}
  const act=async(command,payload)=>{try{await controller.command(command,payload);await controller.refresh()}catch(e){document.getElementById('proxyMessage').textContent=e.message}}
  toggle.onclick=()=>void act('core.proxy.save',{proxyId:p.proxyId,active:!p.active});remove.onclick=()=>void act('core.proxy.delete',{proxyId:p.proxyId});actions.append(edit,toggle,remove);tr.append(actions);table.append(tr)
 }
 rows.append(table)
}
