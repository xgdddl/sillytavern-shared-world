import { sha256Bytes } from './sha256.js';
export const FORMAT = 'shared-world/1';
export const MAX_ACTORS = 3;
export const MAX_WAIT_MS = 60_000;
export const PROFILE_FIELDS = Object.freeze(['identity', 'background', 'personality', 'abilities', 'location', 'status', 'relationships']);
export const POLICY_FIELDS = Object.freeze(['conversation', 'movement', 'items', 'commitments', 'combat', 'romance', 'politics', 'death']);
export const POLICY_LABELS = Object.freeze({
    conversation: '日常交谈', movement: '移动', items: '物品消耗',
    commitments: '作出承诺', combat: '战斗', romance: '恋爱婚姻',
    politics: '重大政治行为', death: '死亡',
});

export class WorldError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'WorldError';
        this.code = code;
        this.details = details;
    }
}
export const copy = (value) => structuredClone(value);
export const uid = () => {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};
export function assert(condition, code, message, details) {
    if (!condition) throw new WorldError(code, message, details);
}
export function text(value, label, max = 8000, optional = false) {
    assert(typeof value === 'string', 'INVALID_DATA', label + '必须是文字');
    const clean = value.trim();
    assert((optional || clean.length > 0) && clean.length <= max, 'INVALID_DATA', label + '为空或过长');
    return clean;
}
export function object(value, label) {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_DATA', label + '必须是对象');
    return value;
}
export function array(value, label, max = 1000) {
    assert(Array.isArray(value) && value.length <= max, 'INVALID_DATA', label + '必须是有界数组');
    return value;
}
function keys(value, allowed, label) {
    for (const key of Object.keys(value)) assert(allowed.includes(key), 'INVALID_DATA', label + '包含未支持字段：' + key);
}
export function storyTime(day, clock) {
    const n = typeof day === 'string' && /^\d+$/.test(day) ? Number(day) : day;
    assert(Number.isSafeInteger(n) && n >= 0 && n < 1_000_000, 'INVALID_TIME', '请填写具体故事日，范围为 0～999999');
    assert(typeof clock === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(clock), 'INVALID_TIME', '故事时间必须为 HH:mm');
    return { day: n, clock, tick: n * 1440 + Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) };
}
export const timeLabel = (time) => '第 ' + time.day + ' 天 ' + time.clock;
export function policy(input = {}) {
    object(input, '托管范围');
    keys(input, POLICY_FIELDS, '托管范围');
    return Object.fromEntries(POLICY_FIELDS.map((key) => {
        assert(input[key] === undefined || typeof input[key] === 'boolean', 'INVALID_DATA', '托管开关必须为布尔值');
        return [key, input[key] ?? (key === 'conversation')];
    }));
}
export function profile(input = {}) {
    object(input, '人物模板');
    keys(input, PROFILE_FIELDS, '人物模板');
    return Object.fromEntries(PROFILE_FIELDS.map((key) => [key, text(input[key] ?? '', key, 6000, true)]));
}
export function makeActor({ id = uid(), name, ownerId = null, data = {}, delegation = {}, at = storyTime(0, '00:00') }) {
    const time = storyTime(at.day, at.clock);
    return {
        id: text(id, '人物编号', 100), name: text(name, '人物名字', 120),
        ownerId: ownerId === null ? null : text(ownerId, '控制者', 100),
        profile: profile(data), delegation: policy(delegation), createdTick: time.tick, exitMode: 'active',
    };
}
export function makeWorld({ id = uid(), name, cardKey, opening = '', origin = '故事第 0 天' }) {
    return {
        format: FORMAT, id: text(id, '世界编号', 100), name: text(name, '世界名称', 100),
        cardKey: text(cardKey, '角色卡版本标识', 200), opening: text(opening, '共同开场', 20_000, true),
        origin: text(origin, '时间起点', 200), revision: 0, actors: [], items: [], events: [], turns: [],
        createdAt: new Date().toISOString(),
    };
}
export function validateWorld(world) {
    object(world, '世界');
    assert(world.format === FORMAT, 'UNSUPPORTED_FORMAT', '世界格式不兼容，原数据已保留');
    text(world.id, '世界编号', 100); text(world.cardKey, '角色卡版本标识', 200); text(world.name, '世界名称', 100);
    assert(Number.isSafeInteger(world.revision) && world.revision >= 0, 'INVALID_DATA', '世界版本无效');
    array(world.actors, '人物', 500);
    const ids = new Set();
    for (const actor of world.actors) {
        object(actor, '人物'); text(actor.id, '人物编号', 100); text(actor.name, '人物名字', 120);
        assert(!ids.has(actor.id), 'INVALID_DATA', '人物编号重复'); ids.add(actor.id);
        assert(actor.ownerId === null || typeof actor.ownerId === 'string', 'INVALID_DATA', '控制者无效');
        assert(Number.isSafeInteger(actor.createdTick) && actor.createdTick >= 0, 'INVALID_DATA', '人物创建时间无效');
        profile(actor.profile); policy(actor.delegation);
    }
    const itemIds = new Set();
    for (const item of array(world.items, '物品', 2000)) {
        object(item, '物品'); text(item.id, '物品编号', 100); text(item.name, '物品名称', 200);
        assert(!itemIds.has(item.id), 'INVALID_DATA', '物品编号重复'); itemIds.add(item.id);
        assert(item.ownerId === null || ids.has(item.ownerId), 'INVALID_DATA', '物品归属人物不存在');
        assert(Number.isSafeInteger(item.createdTick) && item.createdTick >= 0, 'INVALID_DATA', '物品时间无效');
    }
    const eventIds = new Set();
    for (const event of array(world.events, '历史事件', 10_000)) {
        assert(!eventIds.has(event.id), 'INVALID_DATA', '事件编号重复'); eventIds.add(event.id);
        validateEvent(event, world);
    }
    for (const turn of array(world.turns ?? [], '场景行动', 200)) {
        object(turn, '场景行动'); text(turn.id, '行动编号', 100);
        assert(world.actors.some((actor) => actor.id === turn.actorId && actor.ownerId === turn.authorId), 'OWNERSHIP', '场景行动的控制者无效');
        storyTime(turn.time?.day, turn.time?.clock);
        text(turn.input, '场景行动内容', 12000);
        array(turn.participantIds, '场景参与者', 100);
        assert(Number.isFinite(turn.createdAt) && Number.isFinite(turn.expiresAt), 'INVALID_DATA', '场景等待期限无效');
    }
    return world;
}
export function validateEvent(event, world) {
    object(event, '事件');
    text(event.id, '事件编号', 100); text(event.authorId, '作者编号', 100);
    text(event.actorId, '人物编号', 100); text(event.summary, '本轮经历', 8000);
    const time = storyTime(event.time?.day, event.time?.clock);
    assert(event.time.tick === time.tick, 'INVALID_TIME', '故事时间与内部顺序不一致');
    assert(world.actors.some((actor) => actor.id === event.actorId && actor.ownerId === event.authorId), 'OWNERSHIP', '此事件的作者没有该人物的控制权');
    assert(['public', 'participants'].includes(event.visibility), 'INVALID_DATA', '事件可见范围无效');
    text(event.location ?? '', '地点', 1000, true);
    for (const id of array(event.participantIds, '参与人物', 100)) assert(world.actors.some((actor) => actor.id === id), 'INVALID_DATA', '参与人物不存在：' + id);
    for (const id of array(event.knownBy, '知情人物', 100)) assert(world.actors.some((actor) => actor.id === id), 'INVALID_DATA', '知情人物不存在');
    for (const change of array(event.changes, '人物变化', 100)) {
        keys(object(change, '人物变化'), ['actorId', 'field', 'value', 'category'], '人物变化');
        assert(world.actors.some((actor) => actor.id === change.actorId), 'INVALID_DATA', '变化涉及未知人物');
        assert(PROFILE_FIELDS.includes(change.field), 'INVALID_DATA', '只能使用固定的人物字段');
        assert(POLICY_FIELDS.includes(change.category), 'INVALID_DATA', '变化类型无效');
        text(change.value, '人物变化内容', 6000, true);
    }
    for (const move of array(event.itemMoves, '物品转移', 100)) {
        keys(object(move, '物品转移'), ['itemId', 'fromActorId', 'toActorId'], '物品转移');
        assert(world.items.some((item) => item.id === move.itemId), 'INVALID_DATA', '物品不存在');
        for (const id of [move.fromActorId, move.toActorId]) assert(id === null || world.actors.some((actor) => actor.id === id), 'INVALID_DATA', '物品转移人物不存在');
        assert(move.fromActorId !== move.toActorId, 'INVALID_DATA', '物品转移的双方相同');
    }
    if (event.source) {
        object(event.source, '正文来源'); text(event.source.key, '正文来源标识', 300); text(event.source.hash, '正文摘要标识', 100);
    }
    return event;
}
export function project(world, tick = Infinity) {
    const actors = Object.fromEntries(world.actors.filter((actor) => actor.createdTick <= tick).map((actor) => [actor.id, copy(actor)]));
    const items = Object.fromEntries(world.items.filter((item) => item.createdTick <= tick).map((item) => [item.id, copy(item)]));
    const events = [...world.events].filter((event) => event.time.tick <= tick).sort((a, b) => a.time.tick - b.time.tick || a.id.localeCompare(b.id));
    for (const event of events) {
        for (const change of event.changes) if (actors[change.actorId]) actors[change.actorId].profile[change.field] = change.value;
        for (const move of event.itemMoves) if (items[move.itemId]) items[move.itemId].ownerId = move.toActorId;
    }
    return { actors, items, events };
}
function ensureTimeline(world) {
    const held = new Map(world.items.map((item) => [item.id, item.ownerId]));
    for (const event of [...world.events].sort((a, b) => a.time.tick - b.time.tick || a.id.localeCompare(b.id))) {
        for (const move of event.itemMoves) {
            const item = world.items.find((row) => row.id === move.itemId);
            assert(item.createdTick <= event.time.tick, 'HISTORY_CONFLICT', '物品尚未出现，不能在更早时间转移');
            assert(held.get(move.itemId) === move.fromActorId, 'HISTORY_CONFLICT', '物品归属与既有历史冲突；没有覆盖已确认记录', { itemId: move.itemId, eventId: event.id });
            held.set(move.itemId, move.toActorId);
        }
    }
}
export function applyOperation(input, operation) {
    validateWorld(input);
    const world = copy(input);
    const owned = world.actors.filter((actor) => actor.ownerId === operation.playerId);
    if (operation.type === 'actor.create') {
        const actor = copy(object(operation.actor, '人物'));
        keys(actor, ['id', 'name', 'ownerId', 'profile', 'delegation', 'createdTick', 'exitMode'], '人物');
        assert(!world.actors.some((row) => row.id === actor.id || row.name === actor.name), 'ACTOR_EXISTS', '人物已存在，请接手尚未归属他人的角色');
        assert(actor.ownerId === null || actor.ownerId === operation.playerId, 'OWNERSHIP', '不能替别人绑定角色');
        assert(actor.ownerId === null || owned.length < MAX_ACTORS, 'ACTOR_LIMIT', '每位玩家最多拥有 3 个人物');
        world.actors.push(actor);
    } else if (operation.type === 'actor.claim') {
        const actor = world.actors.find((row) => row.id === operation.actorId);
        assert(actor, 'NOT_FOUND', '人物不存在');
        if (actor.ownerId === operation.playerId) return world;
        assert(actor.ownerId === null, 'OWNERSHIP', '此人物已经归属其他玩家，不能接手');
        assert(owned.length < MAX_ACTORS, 'ACTOR_LIMIT', '每位玩家最多拥有 3 个人物');
        actor.ownerId = operation.playerId;
    } else if (operation.type === 'actor.policy' || operation.type === 'actor.exit') {
        const actor = world.actors.find((row) => row.id === operation.actorId);
        assert(actor?.ownerId === operation.playerId, 'OWNERSHIP', '只能设置自己的人物');
        if (operation.type === 'actor.policy') actor.delegation = policy(operation.delegation);
        else {
            assert(['active', 'delegated', 'background'].includes(operation.mode), 'INVALID_DATA', '离场方式无效');
            actor.exitMode = operation.mode;
        }
    } else if (operation.type === 'item.create') {
        const item = copy(object(operation.item, '物品'));
        keys(item, ['id', 'name', 'description', 'ownerId', 'createdTick'], '物品');
        text(item.id, '物品编号', 100); text(item.name, '物品名', 200); text(item.description ?? '', '物品描述', 2000, true);
        assert(!world.items.some((row) => row.id === item.id), 'ITEM_EXISTS', '物品编号重复');
        assert(world.actors.some((actor) => actor.id === item.ownerId && actor.ownerId === operation.playerId), 'OWNERSHIP', '只能为自己人物登记开局物品');
        world.items.push(item);
    } else if (operation.type === 'turn.stage') {
        const turn = copy(operation.turn);
        assert(turn.authorId === operation.playerId, 'OWNERSHIP', '不能代传其他玩家的输入');
        assert(world.actors.some((actor) => actor.id === turn.actorId && actor.ownerId === operation.playerId), 'OWNERSHIP', '不是该人物的控制者');
        world.turns = (world.turns ?? []).filter((row) => row.actorId !== turn.actorId && row.expiresAt > Date.now());
        world.turns.push(turn);
    } else if (operation.type === 'event.append') {
        const event = copy(operation.event);
        validateEvent(event, world);
        assert(event.authorId === operation.playerId, 'OWNERSHIP', '不能代替其他玩家提交');
        if (world.events.some((row) => row.id === event.id)) return world;
        if (event.source && world.events.some((row) => row.source?.key === event.source.key)) {
            const existing = world.events.find((row) => row.source?.key === event.source.key);
            assert(existing.source.hash === event.source.hash, 'PUBLISHED_SOURCE', '这条正文已经共享；重生成可以改描写，不能覆盖共同事实');
            return world;
        }
        for (const change of event.changes) {
            const target = world.actors.find((row) => row.id === change.actorId);
            assert(target.createdTick <= event.time.tick, 'HISTORY_CONFLICT', '人物尚未出现在这段历史');
            assert(target.ownerId === null || target.ownerId === operation.playerId || target.delegation[change.category], 'DELEGATION_LIMIT', '超出“' + target.name + '”允许的托管范围：' + POLICY_LABELS[change.category]);
            const conflict = world.events.find((row) => row.time.tick === event.time.tick && row.changes.some((prior) => prior.actorId === change.actorId && prior.field === change.field && prior.value !== change.value));
            assert(!conflict, 'HISTORY_CONFLICT', '同一时间的人物状态已有不同记录，请修改本方结果或保留个人草稿', { eventId: conflict?.id });
        }
        for (const move of event.itemMoves) {
            const from = world.actors.find((row) => row.id === move.fromActorId);
            assert(!from || from.ownerId === null || from.ownerId === operation.playerId || from.delegation.items, 'DELEGATION_LIMIT', '没有获准使用其他玩家的物品');
        }
        world.events.push(event);
        ensureTimeline(world);
    } else throw new WorldError('UNKNOWN_OPERATION', '未支持的操作');
    validateWorld(world);
    return world;
}
export function contextFor(world, actorId, time) {
    const view = project(world, time.tick);
    const actor = view.actors[actorId];
    assert(actor, 'INVALID_TIME', '这个人物尚未出现在所选故事时间');
    const observable = view.events.filter((event) => event.participantIds.includes(actorId) || event.knownBy.includes(actorId) || (event.visibility === 'public' && event.location && event.location === actor.profile.location));
    const anchors = world.events.filter((event) => event.time.tick > time.tick && event.participantIds.includes(actorId)).sort((a, b) => a.time.tick - b.time.tick).slice(0, 8);
    return { actor, actors: Object.values(view.actors), items: Object.values(view.items), observable: observable.slice(-20), anchors };
}
function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
    return value;
}
export async function hash(value) {
    const data = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(sorted(value)));
    if (!globalThis.crypto.subtle) return sha256Bytes(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}
export async function cardFingerprint(card) {
    const data = card?.data ?? card ?? {};
    return hash(Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'character_book'].map((key) => [key, data[key] ?? null])));
}
