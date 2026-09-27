import test from 'node:test'
import assert from 'node:assert/strict'
import {durationPresentation,durationMilliseconds,stopModeLabels,help} from '../src/webTerminal/public/js/operationsPolicyUi.js'

test('Operations UI converts persisted milliseconds to stable human units and back',()=>{
    assert.deepEqual(durationPresentation(10_000),{value:10,unit:1000})
    assert.deepEqual(durationPresentation(300_000),{value:5,unit:60_000})
    assert.deepEqual(durationPresentation(7_200_000),{value:2,unit:3_600_000})
    assert.equal(durationMilliseconds(2,60_000),120_000)
    assert.equal(durationMilliseconds(1.5,3_600_000),5_400_000)
})

test('Operations UI keeps internal enum values while exposing Ukrainian labels and meaningful help',()=>{
    assert.deepEqual(Object.keys(stopModeLabels),['immediate','graceful','finishCurrentCycle'])
    assert.equal(stopModeLabels.finishCurrentCycle,'Завершити поточний цикл')
    assert.match(help.minimum,/Нижня межа/)
    assert.match(help.schedule,/через північ/)
    assert.match(help.reserve,/готових доступних акаунтів/)
})
