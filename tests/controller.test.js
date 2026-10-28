import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldController } from '../src/controller.js';
import { MemoryStore } from '../src/storage.js';
import { parseModelJson } from '../src/ai.js';
import { narrativePrompt } from '../src/prompts.js';
import { storyTime } from '../src/domain.js';
import { fixture } from './fixtures.js';

async function setup(response) {
    const store = new MemoryStore(), saved = new Map();
    const context = { extensionSettings: {}, saveSettingsDebounced() {}, generateRaw: response };
    const controller = new WorldController({
        getContext: () => context, demoCard: { name: '测试卡', description: '版本1' },
        storeFactory: () => store, storage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    });
    await controller.refreshContext(); await controller.createWorld({ name: '测试世界', opening: '', origin: '第0天' });
    await controller.createActor({ name: '主角', identity: '旅人', location: '王城' });
    return { controller, store, context };
}
test('模型解析失败、空对象和含糊时间不会成为共享事实', () => {
    for (const raw of ['oops', '{}', '{"error":"需要确认具体故事时间"}']) assert.throws(() => parseModelJson(raw));
});
test('正文直接给结果，框架只做一次变化提取，不调用双方复核', async () => {
    let calls = 0, c;
    const setupResult = await setup(async () => {
        calls++;
        return JSON.stringify({ summary: '我到达王城', time: { day: 0, clock: '08:30' }, location: '王城', visibility: 'public', participantIds: [c.binding.actorId], knownBy: [c.binding.actorId], changes: [], itemMoves: [] });
    });
    c = setupResult.controller;
    const draft = await c.captureNarration('我已经到达王城。', '我前往王城。', 'source-one');
    assert.equal(draft.status, 'shared'); assert.equal(calls, 1);
    assert.equal(c.state.world.events.length, 1); assert.equal(c.settings.pending.length, 0);
    assert.equal(c.binding.clock, '08:30');
});
test('提取失败保留原正文，个人草稿不影响共同世界', async () => {
    const { controller: c } = await setup(async () => '{}');
    const draft = await c.captureNarration('这段原文不能丢。', '输入', 'source-failed');
    assert.equal(draft.status, 'conflict'); assert.equal(draft.narration, '这段原文不能丢。');
    assert.equal(c.state.world.events.length, 0);
    c.archiveDraft(draft.id);
    assert.equal(c.settings.archivedDrafts[0].narration, '这段原文不能丢。'); assert.equal(c.settings.pending.length, 0);
});
test('AI返回期间切换聊天不会写入旧世界', async () => {
    let finish;
    const { controller: c, store } = await setup(() => new Promise((resolve) => { finish = resolve; }));
    const id = c.binding.worldId, originalActor = c.binding.actorId;
    const promise = c.captureNarration('结果', '输入', 'slow');
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    c.state.bindingKey = 'another-chat';
    finish(JSON.stringify({ summary: '结果', time: { day: 0, clock: '08:30' }, location: '王城', visibility: 'public', participantIds: [originalActor], knownBy: [originalActor], changes: [], itemMoves: [] }));
    await promise;
    assert.equal((await store.read(id)).world.events.length, 0);
    assert.match(c.settings.pending[0].error, /切换/);
});
test('其他人物的私人背景不进入本方正文，未来约束不当作角色知识', () => {
    const prompt = narrativePrompt(fixture(), 'a', storyTime(0, '09:00'));
    assert.ok(!prompt.includes('不该自动泄露的秘密'));
    assert.ok(prompt.includes('不复核') || prompt.includes('不安排另一个AI'));
});
test('密钥不持久化，也不出现在世界导出文件', async () => {
    const { controller: c, context } = await setup(async () => '');
    c.saveSettings({ provider: 'local', github: c.settings.github, models: c.settings.models }, { github: 'temporary-github-secret', 'model.extraction': 'temporary-model-secret' });
    assert.equal(c.secrets.get('github'), 'temporary-github-secret');
    assert.ok(!JSON.stringify(context.extensionSettings).includes('temporary-github-secret'));
    assert.ok(!c.exportWorld().includes('temporary-model-secret'));
});
test('开始新世界重置具体时间，不继承上个故事的第20天', async () => {
    const { controller: c } = await setup(async () => '');
    c.setTime(20, '12:30');
    await c.createWorld({ name: '另一个故事', opening: '', origin: '第0天' });
    assert.equal(c.binding.day, 0); assert.equal(c.binding.clock, '08:00');
});
test('修改本机模式下暂存的GitHub配置，不清空本机世界绑定', async () => {
    const { controller: c } = await setup(async () => '');
    const id = c.binding.worldId;
    c.saveSettings({ provider: 'local', github: { owner: 'example', repo: 'later', branch: 'main', directory: 'worlds' }, models: c.settings.models });
    assert.equal(c.binding.worldId, id);
});
test('同步期间切换聊天，迟到的现场结果不会覆盖新聊天或恢复旧草稿', async () => {
    const { controller: c } = await setup(async () => '');
    const old = fixture();
    old.proposals = [{ event: { id: 'old-event', actorId: c.binding.actorId, authorId: c.settings.playerId }, expiresAt: 0, status: 'waiting' }];
    let finish, started;
    const entered = new Promise((resolve) => { started = resolve; });
    c.service = { read: async () => old, transact: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } };
    const pending = c.sync();
    await entered;
    c.state.bindingKey = 'another-chat';
    const currentWorld = { id: 'new-chat-world' };
    c.state.world = currentWorld;
    finish(old);
    assert.equal(await pending, null);
    assert.equal(c.state.world, currentWorld);
    assert.equal(c.settings.pending.length, 0);
});
test('创建世界期间切换聊天，不会把新世界绑定到另一个聊天', async () => {
    const { controller: c } = await setup(async () => '');
    let finish, started;
    const entered = new Promise((resolve) => { started = resolve; });
    c.service.create = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const pending = c.createWorld({ name: '旧聊天新世界', opening: '', origin: '第0天' });
    await entered;
    c.state.bindingKey = 'another-chat';
    const currentWorld = { id: 'new-chat-world' };
    c.state.world = currentWorld;
    finish(fixture());
    await assert.rejects(pending, /原数据来源创建/);
    assert.equal(c.state.world, currentWorld);
    assert.equal(c.binding.worldId, '');
});
test('读取世界期间切换数据来源，不会把旧来源的世界绑定到新来源', async () => {
    const { controller: c } = await setup(async () => '');
    let finish, started;
    const entered = new Promise((resolve) => { started = resolve; });
    c.service.read = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const pending = c.joinWorld('world-one');
    await entered;
    c.settings.provider = 'github';
    c.settings.github = { owner: 'example', repo: 'other', branch: 'main', directory: 'worlds' };
    const currentWorld = { id: 'new-source-world' };
    c.state.world = currentWorld;
    finish(fixture());
    await assert.rejects(pending, /数据来源已切换/);
    assert.equal(c.state.world, currentWorld);
    assert.equal(c.binding.worldId, '');
});
test('开启联机期间切换聊天，不会在新聊天误开启联机', async () => {
    const { controller: c } = await setup(async () => '');
    let finish, started;
    const entered = new Promise((resolve) => { started = resolve; });
    c.acquireControl = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const pending = c.setEnabled(true);
    await entered;
    c.state.bindingKey = 'another-chat';
    finish();
    await assert.rejects(pending, /数据来源已切换/);
    assert.equal(c.binding.enabled, false);
});
test('发布草稿等待人物控制时切换数据来源，不能写入新来源', async () => {
    const { controller: c } = await setup(async () => '');
    const draft = { id: 'draft', bindingKey: c.state.bindingKey, worldId: c.binding.worldId, actorId: c.binding.actorId, storageSourceKey: c.sourceKey(), proposal: { id: 'draft' } };
    c.settings.pending.push(draft);
    let finish, started, writes = 0;
    const entered = new Promise((resolve) => { started = resolve; });
    c.acquireControl = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const pending = c.publishDraft(draft.id);
    await entered;
    c.settings.provider = 'github';
    c.settings.github = { owner: 'example', repo: 'other', branch: 'main', directory: 'worlds' };
    c.service = { transact: async () => { writes++; } };
    finish();
    await assert.rejects(pending, /正文仍保留为草稿/);
    assert.equal(writes, 0);
    assert.equal(c.settings.pending[0], draft);
});
