import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, contextFor, makeActor, makeWorld, policy, project, storyTime, cardFingerprint } from '../src/domain.js';

import { fixture, event } from './fixtures.js';
import { sha256Bytes } from '../src/sha256.js';
test('必须有具体故事日和有效钟点', () => {
    assert.equal(storyTime('20', '08:30').tick, 29310);
    for (const pair of [[-1, '12:00'], [3.2, '08:00'], [0, '24:00'], [null, '08:00'], [1, '昨天']]) assert.throws(() => storyTime(...pair), /故事/);
});
test('固定人物模板拒绝自造字段与损坏类型', () => {
    assert.throws(() => makeActor({ name: '甲', data: { inventedPower: 9000 } }), /未支持字段/);
    assert.throws(() => makeActor({ name: '甲', data: { abilities: {} } }), /必须是文字/);
    assert.throws(() => policy({ death: 'yes' }), /布尔/);
});
test('人物归属永久保留、别人不能抢占', () => {
    const world = fixture();
    assert.throws(() => applyOperation(world, { type: 'actor.claim', actorId: 'a', playerId: 'pb' }), /不能接手/);
    const exited = applyOperation(world, { type: 'actor.exit', actorId: 'a', playerId: 'pa', mode: 'background' });
    assert.throws(() => applyOperation(exited, { type: 'actor.claim', actorId: 'a', playerId: 'pb' }), /不能接手/);
});
test('每人最多三个，可接手未归属 NPC', () => {
    let world = fixture();
    for (const id of ['c', 'd']) world = applyOperation(world, { type: 'actor.create', playerId: 'pa', actor: makeActor({ id, name: id, ownerId: 'pa' }) });
    const npc = makeActor({ id: 'npc', name: '未归属人物' });
    world = applyOperation(world, { type: 'actor.create', playerId: 'pa', actor: npc });
    assert.throws(() => applyOperation(world, { type: 'actor.claim', playerId: 'pa', actorId: 'npc' }), /最多/);
    const claimed = applyOperation(world, { type: 'actor.claim', playerId: 'pb', actorId: 'npc' });
    assert.equal(claimed.actors.find((actor) => actor.id === 'npc').ownerId, 'pb');
});
test('第3天读取历史状态，第20天承接登基结果，允许补写', () => {
    let world = fixture();
    world = applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ day: 20, changes: [{ actorId: 'a', field: 'identity', value: '帝王', category: 'politics' }] }) });
    world = applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ id: 'past', day: 3, summary: '第3天仍在做旅人' }) });
    assert.equal(project(world, storyTime(3, '09:00').tick).actors.a.profile.identity, '旅人');
    assert.equal(project(world, storyTime(20, '09:00').tick).actors.a.profile.identity, '帝王');
    assert.equal(contextFor(world, 'a', storyTime(3, '09:00')).anchors.length, 1);
});
test('不允许同时确认互斥状态，不修改输入快照', () => {
    const initial = fixture();
    const first = applyOperation(initial, { type: 'event.append', playerId: 'pa', event: event({ changes: [{ actorId: 'a', field: 'location', value: '城内', category: 'movement' }] }) });
    assert.equal(initial.events.length, 0);
    assert.throws(() => applyOperation(first, { type: 'event.append', playerId: 'pa', event: event({ id: 'second', changes: [{ actorId: 'a', field: 'location', value: '城外', category: 'movement' }] }) }), /同一时间/);
});
test('正文重生成不会覆盖已经共享的事实，相同来源幂等', () => {
    let world = fixture();
    const original = event({ source: { key: 'chat:1', hash: 'original' } });
    world = applyOperation(world, { type: 'event.append', playerId: 'pa', event: original });
    assert.equal(applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ id: 'duplicate', source: original.source }) }).events.length, 1);
    assert.throws(() => applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ id: 'rewrite', source: { key: 'chat:1', hash: 'changed' } }) }), /不能覆盖/);
});
test('不能越过别人设置的托管范围', () => {
    const world = fixture();
    assert.throws(() => applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ changes: [{ actorId: 'b', field: 'status', value: '死亡', category: 'death' }] }) }), /托管范围/);
    const allowed = applyOperation(world, { type: 'actor.policy', playerId: 'pb', actorId: 'b', delegation: { death: true } });
    assert.equal(applyOperation(allowed, { type: 'event.append', playerId: 'pa', event: event({ changes: [{ actorId: 'b', field: 'status', value: '死亡', category: 'death' }] }) }).events.length, 1);
});
test('物品归属历史不被并发或回填破坏', () => {
    let world = fixture();
    world = applyOperation(world, { type: 'item.create', playerId: 'pa', item: { id: 'sword', name: '剑', description: '', ownerId: 'a', createdTick: 0 } });
    world = applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ day: 20, itemMoves: [{ itemId: 'sword', fromActorId: 'a', toActorId: 'b' }] }) });
    assert.equal(project(world, storyTime(3, '00:00').tick).items.sword.ownerId, 'a');
    assert.throws(() => applyOperation(world, { type: 'event.append', playerId: 'pa', event: event({ id: 'bad-past', day: 3, itemMoves: [{ itemId: 'sword', fromActorId: 'a', toActorId: 'b' }] }) }), /归属/);
    assert.equal(world.events.length, 1);
});
test('私人事件不自动成为他人角色知识', () => {
    let world = fixture();
    world = applyOperation(world, { type: 'event.append', playerId: 'pb', event: event({ actorId: 'b', authorId: 'pb', visibility: 'participants', summary: '私下交谈' }) });
    assert.equal(contextFor(world, 'a', storyTime(0, '09:00')).observable.length, 0);
    assert.equal(contextFor(world, 'b', storyTime(0, '09:00')).observable.length, 1);
});
test('角色卡不同版本隔离，字段顺序不影响指纹', async () => {
    const a = await cardFingerprint({ data: { name: '卡', description: '版本1' } });
    assert.equal(a, await cardFingerprint({ data: { description: '版本1', name: '卡' } }));
    assert.notEqual(a, await cardFingerprint({ data: { name: '卡', description: '版本2' } }));
});
test('HTTP环境的指纹备用实现与标准SHA256一致', async () => {
    const encode = (value) => new TextEncoder().encode(value);
    assert.equal(sha256Bytes(encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Bytes(encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const bytes = encode('同一张卡的中文设定'.repeat(100));
    const standard = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal(sha256Bytes(bytes), standard);
});
