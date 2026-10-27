import { MAX_WAIT_MS, WorldError, applyOperation, assert, copy, makeWorld, storyTime, uid, validateWorld } from './domain.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
});
export class WorldService {
    constructor(store, playerId) { this.store = store; this.playerId = playerId; }
    async create(input) {
        const world = makeWorld(input);
        assert(!(await this.store.read(world.id)), 'WORLD_EXISTS', '这个世界编号已经存在');
        await this.store.write(world.id, world, null);
        const result = await this.store.read(world.id);
        assert(result?.world.id === world.id, 'READBACK', '写入后没有读回世界记录');
        return result.world;
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
                const saved = await this.store.read(id, { signal });
                assert(saved && saved.world.revision >= next.revision, 'READBACK', '上传后未确认持久化结果，保留待处理状态');
                if (op.type === 'event.append') assert(saved.world.events.some((event) => event.id === op.event.id || (op.event.source && event.source?.key === op.event.source.key && event.source.hash === op.event.source.hash)), 'READBACK', '上传事件未读回');
                return saved.world;
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
        const collect = () => (world.turns ?? []).filter((row) => wanted.includes(row.actorId) && row.expiresAt > Date.now() && row.time.tick === turn.time.tick && row.participantIds.includes(turn.actorId));
        try {
            while (wanted.length && Date.now() < deadline) {
                const responses = collect();
                if (wanted.every((actorId) => responses.some((row) => row.actorId === actorId))) return { world, responses, timedOut: false };
                await sleep(Math.min(intervalMs, deadline - Date.now()), bounded);
                if (Date.now() >= deadline) break;
                world = await this.read(id, undefined, { signal: bounded });
            }
        } catch (error) {
            if (signal?.aborted || !timeout.aborted) throw error;
        }
        return { world, responses: collect(), timedOut: wanted.length > collect().length };
    }
    stageTurn({ actorId, input, time, participantIds }) {
        return { id: uid(), actorId, authorId: this.playerId, input, time: storyTime(time.day, time.clock), participantIds: [...new Set([actorId, ...participantIds])], createdAt: Date.now(), expiresAt: Date.now() + MAX_WAIT_MS };
    }
}
