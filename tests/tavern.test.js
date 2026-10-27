import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTavern } from '../src/tavern.js';

function fakeBus() {
    const listeners = new Map();
    return {
        on(name, callback) { listeners.set(name, callback); },
        removeListener(name) { listeners.delete(name); },
        async fire(name) { await listeners.get(name)?.(); },
    };
}
function harness() {
    const bus = fakeBus(), prompts = [], captured = [];
    const ctx = { eventSource: bus, eventTypes: { CHAT_CHANGED: 'chat', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop' }, chat: [{ is_user: true, mes: '我走进王城', send_date: 'one' }], setExtensionPrompt: (...args) => prompts.push(args) };
    const binding = { enabled: true }, state = {};
    const controller = {
        binding, state, models: { depth: 0 }, changed() {}, snapshot: () => ({ world: 'one' }), matches: () => true,
        async preparePrompt() { return '本方可见的共同事实'; },
        async captureNarration(...args) { captured.push(args); },
        async refreshContext() {}, async sync() {},
    };
    return { integration: attachTavern(controller, () => ctx), bus, prompts, captured, controller, ctx };
}
test('生成前使用临时扩展提示，不插入或修改聊天原文', async () => {
    const h = harness(), original = JSON.stringify(h.ctx.chat);
    try {
        await h.integration.intercept([], 1000, () => assert.fail('不应停止'), 'normal');
        assert.equal(JSON.stringify(h.ctx.chat), original);
        assert.equal(h.prompts.at(-1)[1], '本方可见的共同事实');
        assert.equal(h.prompts.at(-1)[2], 1);
    } finally { h.integration.dispose(); }
});
test('一次正常正文结束只捕获一次，不把后台生成当新回合', async () => {
    const h = harness();
    try {
        await h.integration.intercept([], 1000, () => {}, 'normal');
        h.ctx.chat.push({ is_user: false, mes: '我已进入王城', send_date: 'two' });
        await h.bus.fire('end'); await h.bus.fire('end');
        assert.equal(h.captured.length, 1);
        assert.equal(h.captured[0][0], '我已进入王城');
        h.controller.models.depth = 1;
        await h.integration.intercept([], 1000, () => {}, 'quiet');
        await h.bus.fire('end');
        assert.equal(h.captured.length, 1);
    } finally { h.integration.dispose(); }
});
test('停止生成和关闭联机不会发布半段正文或留住旧注入', async () => {
    const h = harness();
    try {
        await h.integration.intercept([], 1000, () => {}, 'normal');
        await h.bus.fire('stop'); h.ctx.chat.push({ is_user: false, mes: '未完成正文' }); await h.bus.fire('end');
        assert.equal(h.captured.length, 0);
        h.binding = null;
        h.controller.binding.enabled = false;
        await h.integration.intercept([], 1000, () => {}, 'normal');
        assert.equal(h.prompts.at(-1)[1], '');
    } finally { h.integration.dispose(); }
});
