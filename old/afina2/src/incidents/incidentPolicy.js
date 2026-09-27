export const incidentPolicyFields={
    autoReplaceBannedAccounts:{type:'boolean',label:'Автоматично замінювати заблоковані тестові акаунти',description:'Відновлювати потрібну кількість ботів після бану: спочатку з наявного пулу, за окремим дозволом — через генерацію.'},
    allowAutomaticAccountGeneration:{type:'boolean',label:'Дозволити Core створювати нові акаунти'},
    maxAccounts:{type:'integer',min:0,max:1000000,label:'Ліміт усіх акаунтів для автогенерації (0 — заборонено)'}
}
