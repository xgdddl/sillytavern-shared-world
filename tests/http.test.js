import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GitHubStore } from '../src/storage.js';
import { WorldService } from '../src/service.js';
import { fixture, event } from './fixtures.js';
import { WorldController } from '../src/controller.js';
import { MemoryStore } from '../src/storage.js';

async function api(t) {
    const files = new Map(); let revision = 0, conditionalHits = 0, modelResponse = '', modelRequests = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const send = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
        if (url.pathname === '/v1/chat/completions') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            modelRequests.push(JSON.parse(raw));
            return send(200, { choices: [{ message: { content: modelResponse } }] });
        }
        if (url.pathname === '/user') return send(200, { id: req.headers.authorization === 'Bearer player-b' ? 102 : 101, login: req.headers.authorization === 'Bearer player-b' ? 'player-b' : 'player-a' });
        if (url.pathname === '/repos/test/stories') return send(200, { private: true, permissions: { push: true } });
        const path = decodeURIComponent(url.pathname.replace('/repos/test/stories/contents/', ''));
        if (req.method === 'PUT') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw), old = files.get(path);
            await new Promise((resolve) => setTimeout(resolve, 3));
            if ((files.get(path)?.sha ?? null) !== (body.sha ?? null)) return send(409, { message: 'version conflict' });
            const value = { sha: String(++revision), content: body.content, encoding: 'base64' };
            files.set(path, value); return send(201, { content: { sha: value.sha } });
        }
        if (files.has(path)) {
            const value = files.get(path), etag = '"' + value.sha + '"';
            if (req.headers['if-none-match'] === etag) { conditionalHits++; res.writeHead(304).end(); return; }
            return send(200, value, { ETag: etag });
        }
        const rows = [...files.keys()].filter((key) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map((key) => ({ name: key.slice(path.length + 1), type: 'file' }));
        return rows.length ? send(200, rows) : send(404, { message: 'not found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const store = (token = 'player-a') => new GitHubStore({ owner: 'test', repo: 'stories', directory: 'worlds', token: () => token, fetchImpl: (url, options) => { const target = new URL(url); return fetch(base + target.pathname + target.search, options); } });
    return { store, files, hits: () => conditionalHits, endpoint: base + '/v1', setModel: (value) => { modelResponse = value; }, modelRequests };
}
test('实际HTTP双客户端遇到同一文件版本竞争后，两份经历均持久化并支持离线重连', async (t) => {
    const remote = await api(t), aStore = remote.store(), bStore = remote.store('player-b');
    let world = fixture(); world.actors[0].ownerId = 'github:101'; world.actors[1].ownerId = 'github:102';
    await aStore.write(world.id, world, null);
    const a = new WorldService(aStore, 'github:101'), b = new WorldService(bStore, 'github:102');
    await Promise.all([
        a.transact(world.id, { type: 'event.append', event: event({ id: 'a-http', authorId: 'github:101', summary: '甲进入王城' }) }),
        b.transact(world.id, { type: 'event.append', event: event({ id: 'b-http', actorId: 'b', authorId: 'github:102', summary: '乙离开码头' }) }),
    ]);
    const reopened = new WorldService(remote.store('player-b'), 'github:102');
    assert.equal((await reopened.read(world.id)).events.length, 2);
    await reopened.read(world.id); assert.ok(remote.hits() >= 1);
});
test('超过旧单文件上限的中文世界以分片保存，分片被篡改时读取失败而不清空世界', async (t) => {
    const remote = await api(t), store = remote.store(); let world = fixture();
    world.actors[0].ownerId = 'github:101'; world.actors[1].ownerId = 'github:102';
    world.events = Array.from({ length: 250 }, (_, index) => event({ id: 'history-' + index, day: index, authorId: 'github:101', summary: '中文历史与🙂。'.repeat(220) }));
    assert.ok(Buffer.byteLength(JSON.stringify(world)) > 900000);
    await store.write(world.id, world, null);
    const envelope = JSON.parse(Buffer.from(remote.files.get('worlds/world-one.json').content, 'base64').toString());
    assert.equal(envelope.format, 'shared-world/chunks/1');
    assert.deepEqual((await remote.store().read(world.id)).world, world);
    const key = 'worlds/_chunks/' + envelope.parts[0] + '.json';
    remote.files.set(key, { sha: 'bad', encoding: 'base64', content: Buffer.from('{"data":"tampered"}').toString('base64') });
    await assert.rejects(remote.store().read(world.id), /分片校验失败/);
    assert.ok(remote.files.has('worlds/world-one.json'));
});
test('连接检查验证本人身份、真实写入与读回，不允许另一个账号冒用归属', async (t) => {
    const remote = await api(t), store = remote.store();
    const result = await store.connectionTest({ write: true });
    assert.equal(result.id, 'github:101'); assert.equal(result.writeVerified, true);
    const service = new WorldService(store, 'github:102');
    await assert.rejects(service.create({ name: '冒用', cardKey: 'card' }), /本人已验证/);
    for (const value of remote.files.values()) assert.ok(!Buffer.from(value.content, 'base64').toString().includes('player-a\"token'));
});
test('正文通过真实 HTTP 模型传输提取，格式错误可重试，新人物物品完整进入共同记录', async (t) => {
    const remote = await api(t), store = new MemoryStore(), settingsMap = new Map();
    const c = new WorldController({ storage: { getItem: (key) => settingsMap.get(key) ?? null, setItem: (key, value) => settingsMap.set(key, value) }, storeFactory: () => store, demoCard: { data: { name: 'HTTP 提取验收' } } });
    await c.refreshContext(); await c.createWorld({ name: 'HTTP 故事' }); await c.createActor({ name: '甲' });
    c.saveSettings({ provider: 'local', models: { extraction: { endpoint: remote.endpoint, model: 'scripted-fixture' } } });
    remote.setModel('not JSON'); const draft = await c.captureNarration('老周给甲一瓶药。', '询问药物', 'http-narration');
    assert.equal(draft.status, 'conflict'); assert.equal(c.state.world.events.length, 0);
    remote.setModel(JSON.stringify({ summary: '获得药物', time: { day: 0, clock: '08:10' }, newActors: [{ name: '老周', ref: 'zhou', evidence: '老周' }], newItems: [{ name: '药', ownerId: c.binding.actorId, quantity: 1, evidence: '一瓶药' }], participantIds: [c.binding.actorId, 'zhou'], changes: [], itemMoves: [] }));
    await c.reextractDraft(draft.id);
    assert.equal(c.state.world.events.length, 1); assert.equal(c.state.world.actors.length, 2); assert.equal(c.state.world.items.length, 1); assert.equal(c.settings.pending.length, 0);
    assert.equal(remote.modelRequests.length, 2); assert.equal(remote.modelRequests[1].model, 'scripted-fixture');
});
