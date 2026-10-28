import { assert, copy, makeActor, profile, project, storyTime, text, uid } from './domain.js';

const names = (row) => [row.id, row.name, ...(row.aliases ?? [])].filter(Boolean).map((value) => value.normalize('NFKC').trim());
function find(rows, reference, label) {
    if (reference === null) return null;
    const matches = rows.filter((row) => names(row).includes(String(reference).normalize('NFKC').trim()));
    assert(matches.length === 1, 'ENTITY_REFERENCE', label + '无法唯一对应：' + reference + '；请重新提取或使用编号');
    return matches[0].id;
}
function evidence(value, narration, label) {
    const quote = text(value, label + '的正文依据', 2000);
    assert(narration.includes(quote), 'MISSING_EVIDENCE', label + '的依据不在原正文中，未写入共同历史');
    return quote;
}
export function normalizeRecord(value, world, draft, authorId) {
    const at = storyTime(value.time?.day, value.time?.clock);
    const pending = (world.proposals ?? []).filter((row) => draft.scene && row.event.scene.id === draft.scene.id);
    const actors = copy([...new Map([...world.actors, ...pending.flatMap((row) => row.event.newActors ?? [])].map((row) => [row.id, row])).values()]), items = copy([...new Map([...world.items, ...pending.flatMap((row) => row.event.newItems ?? [])].map((row) => [row.id, row])).values()]), refs = new Map();
    const newActors = [], newItems = [];
    for (const row of value.newActors ?? []) {
        evidence(row.evidence, draft.narration, '新人物');
        const matched = row.existingActorId ? find(actors, row.existingActorId, '已有角色') : actors.filter((actor) => names(actor).includes(String(row.name).normalize('NFKC').trim())).map((actor) => actor.id)[0];
        let id = matched;
        if (!id) {
            const actor = makeActor({ name: row.name, data: profile(row.profile ?? {}), at });
            actor.aliases = [...new Set((row.aliases ?? []).map((alias) => text(alias, '人物别名', 120)))].slice(0, 30);
            actors.push(actor); newActors.push(actor); id = actor.id;
        }
        if (row.ref) refs.set(row.ref, id);
    }
    const actorId = (ref) => find(actors, refs.get(ref) ?? ref, '人物');
    for (const row of value.newItems ?? []) {
        evidence(row.evidence, draft.narration, '新物品');
        let id = row.existingItemId ? find(items, row.existingItemId, '已有物品') : null;
        if (!id) {
            const item = { id: uid(), name: text(row.name, '物品名', 200), description: text(row.description ?? '', '物品描述', 4000, true), ownerId: row.ownerId === null ? null : actorId(row.ownerId), createdTick: at.tick, quantity: row.quantity ?? 1, status: row.status ?? '可用', aliases: (row.aliases ?? []).slice(0, 30) };
            assert(Number.isFinite(item.quantity) && item.quantity >= 0, 'INVALID_DATA', '新物品数量无效');
            items.push(item); newItems.push(item); id = item.id;
        }
        if (row.ref) refs.set(row.ref, id);
    }
    const itemId = (ref) => find(items, refs.get(ref) ?? ref, '物品');
    const changes = (value.changes ?? []).map((row) => ({ actorId: actorId(row.actorId), field: row.field, value: text(row.value, '人物变化', 6000, true), category: row.category }));
    const facts = (value.facts ?? []).map((row) => {
        const quote = evidence(row.evidence, draft.narration, '共同事实');
        const fact = { key: text(row.key, '事实标识', 200).normalize('NFKC').trim().toLowerCase(), label: row.label, value: refs.get(row.value) ?? row.value, scope: row.scope ?? 'world', location: row.location ?? value.location ?? '', exclusive: row.exclusive === true, evidence: quote };
        if (fact.exclusive) fact.previous = row.previous ?? null;
        return fact;
    });
    const result = {
        id: draft.id, authorId, actorId: draft.actorId, time: at, summary: value.summary,
        location: value.location ?? '', visibility: value.visibility ?? 'participants', scope: value.scope ?? 'personal',
        participantIds: [...new Set([draft.actorId, ...(value.participantIds ?? []).map(actorId)])],
        knownBy: [...new Set([draft.actorId, ...(value.knownBy ?? []).map(actorId)])], changes,
        itemMoves: (value.itemMoves ?? []).map((row) => ({ itemId: itemId(row.itemId), fromActorId: row.fromActorId === null ? null : actorId(row.fromActorId), toActorId: row.toActorId === null ? null : actorId(row.toActorId) })),
        itemChanges: (value.itemChanges ?? []).map((row) => ({ itemId: itemId(row.itemId), field: row.field, value: row.value })),
        facts, newActors, newItems, createdAt: draft.createdAt,
    };
    if (draft.scene) {
        const states = {};
        const view = project(world, at.tick);
        for (const id of draft.scene.actorIds) {
            const current = view.actors[id];
            assert(current, 'INVALID_SCENE', '共同场景人物在这个时间尚未出现');
            states[id] = Object.fromEntries(['identity', 'location', 'status'].map((field) => [field, changes.filter((change) => change.actorId === id && change.field === field).at(-1)?.value ?? current.profile[field]]));
        }
        result.scene = { ...copy(draft.scene), states };
    }
    return result;
}
export function validationWorld(world, record) {
    return { ...world, actors: [...world.actors, ...(record.newActors ?? [])], items: [...world.items, ...(record.newItems ?? [])] };
}
export function sceneActors(world, actorId, at) {
    const view = project(world, at.tick), actor = view.actors[actorId];
    const encountered = new Set(view.events.filter((event) => event.participantIds.includes(actorId)).flatMap((event) => event.participantIds));
    return Object.values(view.actors).filter((other) => other.id !== actorId && encountered.has(other.id) && actor?.profile.location && other.profile.location === actor.profile.location);
}
