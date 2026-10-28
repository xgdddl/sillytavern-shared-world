import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, contextFor, copy, project, storyTime } from '../src/domain.js';
import { normalizeRecord } from '../src/records.js';
import { createInvite, parseInvite, SecretVault } from '../src/connection.js';
import { narrativePrompt, summaryPrompt } from '../src/prompts.js';
import { MemoryStore } from '../src/storage.js';
import { WorldService } from '../src/service.js';
import { WorldController } from '../src/controller.js';
import { ModelRouter } from '../src/ai.js';
import { fixture, event } from './fixtures.js';

const append = (world, record) => applyOperation(world, { type: 'event.append', playerId: record.authorId, event: record });
const storage = () => { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }; };
function staged(actorId, states, changes = []) {
    return { ...event({ id: 'scene-' + actorId, actorId, authorId: actorId === 'a' ? 'pa' : 'pb', changes }), scene: { id: 'shared-scene', actorIds: ['a', 'b'], states } };
}
const states = (a = '', b = '') => ({ a: { identity: '旅人', location: '王城', status: a }, b: { identity: '商人', location: '王城', status: b } });

test('共同开场和不相关角色的全局未来节点都进入叙事约束，摘要不泄露未来', () => {
    let world = fixture(); world.opening = '天下只有一座王城';
    world = append(world, { ...event({ day: 20, summary: '世界将在第20天爆炸' }), scope: 'world' });
    assert.equal(contextFor(world, 'b', storyTime(3, '08:00')).anchors.length, 1);
    const prompt = narrativePrompt(world, 'b', storyTime(3, '08:00'));
    assert.ok(prompt.includes(world.opening)); assert.ok(prompt.includes('世界将在第20天爆炸'));
    assert.ok(!summaryPrompt(world, 'b', storyTime(3, '08:00').tick).includes('世界将在第20天爆炸'));
});
test('两人先后声称同一独占身份会报冲突，有依据的正式交接可以继续', () => {
    const fact = (value, previous) => ({ key: 'ruler:王国', label: '王国帝王', value, previous, scope: 'world', exclusive: true });
    let world = append(fixture(), { ...event(), facts: [fact('a', null)] });
    assert.throws(() => append(world, { ...event({ id: 'other', actorId: 'b', authorId: 'pb', clock: '09:00' }), facts: [fact('b', null)] }), /共同事实/);
    world = append(world, { ...event({ id: 'succession', actorId: 'b', authorId: 'pb', clock: '10:00' }), facts: [fact('b', 'a')] });
    assert.equal(project(world).facts['ruler:王国'].value, 'b');
    assert.throws(() => append(world, { ...event({ id: 'past-rewrite', day: 0, clock: '09:30' }), facts: [fact('c', 'a')] }), /共同事实/);
});
test('正文中新NPC、新物品和消耗在同一事务中登记，重复提交不重复造人', () => {
    const world = fixture();
    const draft = { id: 'discovery', actorId: 'a', narration: '船匠老周递给甲两瓶药，甲喝了一瓶。', createdAt: 'now' };
    const record = normalizeRecord({ summary: draft.narration, time: { day: 0, clock: '08:00' }, newActors: [{ ref: 'npc', name: '老周', profile: { identity: '船匠', location: '王城' }, evidence: '船匠老周' }], newItems: [{ ref: 'medicine', name: '药', description: '治疗药', ownerId: 'a', quantity: 2, evidence: '两瓶药' }], participantIds: ['a', 'npc'], itemChanges: [{ itemId: 'medicine', field: 'quantity', value: 1 }] }, world, draft, 'pa');
    const saved = append(world, record);
    assert.equal(saved.actors.length, 3); assert.equal(saved.items.length, 1);
    assert.equal(project(saved).items[saved.items[0].id].quantity, 1);
    assert.deepEqual(append(saved, record), saved);
    assert.equal(world.actors.length, 2);
});
test('没有原文证据的新人物和事实不会变成共享记录', () => {
    const draft = { id: 'x', actorId: 'a', narration: '甲喝茶。' };
    assert.throws(() => normalizeRecord({ time: { day: 0, clock: '08:00' }, newActors: [{ name: '不存在', evidence: '甲登基了' }] }, fixture(), draft, 'pa'), /依据不在/);
});
test('已知别名重新出现不会重复登记，歧义引用拒绝猜测', () => {
    const world = fixture(); world.actors[1].aliases = ['老乙'];
    const record = normalizeRecord({ summary: '老乙走来', time: { day: 0, clock: '08:00' }, newActors: [{ ref: 'found', name: '老乙', evidence: '老乙' }], participantIds: ['found'] }, world, { id: 'alias', actorId: 'a', narration: '老乙走来' }, 'pa');
    assert.equal(record.newActors.length, 0); assert.ok(record.participantIds.includes('b'));
});
test('背景人物与托管人物真正有区别，未授权物品消耗被拦截', () => {
    let world = fixture(); world.actors[1].delegation.movement = true; world.actors[1].exitMode = 'background';
    const record = event({ changes: [{ actorId: 'b', field: 'location', value: '城外', category: 'movement' }] });
    assert.throws(() => append(world, record), /背景人物/);
    world.actors[1].exitMode = 'delegated'; assert.equal(project(append(world, record)).actors.b.profile.location, '城外');
    world.items.push({ id: 'b-item', name: '乙的药', ownerId: 'b', createdTick: 0 });
    assert.throws(() => append(world, { ...event(), itemChanges: [{ itemId: 'b-item', field: 'quantity', value: 0 }] }), /未获准/);
});
test('一份现场胜负不抢先成为事实，双方矛盾会同时保留而不判先上传者获胜', () => {
    let world = append(fixture(), staged('a', states('安好', '死亡')));
    assert.equal(world.events.length, 0); assert.equal(world.proposals.length, 1);
    world = append(world, staged('b', states('死亡', '安好')));
    assert.equal(world.events.length, 0);
    assert.ok(world.proposals.every((row) => row.status === 'conflict'));
});
test('双方现场状态一致时两份正文一起确认，重试不重复记录', () => {
    let world = fixture(); world.actors[1].delegation.combat = true;
    const change = { actorId: 'b', field: 'status', value: '受伤', category: 'combat' };
    const a = staged('a', states('', '受伤'), [change]), b = staged('b', states('', '受伤'), [change]);
    world = append(append(world, a), b);
    assert.equal(world.events.length, 2); assert.equal(world.proposals.length, 0);
    assert.equal(project(world).actors.b.profile.status, '受伤');
    assert.equal(append(world, a).events.length, 2);
});
test('只有一方结果且超时，可以在授权范围继续；双方冲突不能用超时覆盖', () => {
    let world = append(fixture(), staged('a', states())); world.proposals[0].expiresAt = 0;
    world = applyOperation(world, { type: 'proposal.expire', eventId: 'scene-a', playerId: 'pa' });
    assert.equal(world.events.length, 1);
    world = append(append(fixture(), staged('a', states('活着', '死亡'))), staged('b', states('死亡', '活着')));
    world.proposals[0].expiresAt = 0;
    assert.throws(() => applyOperation(world, { type: 'proposal.expire', eventId: 'scene-a', playerId: 'pa' }), /不能用超时覆盖/);
});
test('同一玩家的两个设备不能同时操作不同人物，转移后旧设备不能续租', () => {
    let world = fixture();
    world = applyOperation(world, { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'phone' });
    assert.throws(() => applyOperation(world, { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'pc' }), /另一个页面/);
    world = applyOperation(world, { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'pc', takeover: true });
    assert.throws(() => applyOperation(world, { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'phone' }), /另一个页面/);
});
test('跨设备邀请包含共同来源，不包含 localhost、口令或密钥', () => {
    const settings = { provider: 'github', github: { owner: 'example', repo: 'stories', branch: 'main', directory: 'worlds', token: 'private-secret' } };
    const code = createInvite(fixture(), settings), parsed = parseInvite(code);
    assert.equal(parsed.worldId, 'world-one'); assert.equal(parsed.github.repo, 'stories');
    assert.ok(!JSON.stringify(parsed).includes('secret')); assert.ok(!code.includes('localhost'));
    assert.throws(() => createInvite(fixture(), { provider: 'local' }), /不能跨设备/);
});
test('本机密钥加密保存后刷新可解锁，错误口令不覆盖数据', async () => {
    const local = storage(), vault = new SecretVault(local);
    await vault.save(new Map([['github', 'private-token']]), 'fictional-password-for-test');
    const original = local.getItem(vault.key); assert.ok(!original.includes('private-token'));
    await assert.rejects(vault.unlock('wrong-password-for-test'), /解锁失败/);
    assert.equal(local.getItem(vault.key), original);
    assert.equal((await new SecretVault(local).unlock('fictional-password-for-test')).get('github'), 'private-token');
});
test('提取失败的正文可直接重提取；恢复导出产生新世界，原历史不覆盖', async () => {
    const store = new MemoryStore(); let success = false;
    const c = new WorldController({ storage: storage(), demoCard: { data: { name: '测试' } }, storeFactory: () => store });
    await c.refreshContext(); await c.createWorld({ name: '原世界' }); await c.createActor({ name: '我' });
    c.models.generate = async () => success ? JSON.stringify({ summary: '喝茶', time: { day: 0, clock: '08:00' }, changes: [], itemMoves: [] }) : '格式错误';
    const draft = await c.captureNarration('我喝茶。', '喝茶', 'one'); assert.equal(draft.status, 'conflict');
    success = true; await c.reextractDraft(draft.id);
    assert.equal(c.settings.pending.length, 0); assert.equal(c.state.world.events.length, 1);
    const oldId = c.state.world.id, raw = c.exportWorld();
    await c.importWorld(raw);
    assert.notEqual(c.state.world.id, oldId); assert.equal(c.state.world.events.length, 1);
    assert.equal((await store.read(oldId)).world.events.length, 1);
});
test('一个玩家离线后另一客户端仍可读取持久历史；跨源切换保留原绑定', async () => {
    const store = new MemoryStore(); await store.write('world-one', fixture(), null);
    const a = new WorldService(store, 'pa'), b = new WorldService(store, 'pb');
    await a.transact('world-one', { type: 'event.append', event: { ...event(), summary: '甲已登基', facts: [{ key: 'ruler:王国', label: '帝王', value: 'a', scope: 'world', exclusive: true, previous: null }] } });
    const reconnected = new WorldService(store, 'pb');
    assert.equal(project(await reconnected.read('world-one')).facts['ruler:王国'].value, 'a');
    const c = new WorldController({ storage: storage(), demoCard: { data: { name: '测试' } }, storeFactory: () => store });
    await c.refreshContext(); c.bind({ worldId: 'saved-local' });
    c.saveSettings({ provider: 'github', github: { owner: 'a', repo: 'b', branch: 'main', directory: 'worlds' } });
    assert.equal(c.binding.worldId, ''); c.saveSettings({ provider: 'local' }); assert.equal(c.binding.worldId, 'saved-local');
});
test('取得设备控制后，旧设备不能继续把已经生成的正文写入共同历史', () => {
    let world = applyOperation(fixture(), { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'old' });
    world = applyOperation(world, { type: 'control.acquire', actorId: 'a', playerId: 'pa', sessionId: 'new', takeover: true });
    assert.throws(() => applyOperation(world, { type: 'event.append', playerId: 'pa', sessionId: 'old', event: event() }), /控制已过期或转移/);
});
test('旧版历史保留并升级格式，旧客户端不会把新版事实当普通旧存档改写', () => {
    const legacy = fixture(); legacy.format = 'shared-world/1';
    const upgraded = append(legacy, event());
    assert.equal(upgraded.format, 'shared-world/2'); assert.equal(legacy.format, 'shared-world/1');
});
test('复用酒馆模型超时能停止后台生成，取消函数失败也能返回并保留草稿', async () => {
    const router = new ModelRouter({ timeoutMs: 10, getSettings: () => ({ models: {} }), getSecret: () => '', getContext: () => ({ generateRaw: () => new Promise(() => {}), stopGeneration: () => { throw new Error('cancel failed'); } }) });
    await assert.rejects(router.generate('extraction', 'test'), /超过等待期限/); assert.equal(router.depth, 0);
});
