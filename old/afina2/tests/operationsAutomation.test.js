import test from 'node:test'
import assert from 'node:assert/strict'
import {defaultOperationsPolicy,mergeOperationsPolicy,effectiveOperationsPolicy} from '../src/core/operationsPolicy.js'

const role={enabled:true,minimum:1,target:2,maximum:3,priority:80,autoStart:true,autoReplace:true,stopMode:'finishCurrentCycle'}
const policy=extra=>mergeOperationsPolicy(defaultOperationsPolicy,{automationEnabled:true,capacity:{minimum:0,target:3,maximum:4},roles:{reseller:role},...extra})

test('operations automation has a safe persisted-model default and strict capacity validation',()=>{
    assert.equal(defaultOperationsPolicy.automationEnabled,false)
    assert.equal(policy({capacity:{minimum:3,target:2,maximum:4}}).capacity.target,2)
    assert.equal(policy({capacity:{minimum:0,target:999,maximum:4}}).capacity.target,2)
    assert.throws(()=>policy({roles:{reseller:{...role,minimum:-1}}}),/minimum/)
})

test('same-day and cross-midnight schedules are evaluated in the configured timezone',()=>{
    const p=policy({timezone:'Europe/Oslo',schedules:[
        {id:'weekday',role:'reseller',weekdays:[1],start:'07:00',end:'23:00',enabled:true,roleEnabled:true,capacity:{minimum:1,target:3,maximum:3}},
        {id:'night',role:'reseller',weekdays:[1],start:'23:00',end:'07:00',enabled:true,roleEnabled:false,capacity:{minimum:0,target:0,maximum:0}}
    ]})
    assert.equal(effectiveOperationsPolicy(p,new Date('2026-09-21T10:00:00Z')).roles.reseller.target,3)
    assert.equal(effectiveOperationsPolicy(p,new Date('2026-09-21T22:30:00Z')).roles.reseller.target,0)
    assert.equal(effectiveOperationsPolicy(p,new Date('2026-09-22T04:00:00Z')).roles.reseller.target,0)
})

test('IANA scheduling follows Europe/Oslo DST and exposes the next effective transition',()=>{
    const p=policy({timezone:'Europe/Oslo',schedules:[{id:'morning',role:'reseller',weekdays:[7],start:'03:30',end:'04:30',enabled:true,roleEnabled:true,capacity:{minimum:1,target:2,maximum:3}}]})
    const before=effectiveOperationsPolicy(p,new Date('2026-03-29T00:00:00Z'))
    assert.equal(before.roles.reseller.target,2)
    assert.equal(new Date(before.nextTransition.at).toISOString(),'2026-03-29T01:30:00.000Z')
    assert.equal(effectiveOperationsPolicy(p,new Date('2026-03-29T01:45:00Z')).roles.reseller.target,2)
})

test('role priority deterministically applies the hard global maximum',()=>{
    const p=policy({roles:{reseller:role,analyst:{...role,target:3,maximum:3,priority:100}}})
    const effective=effectiveOperationsPolicy(p,new Date('2026-09-21T10:00:00Z'))
    assert.equal(effective.roles.analyst.target,3)
    assert.equal(effective.roles.reseller.target,1)
})

test('no matching schedule inherits base policy and disabled roles become exact zero capacity',()=>{
    const scheduled=policy({schedules:[{id:'monday',role:'reseller',weekdays:[1],start:'07:00',end:'08:00',enabled:true,roleEnabled:true,capacity:null}]})
    const noMatch=effectiveOperationsPolicy(scheduled,new Date('2026-09-22T10:00:00Z'))
    assert.equal(noMatch.roles.reseller.target,2)
    const disabled=effectiveOperationsPolicy(policy({roles:{reseller:{...role,enabled:false}}}),new Date('2026-09-22T10:00:00Z'))
    assert.deepEqual([disabled.roles.reseller.minimum,disabled.roles.reseller.target,disabled.roles.reseller.maximum],[0,0,0])
})

test('overlapping windows for the same role are rejected instead of using array order',()=>{
    assert.throws(()=>policy({schedules:[
        {id:'first',role:'reseller',weekdays:[1],start:'07:00',end:'12:00',enabled:true,roleEnabled:true,capacity:null},
        {id:'second',role:'reseller',weekdays:[1],start:'11:00',end:'13:00',enabled:true,roleEnabled:false,capacity:null}
    ]}),/Schedule conflict/)
})
