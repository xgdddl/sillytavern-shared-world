import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, GitHubStore, LocalStore, parseStored } from '../src/storage.js';
import { WorldService } from '../src/service.js';
import { makeActor, storyTime } from '../src/domain.js';
import { fixture, event } from './fixtures.js';

test('双客户端同时追加不相关事件，完整保留双方历史', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const a = new WorldService(store, 'pa'), b = new WorldService(store, 'pb');
    await Promise.all([
        a.transact('world-one', { type: 'event.append', event: event({ id: 'a-event' }) }),
        b.transact('world-one', { type: 'event.append', event: event({ id: 'b-event', actorId: 'b', authorId: 'pb' }) }),
    ]);
    const saved = await store.read('world-one');
    assert.equal(saved.world.events.length, 2); assert.equal(saved.world.revision, 2);
});
test('同时接手一个NPC只成功一人，失败不会抢走归属', async () => {
    const store = new MemoryStore(), world = fixture();
    world.actors.push(makeActor({ id: 'npc', name: 'NPC' }));
    await store.write(world.id, world, null);
    const result = await Promise.allSettled(['pa', 'pb'].map((id) => new WorldService(store, id).transact(world.id, { type: 'actor.claim', actorId: 'npc' })));
    assert.equal(result.filter((row) => row.status === 'fulfilled').length, 1);
    assert.ok(['pa', 'pb'].includes((await store.read(world.id)).world.actors.find((actor) => actor.id === 'npc').ownerId));
});
test('不同卡不能加入同一世界', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    await assert.rejects(new WorldService(store, 'pa').read('world-one', 'another-card'), /版本/);
});
test('两边先发布行动再等待，不会互相等待到死锁', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const a = new WorldService(store, 'pa'), b = new WorldService(store, 'pb');
    const turnA = a.stageTurn({ actorId: 'a', input: '我拔剑', time: storyTime(0, '08:00'), participantIds: ['b'] });
    const turnB = b.stageTurn({ actorId: 'b', input: '我举盾', time: storyTime(0, '08:00'), participantIds: ['a'] });
    const [ra, rb] = await Promise.all([a.waitForScene('world-one', turnA, { intervalMs: 5 }), b.waitForScene('world-one', turnB, { intervalMs: 5 })]);
    assert.equal(ra.timedOut, false); assert.equal(rb.timedOut, false);
    assert.equal(ra.responses[0].input, '我举盾'); assert.equal(rb.responses[0].input, '我拔剑');
});
test('没有回应时在期限内退出等待，其他世界不受影响', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const a = new WorldService(store, 'pa');
    const turn = a.stageTurn({ actorId: 'a', input: '我问好', time: storyTime(0, '08:00'), participantIds: ['b'] });
    turn.expiresAt = Date.now() + 35;
    const started = Date.now(), result = await a.waitForScene('world-one', turn, { intervalMs: 5 });
    assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 500);
});
test('损坏存储明确失败，不清空原始文件', () => {
    assert.throws(() => parseStored('{bad'), /没有被|未覆盖/);
    assert.throws(() => parseStored({ format: 'future/99' }), /不兼容/);
    const data = new Map([['shared-world.data.v1:bad', '{bad']]);
    const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    return assert.rejects(new LocalStore(storage).read('bad')).then(() => assert.equal(data.get('shared-world.data.v1:bad'), '{bad'));
});
test('GitHub正确处理中文、写入版本与本机凭据，不把密钥写入世界', async () => {
    const calls = [], world = fixture();
    const store = new GitHubStore({
        owner: 'example', repo: 'worlds', token: () => 'test-only-secret',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (options.method === 'PUT') return { ok: true, status: 200, json: async () => ({ content: { sha: 'new-sha' } }) };
            return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(world)).toString('base64'), sha: 'old-sha' }) };
        },
    });
    const result = await store.read(world.id); assert.equal(result.world.actors[0].name, '甲');
    await store.write(world.id, world, result.token);
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.sha, 'old-sha'); assert.ok(!Buffer.from(body.content, 'base64').toString().includes('test-only-secret'));
    assert.equal(calls[1].options.headers.Authorization, 'Bearer test-only-secret');
});
test('GitHub冲突与限流不伪装成成功', async () => {
    for (const status of [409, 403, 429]) {
        const store = new GitHubStore({ owner: 'example', repo: 'worlds', token: () => 'test', fetchImpl: async () => ({ ok: false, status }) });
        await assert.rejects(store.write('world-one', fixture(), 'old'));
    }
});
test('场景等待的慢读取也受同一截止时间限制', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const baseRead = store.read.bind(store);
    let reads = 0;
    store.read = async (id, options = {}) => {
        reads++;
        if (reads <= 3) return baseRead(id);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(baseRead(id)), 500);
            options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
        });
    };
    const a = new WorldService(store, 'pa');
    const turn = a.stageTurn({ actorId: 'a', input: '我问好', time: storyTime(0, '08:00'), participantIds: ['b'] });
    turn.expiresAt = Date.now() + 55;
    const started = Date.now(), result = await a.waitForScene('world-one', turn, { intervalMs: 5 });
    assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 250);
});
