/** Future providers return real observations/proposals, or null; never invented metrics.
 * Market snapshot: {available, items:[{itemId,buyPrice,sellPrice,margin,salesVelocity,
 *   competition,marketDepth,estimatedProfitPerHour,confidence,observedAt}]}; unknown fields = null.
 * Analysis task: {itemId,reasonCodes,requestedAt} | null.
 * Pricing quote: {buyPrice,sellPrice,source,observedAt} | null.
 * Allocation proposal: [{itemId,desiredBots,improvementPercent:number|null}] | null.
 * All proposals still pass user constraints in CoreDecisionEngine.
 */
export class MarketModel{getSnapshot(){return {available:false,items:[]}}}
export class AnalysisPlanner{getNextAnalysisTask(){return null}}
export class PricingEngine{quote(){return null}}
export class AllocationEngine{propose(){return null}}
export function foundationEngines(){return {market:new MarketModel(),analysis:new AnalysisPlanner(),pricing:new PricingEngine(),allocation:new AllocationEngine()}}
