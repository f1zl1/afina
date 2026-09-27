export default class AccountManager{
    constructor({logger, eventBus, dataBaseManager}){
        this.logger = logger.child("AccountManager");
        this.eventBus = eventBus;
        this.dataBaseManager = dataBaseManager;
    }

}