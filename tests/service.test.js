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
test('创建后短暂读不到文件，只重试读取而不重复创建', async () => {
    const store = new MemoryStore(), read = store.read.bind(store), write = store.write.bind(store);
    let hidden = 0, writes = 0;
    store.write = async (...args) => { writes++; const saved = await write(...args); hidden = 2; return saved; };
    store.read = async (...args) => hidden-- > 0 ? null : read(...args);
    const world = await new WorldService(store, 'pa').create({ id: 'eventual-world', name: '延迟读回', cardKey: 'card' });
    assert.equal(world.id, 'eventual-world'); assert.equal(writes, 1);
});
test('追加成功后暂时读到旧版本，不重复上传并等待自己的事件出现', async () => {
    const store = new MemoryStore(), original = fixture(); await store.write(original.id, original, null);
    const read = store.read.bind(store), write = store.write.bind(store);
    let stale = 0, writes = 0;
    store.write = async (...args) => { writes++; const saved = await write(...args); stale = 2; return saved; };
    store.read = async (...args) => stale-- > 0 ? { world: original, token: '0' } : read(...args);
    const world = await new WorldService(store, 'pa').transact(original.id, { type: 'event.append', event: event() });
    assert.equal(world.events.length, 1); assert.equal(writes, 1);
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
test('连续两轮不会把对方上一轮行动当作新回复', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const a = new WorldService(store, 'pa'), b = new WorldService(store, 'pb');
    const make = (service, actorId, other, input) => service.stageTurn({ actorId, input, time: storyTime(0, '08:00'), participantIds: [other] });
    const firstA = make(a, 'a', 'b', '第一轮甲'), firstB = make(b, 'b', 'a', '第一轮乙');
    const first = await Promise.all([a.waitForScene('world-one', firstA, { intervalMs: 5 }), b.waitForScene('world-one', firstB, { intervalMs: 5 })]);
    assert.equal(first[0].responses[0].input, '第一轮乙');
    assert.equal(first[1].responses[0].input, '第一轮甲');
    const secondA = make(a, 'a', 'b', '第二轮甲'); secondA.expiresAt = Date.now() + 45;
    const second = await a.waitForScene('world-one', secondA, { intervalMs: 5 });
    assert.equal(second.timedOut, true);
    assert.deepEqual(second.responses, []);
    const thirdA = make(a, 'a', 'b', '新一轮甲'), thirdB = make(b, 'b', 'a', '新一轮乙');
    const third = await Promise.all([a.waitForScene('world-one', thirdA, { intervalMs: 5 }), b.waitForScene('world-one', thirdB, { intervalMs: 5 })]);
    assert.equal(third[0].responses[0].input, '新一轮乙');
    assert.equal(third[1].responses[0].input, '新一轮甲');
});
test('三人同场时每个人都能读取本轮其他两人的行动', async () => {
    const store = new MemoryStore(), world = fixture();
    world.actors.push(makeActor({ id: 'c', name: '丙', ownerId: 'pc', data: { location: '王城' } }));
    await store.write('world-one', world, null);
    const ids = ['a', 'b', 'c'], services = ids.map((id) => new WorldService(store, 'p' + id));
    const turns = services.map((service, index) => service.stageTurn({ actorId: ids[index], input: ids[index] + '的行动', time: storyTime(0, '08:00'), participantIds: ids.filter((id) => id !== ids[index]) }));
    const results = await Promise.all(services.map((service, index) => service.waitForScene('world-one', turns[index], { intervalMs: 5 })));
    for (let i = 0; i < ids.length; i++) {
        assert.equal(results[i].timedOut, false);
        assert.deepEqual(results[i].responses.map((row) => row.input).sort(), ids.filter((id) => id !== ids[i]).map((id) => id + '的行动').sort());
    }
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
