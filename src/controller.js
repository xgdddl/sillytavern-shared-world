import { MAX_ACTORS, WorldError, assert, cardFingerprint, copy, hash, makeActor, profile, project, storyTime, uid, validateEvent, validateWorld, sameLocation } from './domain.js';
import { GitHubStore, LocalStore } from './storage.js';
import { WorldService } from './service.js';
import { ModelRouter, parseModelJson } from './ai.js';
import { extractionPrompt, narrativePrompt, summaryPrompt } from './prompts.js';
import { normalizeRecord, validationWorld, sceneActors } from './records.js';
import { createInvite, parseInvite, SecretVault, identityBackup, readIdentity } from './connection.js';

const DEFAULTS = {
    provider: 'local', github: { owner: '', repo: '', branch: 'main', directory: 'shared-world/worlds' },
    models: { extraction: { endpoint: '', model: '' }, summary: { endpoint: '', model: '' }, reasoning: { endpoint: '', model: '' } },
    bindings: {}, pending: [], archivedDrafts: [], snapshots: {}, memories: {}, autoSummary: true,
};
export class WorldController extends EventTarget {
    constructor({ getContext = () => null, storage = globalThis.localStorage, namespace = 'shared-world.preferences.v1', storeFactory, demoCard, resolveCompatibility = async () => null } = {}) {
        super();
        this.getContext = getContext; this.storage = storage; this.namespace = namespace;
        this.storeFactory = storeFactory; this.demoCard = demoCard; this.secrets = new Map();
        this.resolveCompatibility = resolveCompatibility; this.sessionId = uid(); this.vault = new SecretVault(storage, namespace + '.vault');
        const ctx = getContext();
        let saved = ctx?.extensionSettings?.shared_world;
        if (!saved) {
            const raw = storage.getItem(namespace);
            if (raw) {
                try { saved = JSON.parse(raw); } catch { throw new WorldError('SETTINGS_CORRUPT', '设置文件损坏，原文没有被覆盖'); }
            }
        }
        assert(!saved || (saved && typeof saved === 'object' && !Array.isArray(saved)), 'SETTINGS_CORRUPT', '设置结构无效');
        this.settings = { ...copy(DEFAULTS), ...saved };
        assert(['local', 'github'].includes(this.settings.provider), 'SETTINGS_CORRUPT', '存储来源配置无效，没有静默改成本机存储');
        for (const field of ['pending', 'archivedDrafts']) assert(Array.isArray(this.settings[field]), 'SETTINGS_CORRUPT', field + '不是有效列表，原数据保留');
        for (const field of ['bindings', 'snapshots', 'models', 'github']) assert(this.settings[field] && typeof this.settings[field] === 'object' && !Array.isArray(this.settings[field]), 'SETTINGS_CORRUPT', field + '不是有效对象，原数据保留');
        this.settings.playerId ||= uid();
        this.settings.bindings ||= {}; this.settings.pending ||= []; this.settings.archivedDrafts ||= []; this.settings.snapshots ||= {};
        this.state = { worlds: [], world: null, cardKey: '', cardName: '', bindingKey: '', notice: '', error: '', busy: false, lastSync: null, summary: '' };
        this.save(); this.configureStore();
        this.models = new ModelRouter({ getContext, getSettings: () => this.settings, getSecret: (key) => this.secrets.get(key) });
    }
    changed() { this.dispatchEvent(new Event('change')); }
    save() {
        const ctx = this.getContext();
        if (ctx?.extensionSettings) {
            ctx.extensionSettings.shared_world = copy(this.settings);
            ctx.saveSettingsDebounced?.();
        } else this.storage.setItem(this.namespace, JSON.stringify(this.settings));
    }
    configureStore() {
        const store = this.storeFactory?.(this.settings) ?? (this.settings.provider === 'github'
            ? new GitHubStore({ ...this.settings.github, token: () => this.secrets.get('github') ?? '' })
            : new LocalStore(this.storage));
        this.service = new WorldService(store, this.settings.playerId);
    }
    get binding() {
        return this.settings.bindings[this.bindingStoreKey] ?? (this.settings.provider === 'local' ? this.settings.bindings[this.state.bindingKey] : null) ?? { worldId: '', actorId: '', day: 0, clock: '08:00', participants: [], enabled: false };
    }
    get bindingStoreKey() { return this.sourceKey() + ':' + this.state.bindingKey; }
    bind(patch) {
        assert(this.state.bindingKey, 'NO_CHAT', '请先打开一个角色聊天');
        this.settings.bindings[this.bindingStoreKey] = { ...this.binding, ...copy(patch) };
        this.save(); this.changed();
    }
    async refreshContext() {
        const ctx = this.getContext();
        const card = this.demoCard ?? ctx?.characters?.[ctx.characterId];
        const chatId = this.demoCard ? 'demo-chat' : ctx?.getCurrentChatId?.();
        if (!card || !chatId) {
            this.state.bindingKey = ''; this.state.world = null; this.state.cardName = ''; this.state.cardKey = '';
            this.changed(); return;
        }
        const key = (card.avatar ?? 'card') + ':' + chatId;
        const compatibility = await this.resolveCompatibility(ctx, card);
        const fingerprint = compatibility ? await hash({ card: await cardFingerprint(card), worldbooks: compatibility }) : await cardFingerprint(card);
        // Do not restore a world into a chat that was switched while hashing.
        if (!this.demoCard && this.getContext()?.getCurrentChatId?.() !== chatId) return;
        this.state.bindingKey = key; this.state.cardKey = fingerprint;
        this.state.cardName = card.data?.name ?? card.name ?? '当前角色卡';
        this.state.world = null;
        if (this.binding.worldId) await this.sync();
        this.changed();
    }
    async run(work) {
        if (this.state.busy) return;
        this.state.busy = true; this.state.error = ''; this.changed();
        try { return await work(); }
        catch (error) { this.state.error = error.message ?? '操作失败'; return null; }
        finally { this.state.busy = false; this.changed(); }
    }
    async listWorlds() {
        assert(this.state.cardKey, 'NO_CHAT', '请先打开一个角色聊天');
        this.state.worlds = await this.service.list(this.state.cardKey); this.changed();
        return this.state.worlds;
    }
    async createWorld({ name, opening, origin }) {
        assert(this.state.cardKey, 'NO_CHAT', '请先打开一个角色聊天');
        this.state.world = await this.service.create({ name, opening, origin, cardKey: this.state.cardKey });
        this.bind({ worldId: this.state.world.id, actorId: '', day: 0, clock: '08:00', participants: [], enabled: false });
        this.state.notice = '世界已保存。建立人物后再开启当前聊天的联机。';
        await this.listWorlds();
        return this.state.world;
    }
    async joinWorld(id) {
        assert(this.state.cardKey, 'NO_CHAT', '请先打开角色聊天');
        const world = await this.service.read(id.trim(), this.state.cardKey);
        if (world.id === this.binding.worldId && this.state.world?.id === world.id) {
            this.state.world = world; this.state.notice = '已读取当前世界的最新记录。'; this.changed(); return;
        }
        this.state.world = world; this.bind({ worldId: world.id, actorId: '', day: 0, clock: '08:00', participants: [], enabled: false });
        this.state.notice = '已读取世界。请选择归属自己的人物，或创建新人物。';
    }
    async sync() {
        if (!this.binding.worldId) return null;
        const bindingKey = this.state.bindingKey;
        const worldId = this.binding.worldId;
        let world = await this.service.read(worldId, this.state.cardKey);
        if (bindingKey !== this.state.bindingKey || worldId !== this.binding.worldId) return null;
        for (const candidate of world.proposals ?? []) {
            if (candidate.event.authorId !== this.settings.playerId || candidate.expiresAt > Date.now() || candidate.status === 'conflict') continue;
            try { world = await this.service.transact(worldId, { type: 'proposal.expire', eventId: candidate.event.id }); }
            catch (error) { this.state.error = '现场结果尚未共享：' + error.message; }
        }
        for (const candidate of world.proposals ?? []) {
            if (candidate.event.authorId !== this.settings.playerId || candidate.event.actorId !== this.binding.actorId || this.settings.pending.some((row) => row.id === candidate.event.id && row.storageSourceKey === this.sourceKey())) continue;
            const record = candidate.event;
            this.settings.pending.push({ id: record.id, worldId, actorId: record.actorId, bindingKey, storageSourceKey: this.sourceKey(), scene: record.scene, narration: record.summary, userInput: '', sourceKey: record.source?.key ?? record.id, time: record.time, createdAt: record.createdAt ?? new Date().toISOString(), status: candidate.status, error: '从共同记录恢复了现场候选摘要，原正文在原设备；可重试原候选或撤回为个人草稿。', proposal: copy(record), recovered: true });
        }
        this.state.world = world; this.state.lastSync = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        let reconciled = false;
        this.settings.pending = this.settings.pending.filter((draft) => {
            if (draft.worldId !== worldId || draft.storageSourceKey !== this.sourceKey()) return true;
            if (world.events.some((event) => event.id === draft.id)) { reconciled = true; return false; }
            const candidate = world.proposals?.find((row) => row.event.id === draft.id);
            if (candidate) { draft.status = candidate.status; draft.error = candidate.reason || '现场结果已保存，等待另一位玩家的正文；未确认的结果不会影响共同事实'; reconciled = true; }
            return true;
        });
        if (reconciled) this.save(); this.changed();
        return world;
    }
    async createActor({ name, kind = 'player', ...data }) {
        const world = this.state.world;
        assert(world, 'NO_WORLD', '请先加入世界');
        const actor = makeActor({ name, ownerId: kind === 'npc' ? null : this.settings.playerId, data: profile(data), at: storyTime(this.binding.day, this.binding.clock) });
        this.state.world = await this.service.transact(world.id, { type: 'actor.create', actor });
        if (kind !== 'npc') this.bind({ actorId: actor.id });
        this.state.notice = kind === 'npc' ? '公共人物已登记，尚未归属其他人时可以接手。' : '人物已归属你，其他玩家不能接手；一次只操作一个人物。';
    }
    async claimActor(actorId) {
        this.state.world = await this.service.transact(this.binding.worldId, { type: 'actor.claim', actorId });
        this.bind({ actorId });
    }
    selectActor(actorId) {
        assert(this.state.world?.actors.some((row) => row.id === actorId && row.ownerId === this.settings.playerId), 'OWNERSHIP', '只能操作归属自己的人物');
        this.bind({ actorId, participants: [] });
    }
    async savePolicy(delegation) {
        this.state.world = await this.service.transact(this.binding.worldId, { type: 'actor.policy', actorId: this.binding.actorId, delegation });
        this.state.notice = '托管范围已保存。已发生的托管经历不会在回归时自动撤销。';
    }
    async exitWorld(mode) {
        this.state.world = await this.service.transact(this.binding.worldId, { type: 'actor.exit', actorId: this.binding.actorId, mode });
        await this.releaseControl(); this.bind({ enabled: false, participants: [] });
        this.state.notice = mode === 'delegated' ? '已退出游玩，角色按你的设置托管。' : '已退出游玩，角色保留为背景人物。';
    }
    async addStartingItem({ name, description }) {
        assert(this.state.world && this.binding.actorId, 'NO_ACTOR', '先选择自己的人物');
        assert(!this.state.world.events.some((event) => event.participantIds.includes(this.binding.actorId)), 'INITIAL_ONLY', '人物已经开始游玩，后续物品变化只能从正文提取');
        const item = { id: uid(), name, description, ownerId: this.binding.actorId, createdTick: storyTime(this.binding.day, this.binding.clock).tick };
        this.state.world = await this.service.transact(this.binding.worldId, { type: 'item.create', item });
    }
    saveSettings(values, secrets = {}) {
        assert(['local', 'github'].includes(values.provider), 'INVALID_CONFIG', '存储来源无效');
        const before = this.sourceKey();
        const candidate = { ...this.settings, ...copy(values) };
        const previous = this.settings;
        this.settings = candidate;
        try { this.configureStore(); } catch (error) { this.settings = previous; throw error; }
        for (const slot of ['extraction', 'summary', 'reasoning']) {
            if (previous.models?.[slot]?.endpoint !== candidate.models?.[slot]?.endpoint) this.secrets.delete('model.' + slot);
        }
        for (const [key, value] of Object.entries(secrets)) if (value) this.secrets.set(key, value);
        const after = this.sourceKey();
        if (before !== after) {
            // Bindings are scoped to their source; switching back restores the old binding.
            this.state.world = null; this.state.worlds = [];
        }
        this.save(); this.state.notice = '设置已保存。密钥只保留在本次页面会话，不写进世界记录或导出文件。'; this.changed();
    }
    setTime(day, clock, participants = []) {
        const time = storyTime(day, clock);
        const view = this.state.world ? project(this.state.world, time.tick) : null;
        assert(view && participants.every((id) => view.actors[id] && sameLocation(view.actors[id].profile.location, view.actors[this.binding.actorId]?.profile.location)), 'SCENE_NOT_FOUND', '请先在故事里找到同地点人物，再选择互动目标');
        this.bind({ day: time.day, clock: time.clock, participants });
    }
    sourceKey() { return JSON.stringify({ provider: this.settings.provider, github: this.settings.provider === 'github' ? this.settings.github : null }); }
    snapshot() { return { bindingKey: this.state.bindingKey, binding: copy(this.binding), playerId: this.settings.playerId, cardKey: this.state.cardKey, sourceKey: this.sourceKey() }; }
    matches(snapshot) { return snapshot.bindingKey === this.state.bindingKey && snapshot.binding.worldId === this.binding.worldId && snapshot.binding.actorId === this.binding.actorId && snapshot.playerId === this.settings.playerId && snapshot.cardKey === this.state.cardKey && snapshot.sourceKey === this.sourceKey(); }
    async preparePrompt(input, { signal } = {}) {
        this.preparedScene = null;
        const snapshot = this.snapshot();
        if (!snapshot.binding.enabled) return '';
        const world = await this.sync();
        assert(world && this.matches(snapshot), 'CHAT_CHANGED', '聊天或世界已切换，本次未注入旧世界');
        assert(!this.settings.pending.some((row) => row.worldId === snapshot.binding.worldId && row.actorId === snapshot.binding.actorId && row.storageSourceKey === snapshot.sourceKey), 'UNRESOLVED_DRAFT', '本人物还有未确认的正文，请先在年表中解决冲突、等待现场结果，或保留为个人草稿后再续写');
        const time = storyTime(snapshot.binding.day, snapshot.binding.clock);
        await this.acquireControl();
        let responses = [];
        const participants = snapshot.binding.participants?.length ? snapshot.binding.participants : sceneActors(world, snapshot.binding.actorId, time).filter((row) => row.ownerId && row.ownerId !== this.settings.playerId && row.exitMode !== 'background').map((row) => row.id);
        if (participants.length && input.trim()) {
            this.state.notice = '正在等待已找到的现场人物，最多一分钟…'; this.changed();
            const turn = this.service.stageTurn({ actorId: snapshot.binding.actorId, input, time, participantIds: participants, location: project(world, time.tick).actors[snapshot.binding.actorId]?.profile.location });
            const scene = await this.service.waitForScene(world.id, turn, { signal, intervalMs: this.settings.provider === 'github' ? 10_000 : 1000 });
            assert(this.matches(snapshot), 'CHAT_CHANGED', '等待期间聊天已切换，未继续旧场景');
            this.state.world = scene.world; responses = scene.responses;
            if (responses.length) {
                const actorIds = [...new Set([snapshot.binding.actorId, ...responses.map((row) => row.actorId)])].sort();
                const inputs = [...scene.responses, turn].map((row) => row.id).sort();
                this.preparedScene = { id: await hash(inputs), actorIds };
            }
            this.state.notice = scene.timedOut ? '等待结束，正文按对方允许的托管范围继续。' : '现场行动已到达，由本方正文继续判断和叙事。';
        }
        return narrativePrompt(this.state.world, snapshot.binding.actorId, time, responses, this.settings.memories[this.memoryKey]);
    }
    async captureNarration(narration, userInput, sourceKey, snapshot = this.snapshot()) {
        const draft = { id: uid(), worldId: snapshot.binding.worldId, actorId: snapshot.binding.actorId, bindingKey: snapshot.bindingKey, storageSourceKey: snapshot.sourceKey, scene: snapshot.scene ?? null, narration, userInput, sourceKey, time: storyTime(snapshot.binding.day, snapshot.binding.clock), createdAt: new Date().toISOString(), status: 'pending', error: '', proposal: null };
        this.settings.pending.push(draft); this.save(); this.changed();
        try {
            assert(this.matches(snapshot), 'CHAT_CHANGED', '聊天已切换，原正文保留在待处理记录');
            const world = await this.service.read(draft.worldId, snapshot.cardKey);
            const raw = await this.models.generate('extraction', extractionPrompt(world, draft.actorId, draft.time, userInput, narration));
            assert(this.matches(snapshot), 'CHAT_CHANGED', '提取期间聊天已切换，没有写入旧聊天');
            draft.rawModel = raw;
            const value = parseModelJson(raw);
            draft.proposal = normalizeRecord(value, world, draft, this.settings.playerId);
            draft.proposal.source = { key: sourceKey, hash: await hash(narration) };
            validateEvent(draft.proposal, validationWorld(world, draft.proposal));
            await this.publishDraft(draft.id);
            if (this.settings.autoSummary && this.state.world?.events.length >= 20 && this.state.world.events.length - (this.settings.memories[this.memoryKey]?.eventCount ?? 0) >= 20) {
                try { await this.summarize(); } catch (error) { this.state.notice += ' 长期摘要尚未更新：' + error.message; this.changed(); }
            }
        } catch (error) {
            draft.error = error.message; draft.status = 'conflict'; this.save(); this.changed();
        }
        return draft;
    }
    async publishDraft(id) {
        const draft = this.settings.pending.find((row) => row.id === id);
        assert(draft?.proposal, 'NO_PROPOSAL', '没有可上传的结构化事件，原正文仍然保留');
        assert(draft.bindingKey === this.state.bindingKey && draft.worldId === this.binding.worldId && draft.actorId === this.binding.actorId, 'CHAT_CHANGED', '请返回原聊天、世界和人物后再重试');
        assert(draft.storageSourceKey === this.sourceKey(), 'SOURCE_CHANGED', '数据来源已变化，请恢复原来源后再上传这段记录');
        const snapshot = this.snapshot();
        await this.acquireControl();
        const world = await this.service.transact(draft.worldId, { type: 'event.append', event: draft.proposal, sessionId: this.sessionId });
        const candidate = world.proposals?.find((row) => row.event.id === draft.id);
        if (candidate) {
            draft.status = candidate.status; draft.error = candidate.reason || '现场结果已保存，等待另一位玩家的正文；共同事实尚未改变';
            if (this.matches(snapshot)) this.state.world = world;
            clearTimeout(this.resultTimer);
            this.resultTimer = setTimeout(() => { if (this.matches(snapshot)) this.run(() => this.sync()); }, Math.max(1, candidate.expiresAt - Date.now() + 1));
            this.resultTimer?.unref?.();
            this.save(); this.changed(); return;
        }
        draft.status = 'shared'; draft.error = '';
        this.settings.pending = this.settings.pending.filter((row) => row.id !== id);
        this.settings.snapshots[draft.worldId] = { revision: world.revision, at: new Date().toISOString() };
        if (this.matches(snapshot)) {
            this.state.world = world;
            this.bind({ day: draft.proposal.time.day, clock: draft.proposal.time.clock });
            this.state.notice = '本轮经历已共享并读回确认；正文没有被修改。';
        }
        this.save(); this.changed();
    }
    async archiveDraft(id) {
        const draft = this.settings.pending.find((row) => row.id === id);
        assert(draft, 'NOT_FOUND', '待处理记录不存在');
        if (draft.proposal?.scene) await this.service.transact(draft.worldId, { type: 'proposal.withdraw', eventId: draft.id });
        this.settings.archivedDrafts.push({ ...copy(draft), status: 'personal' });
        this.settings.pending = this.settings.pending.filter((row) => row.id !== id);
        this.save(); this.state.notice = '已保留为个人草稿，不影响共同世界。'; this.changed();
    }
    async summarize() {
        assert(this.state.world && this.binding.actorId, 'NO_ACTOR', '请先选择人物');
        const snapshot = this.snapshot(), at = storyTime(this.binding.day, this.binding.clock), world = this.state.world;
        const result = await this.models.generate('summary', summaryPrompt(world, this.binding.actorId, at.tick));
        assert(this.matches(snapshot), 'CHAT_CHANGED', '摘要完成时聊天已切换，未写入错误人物');
        this.state.summary = result;
        this.settings.memories[this.memoryKey] = { text: result, tick: at.tick, eventCount: world.events.length, at: new Date().toISOString() }; this.save();
        this.changed();
    }
    get memoryKey() { return this.sourceKey() + ':' + this.binding.worldId + ':' + this.binding.actorId; }
    async acquireControl(takeover = false) {
        if (!this.binding.worldId || !this.binding.actorId) return;
        const current = this.state.world?.controls?.find((row) => row.playerId === this.settings.playerId);
        if (!takeover && current?.sessionId === this.sessionId && current.actorId === this.binding.actorId && current.expiresAt - Date.now() > 30_000) return this.state.world;
        const snapshot = this.snapshot();
        const world = await this.service.transact(this.binding.worldId, { type: 'control.acquire', actorId: this.binding.actorId, sessionId: this.sessionId, takeover });
        if (this.matches(snapshot)) this.state.world = world;
        return world;
    }
    async releaseControl() {
        if (this.binding.worldId && this.binding.actorId) await this.service.transact(this.binding.worldId, { type: 'control.release', actorId: this.binding.actorId, sessionId: this.sessionId });
    }
    async setEnabled(enabled) {
        if (enabled) { await this.acquireControl(); this.bind({ enabled: true }); }
        else { await this.releaseControl(); this.bind({ enabled: false }); }
    }
    async connect(write = true) {
        assert(this.settings.provider === 'github', 'LOCAL_ONLY', '请先保存 GitHub 数据来源设置');
        const result = await this.service.store.connectionTest({ write });
        this.settings.playerId = result.id; this.settings.githubAccount = { login: result.login, id: result.id };
        if (this.state.bindingKey && this.binding.actorId && !this.state.world?.actors.some((actor) => actor.id === this.binding.actorId && actor.ownerId === result.id)) this.bind({ enabled: false, actorId: '', participants: [] });
        this.configureStore(); this.save();
        this.state.notice = '已验证 ' + result.login + (result.writeVerified ? ' 的读写与读回。' : ' 的身份与仓库访问。') + (result.private ? '数据仓库为私有。' : '数据仓库为公开，记录会公开可见。');
        this.changed(); return result;
    }
    async acceptInvite(input) {
        const invite = parseInvite(input);
        if (invite.cardKey) assert(invite.cardKey === this.state.cardKey, 'CARD_MISMATCH', '邀请与当前卡或外置世界书版本不同，请先使用相同版本');
        if (invite.github) {
            this.saveSettings({ provider: 'github', github: invite.github });
            this.state.notice = '已应用邀请中的仓库地址；请使用你本人的凭据检查连接后加入。';
        }
        await this.joinWorld(invite.worldId);
    }
    invite() { assert(this.state.world, 'NO_WORLD', '请先加入世界'); return createInvite(this.state.world, this.settings); }
    async reextractDraft(id, narration) {
        const draft = this.settings.pending.find((row) => row.id === id);
        assert(draft && draft.worldId === this.binding.worldId && draft.actorId === this.binding.actorId && draft.storageSourceKey === this.sourceKey(), 'CHAT_CHANGED', '请返回这段草稿原来的数据来源与人物');
        if (narration !== undefined) draft.narration = textNarration(narration);
        draft.status = 'pending'; draft.error = ''; this.save(); this.changed();
        try {
            const snapshot = this.snapshot(), world = await this.service.read(draft.worldId, this.state.cardKey);
            const raw = await this.models.generate('extraction', extractionPrompt(world, draft.actorId, draft.time, draft.userInput, draft.narration));
            assert(this.matches(snapshot), 'CHAT_CHANGED', '提取期间聊天发生变化，草稿仍保留');
            draft.rawModel = raw; draft.proposal = normalizeRecord(parseModelJson(raw), world, draft, this.settings.playerId);
            draft.proposal.source = { key: draft.sourceKey, hash: await hash(draft.narration) };
            await this.publishDraft(id);
        } catch (error) { draft.status = 'conflict'; draft.error = error.message; this.save(); this.changed(); }
    }
    async importWorld(raw) {
        await this.service.authorize();
        assert(typeof raw === 'string' && raw.length < 30_000_000, 'IMPORT_LIMIT', '导入文件过大');
        let world; try { world = validateWorld(JSON.parse(raw)); } catch (error) { throw new Error('导入失败，原存档没有改动：' + error.message); }
        assert(world.cardKey === this.state.cardKey, 'CARD_MISMATCH', '导入文件与当前卡版本不同');
        const originalId = world.id; world = copy(world); world.id = uid(); world.revision = 0;
        world.restoredFrom = originalId; world.controls = []; world.turns = []; world.proposals = [];
        await this.service.store.write(world.id, world, null);
        await this.joinWorld(world.id);
        this.state.notice = '已恢复为独立副本，原世界和其他玩家的历史没有被覆盖。'; this.changed();
    }
    async exportIdentity() { return identityBackup(this.settings.playerId); }
    async importIdentity(raw) {
        assert(this.settings.provider === 'local', 'GITHUB_IDENTITY', 'GitHub 模式请通过本人的凭据恢复身份');
        this.settings.playerId = await readIdentity(raw); this.configureStore(); this.save();
        this.state.notice = '本机身份已恢复。请重新选择属于你的人物。'; this.changed();
    }
    exportWorld() {
        assert(this.state.world, 'NO_WORLD', '没有可导出的世界');
        return JSON.stringify(copy(this.state.world), null, 2);
    }
}
function textNarration(value) { assert(typeof value === 'string' && value.trim() && value.length < 100000, 'INVALID_DATA', '正文为空或过长'); return value; }
