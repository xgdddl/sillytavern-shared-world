import { MAX_WAIT_MS, WorldError, applyOperation, assert, copy, makeWorld, storyTime, uid, validateWorld } from './domain.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
});
export class WorldService {
    constructor(store, playerId) { this.store = store; this.playerId = playerId; }
    async readback(id, accepts, { signal, deadline = Date.now() + MAX_WAIT_MS } = {}) {
        for (let attempt = 0; attempt < 5; attempt++) {
            signal?.throwIfAborted();
            const result = await this.store.read(id, { signal });
            if (result && accepts(result.world)) return result.world;
            if (attempt === 4 || Date.now() >= deadline) break;
            await sleep(Math.min(150 * 2 ** attempt, Math.max(0, deadline - Date.now())), signal);
        }
        throw new WorldError('READBACK', '上传后尚未读回确认，请稍后读取世界“' + id + '”；原正文保留，不要重复创建', { worldId: id });
    }
    async create(input) {
        await this.authorize();
        const world = makeWorld(input);
        const deadline = Date.now() + MAX_WAIT_MS, signal = AbortSignal.timeout(MAX_WAIT_MS);
        assert(!(await this.store.read(world.id, { signal })), 'WORLD_EXISTS', '这个世界编号已经存在');
        await this.store.write(world.id, world, null, { signal });
        return this.readback(world.id, (saved) => saved.id === world.id, { signal, deadline });
    }
    async read(id, cardKey, options = {}) {
        const result = await this.store.read(id, options);
        assert(result, 'NOT_FOUND', '没有找到这个世界，请核对数据来源和世界编号');
        validateWorld(result.world);
        if (cardKey) assert(result.world.cardKey === cardKey, 'CARD_MISMATCH', '这不是当前角色卡版本的世界；不同版本不能混入同一历史');
        return result.world;
    }
    async list(cardKey) {
        return (await this.store.list()).map(validateWorld).filter((world) => !cardKey || world.cardKey === cardKey);
    }
    async transact(id, operation, { signal, deadline = Date.now() + MAX_WAIT_MS } = {}) {
        await this.authorize();
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(MAX_WAIT_MS, deadline - Date.now())));
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const op = { ...copy(operation), playerId: this.playerId };
        for (let attempt = 0; attempt < 8; attempt++) {
            signal?.throwIfAborted();
            assert(Date.now() < deadline, 'SYNC_TIMEOUT', '同步等待已达到一分钟，内容保留为待处理记录');
            const current = await this.store.read(id, { signal });
            assert(current, 'NOT_FOUND', '共同世界不存在');
            const next = applyOperation(current.world, op);
            if (JSON.stringify(next) === JSON.stringify(current.world)) return current.world;
            next.revision = current.world.revision + 1;
            try {
                await this.store.write(id, next, current.token, { signal });
                return await this.readback(id, (saved) => saved.revision >= next.revision && (op.type !== 'event.append' || saved.events.some((event) => event.id === op.event.id || (op.event.source && event.source?.key === op.event.source.key && event.source.hash === op.event.source.hash)) || saved.proposals?.some((row) => row.event.id === op.event.id)), { signal, deadline });
            } catch (error) {
                if (error.code !== 'STORAGE_CONFLICT' || attempt === 7) throw error;
                const wait = Math.min(80 * 2 ** attempt, 1500, Math.max(0, deadline - Date.now()));
                await sleep(wait, signal);
            }
        }
        throw new WorldError('SYNC_TIMEOUT', '世界暂时繁忙，内容已保留');
    }
    async waitForScene(id, turn, { signal, intervalMs = 2000 } = {}) {
        const deadline = Math.min(turn.expiresAt, Date.now() + MAX_WAIT_MS);
        const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let world = await this.transact(id, { type: 'turn.stage', turn }, { signal: bounded, deadline });
        const wanted = turn.participantIds.filter((actorId) => actorId !== turn.actorId && world.actors.some((actor) => actor.id === actorId && actor.ownerId && actor.ownerId !== this.playerId));
        const collect = () => (world.turns ?? []).filter((row) => wanted.includes(row.actorId) && row.expiresAt > Date.now() && Math.abs(row.time.tick - turn.time.tick) <= 10 && (!row.location || !turn.location || row.location === turn.location) && row.participantIds.includes(turn.actorId) && (!row.observedBy?.[turn.actorId] || row.observedBy[turn.actorId] === turn.id));
        const confirmed = () => collect().filter((row) => row.observedBy?.[turn.actorId] === turn.id);
        try {
            while (wanted.length && Date.now() < deadline) {
                const pending = collect().filter((row) => row.observedBy?.[turn.actorId] !== turn.id);
                if (pending.length) {
                    try {
                        world = await this.transact(id, { type: 'turn.observe', turnId: turn.id, targetIds: pending.map((row) => row.id) }, { signal: bounded, deadline });
                    } catch (error) {
                        if (!['TURN_USED', 'TURN_CHANGED'].includes(error.code)) throw error;
                        world = await this.read(id, undefined, { signal: bounded });
                    }
                }
                const responses = confirmed();
                if (wanted.every((actorId) => responses.some((row) => row.actorId === actorId))) return { world, responses, timedOut: false };
                await sleep(Math.min(intervalMs, deadline - Date.now()), bounded);
                if (Date.now() >= deadline) break;
                world = await this.read(id, undefined, { signal: bounded });
            }
        } catch (error) {
            if (signal?.aborted || !timeout.aborted) throw error;
        }
        return { world, responses: confirmed(), timedOut: wanted.length > confirmed().length };
    }
    stageTurn({ actorId, input, time, participantIds, location = '' }) {
        return { id: uid(), actorId, authorId: this.playerId, input, location, time: storyTime(time.day, time.clock), participantIds: [...new Set([actorId, ...participantIds])], createdAt: Date.now(), expiresAt: Date.now() + MAX_WAIT_MS };
    }
    async authorize() {
        if (this.store.authenticate) assert((await this.store.authenticate()).id === this.playerId, 'ACCOUNT_MISMATCH', '请先在设置中检查连接，让人物归属绑定到你本人已验证的 GitHub 账号');
    }
}
