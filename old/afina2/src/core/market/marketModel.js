import {MarketModel as MarketModelContract} from '../economicContracts.js'
export default class MarketModel extends MarketModelContract{
    constructor({store,policy}){super();this.store=store;this.policy=policy;this.available=true}
    getSnapshot(){return this.store.snapshot(this.policy())}
}
