import { applyOperation, makeActor, makeWorld, storyTime } from '../src/domain.js';
export function fixture() {
    let world = makeWorld({ id: 'world-one', name: '共同世界', cardKey: 'card-v1' });
    const a = makeActor({ id: 'a', name: '甲', ownerId: 'pa', data: { identity: '旅人', location: '王城' } });
    const b = makeActor({ id: 'b', name: '乙', ownerId: 'pb', data: { identity: '商人', location: '王城', background: '不该自动泄露的秘密' } });
    world = applyOperation(world, { type: 'actor.create', playerId: 'pa', actor: a });
    world = applyOperation(world, { type: 'actor.create', playerId: 'pb', actor: b });
    return world;
}
export function event({ id = 'event-one', actorId = 'a', authorId = 'pa', day = 0, clock = '08:00', changes = [], itemMoves = [], summary = '一段真实经历', visibility = 'public', knownBy = [actorId], participantIds = [actorId], source } = {}) {
    return { id, actorId, authorId, summary, time: storyTime(day, clock), location: '王城', changes, itemMoves, visibility, knownBy, participantIds, ...(source ? { source } : {}) };
}
