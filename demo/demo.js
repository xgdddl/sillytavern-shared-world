import { WorldController } from '../src/controller.js';
import { WorldPanel } from '../src/panel.js';
import { makeActor, storyTime, uid } from '../src/domain.js';
import { WorldService } from '../src/service.js';
import { narrativePrompt } from '../src/prompts.js';

const demoCard = { avatar: 'shared-world-demo', data: { name: '雾港来信', description: '海港与王城之间，一群旅人逐渐改写这个世界。', scenario: '共同创作的架空故事。' } };
const controller = new WorldController({ demoCard });
const panel = new WorldPanel(controller, { container: document.getElementById('demo-panel'), standalone: true });
await controller.refreshContext();
if (!controller.binding.worldId) {
    await controller.createWorld({ name: '雾港 · 共同历史', opening: '潮水退去，港口的钟声越过旧街。你的故事，从一封没有署名的来信开始。', origin: '雾港历 · 故事第 0 天' });
    await controller.createActor({ name: '林岚', identity: '旅人', background: '带着一封旧信来到雾港。', personality: '谨慎，重视承诺。', abilities: '熟悉航海与谈判。', location: '雾港', status: '安好', relationships: '认识商人许舟。' });
    const worldId = controller.binding.worldId, actorId = controller.binding.actorId;
    const peer = makeActor({ name: '许舟', ownerId: 'demo-player-b', data: { identity: '商人', location: '雾港', personality: '精于盘算，但守信用。' } });
    const peerService = new WorldService(controller.service.store, 'demo-player-b');
    controller.state.world = await peerService.transact(worldId, { type: 'actor.create', actor: peer });
    const event = (actor, authorId, day, clock, summary, location, changes = []) => ({
        id: uid(), actorId: actor, authorId, time: storyTime(day, clock), summary, location,
        visibility: 'public', participantIds: [actor], knownBy: [actor], changes, itemMoves: [], createdAt: new Date().toISOString(),
    });
    controller.state.world = await controller.service.transact(worldId, { type: 'event.append', event: event(actorId, controller.settings.playerId, 0, '08:00', '林岚抵达雾港，在旧街见到商人许舟，得知王城正在召集使者。', '雾港') });
    controller.state.world = await controller.service.transact(worldId, { type: 'event.append', event: event(actorId, controller.settings.playerId, 20, '09:00', '经历二十天的风波后，林岚在王城登基。这个身份会在他离线后继续存在。', '王城', [
        { actorId, field: 'identity', value: '王城的帝王', category: 'politics' },
        { actorId, field: 'location', value: '王城', category: 'movement' },
    ]) });
    controller.state.world = await peerService.transact(worldId, { type: 'event.append', event: event(peer.id, 'demo-player-b', 20, '10:00', '许舟在王城市场买菜，听见人们谈论新帝王的登基仪式。', '王城', [{ actorId: peer.id, field: 'location', value: '王城', category: 'movement' }]) });
    controller.bind({ day: 3, clock: '08:00', enabled: false });
    controller.state.notice = '这是一组演示记录：你正在第 3 天，年表已经保存第 20 天的共同历史。';
}
await controller.sync(); await controller.listWorlds();
document.getElementById('demo-add').addEventListener('click', () => controller.run(async () => {
    const time = storyTime(controller.binding.day, controller.binding.clock);
    const event = {
        id: uid(), actorId: controller.binding.actorId, authorId: controller.settings.playerId, time,
        summary: '【演示事件】林岚在雾港码头读完旧信，决定继续调查寄信人的身份。',
        location: '雾港', visibility: 'public', participantIds: [controller.binding.actorId], knownBy: [controller.binding.actorId], changes: [], itemMoves: [], createdAt: new Date().toISOString(),
    };
    controller.state.world = await controller.service.transact(controller.binding.worldId, { type: 'event.append', event });
    controller.state.notice = '已追加一条本机演示事件，没有调用模型或远程存储。'; controller.changed();
}));
document.getElementById('demo-prompt').addEventListener('click', () => {
    const target = document.getElementById('prompt-preview');
    target.textContent = narrativePrompt(controller.state.world, controller.binding.actorId, storyTime(controller.binding.day, controller.binding.clock));
    target.style.display = target.style.display === 'block' ? 'none' : 'block';
});
globalThis.sharedWorldDemo = { controller, panel };
