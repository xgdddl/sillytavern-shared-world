import { POLICY_FIELDS, POLICY_LABELS, PROFILE_FIELDS, project, storyTime, timeLabel } from './domain.js';

const h = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (label, name, value = '', options = {}) => '<label class="sw-field"><span>' + label + '</span>' + (options.area
    ? '<textarea name="' + name + '" rows="' + (options.rows ?? 3) + '" ' + (options.required ? 'required' : '') + '>' + h(value) + '</textarea>'
    : '<input name="' + name + '" type="' + (options.type ?? 'text') + '" value="' + h(value) + '" ' + (options.required ? 'required' : '') + ' ' + (options.extra ?? '') + '>') + '</label>';
const button = (label, action, value = '', className = '') => '<button type="button" class="sw-button ' + className + '" data-action="' + action + '" data-value="' + h(value) + '">' + label + '</button>';
const labels = { identity: '身份', background: '背景与经历', personality: '性格', abilities: '能力描述', location: '所在地', status: '状态', relationships: '人物关系' };
export class WorldPanel {
    constructor(controller, { container, standalone = false } = {}) {
        this.controller = controller; this.tab = 'world'; this.standalone = standalone; this.inputCache = new Map();
        if (container) this.root = container;
        else {
            this.dialog = document.createElement('dialog'); this.dialog.id = 'shared-world-dialog';
            this.root = document.createElement('section'); this.dialog.append(this.root); document.body.append(this.dialog);
            this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.close(); });
        }
        this.root.id = 'sw-panel';
        this.root.addEventListener('click', (event) => this.click(event));
        this.root.addEventListener('submit', (event) => this.submit(event));
        this.root.addEventListener('input', (event) => {
            const form = event.target.closest('form');
            if (form) this.inputCache.set(form.id, Array.from(form.elements).filter((el) => el.name && el.type !== 'password').map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.multiple ? Array.from(el.selectedOptions, (option) => option.value) : el.value]));
        });
        controller.addEventListener('change', () => this.render());
        this.render();
    }
    open() { if (this.dialog && !this.dialog.open) this.dialog.showModal(); this.render(); }
    close() { this.dialog?.close(); }
    render() {
        const c = this.controller, s = c.state, b = c.binding;
        const focus = this.root.contains(document.activeElement) ? { name: document.activeElement.name, start: document.activeElement.selectionStart } : null;
        const scroll = this.root.querySelector('.sw-main')?.scrollTop ?? 0;
        const expanded = Array.from(this.root.querySelectorAll('details[open]')).map((el) => el.querySelector('form')?.id ?? el.querySelector('summary')?.textContent);
        const content = this.tab === 'world' ? this.world() : this.tab === 'actors' ? this.actors() : this.tab === 'history' ? this.history() : this.settings();
        this.root.innerHTML = [
            '<header class="sw-header"><div class="sw-brand"><span class="sw-seal" aria-hidden="true">叙</span><div><div class="sw-eyebrow">SHARED WORLD · 0.1.1</div><h1>共叙<span>联机世界书</span></h1></div></div>',
            '<div class="sw-header-right"><span class="sw-status"><i class="' + (b.enabled ? 'is-active' : '') + '"></i>' + (b.enabled ? '当前聊天已开启' : '当前聊天未开启') + '</span>' + (this.standalone ? '' : button('关闭', 'close', '', 'sw-quiet')) + '</div></header>',
            '<nav class="sw-tabs" aria-label="世界书导航">' + [['world', '世界'], ['actors', '人物'], ['history', '年表'], ['settings', '设置']].map(([id, label], index) => '<button type="button" data-tab="' + id + '" aria-current="' + (id === this.tab ? 'page' : 'false') + '"><span>0' + (index + 1) + '</span>' + label + (id === 'history' && c.settings.pending.length ? '<b>' + c.settings.pending.length + '</b>' : '') + '</button>').join('') + '</nav>',
            '<main class="sw-main" aria-busy="' + s.busy + '">' + (s.error ? '<div class="sw-message sw-error" role="alert">' + h(s.error) + '</div>' : '') + (s.notice ? '<div class="sw-message" role="status">' + h(s.notice) + '</div>' : '') + content + '</main>',
            '<footer class="sw-footer"><span>' + (c.settings.provider === 'local' ? '本机演示 · 不会同步到其他设备' : h(c.service.store.label)) + '</span><span>' + (s.busy ? '正在处理…' : s.lastSync ? '上次读取 ' + h(s.lastSync) : '最多等待 60 秒') + '</span></footer>',
        ].join('');
        for (const [formId, entries] of this.inputCache) {
            const form = this.root.querySelector('#' + formId);
            if (!form) continue;
            for (const [name, value] of entries) {
                const el = form.elements.namedItem(name); if (!el) continue;
                if (el.type === 'checkbox') el.checked = value;
                else if (el.multiple) for (const option of el.options) option.selected = value.includes(option.value);
                else el.value = value;
            }
        }
        for (const el of this.root.querySelectorAll('details')) {
            if (expanded.includes(el.querySelector('form')?.id ?? el.querySelector('summary')?.textContent)) el.open = true;
        }
        if (focus?.name) {
            const input = Array.from(this.root.querySelectorAll('[name]')).find((el) => el.name === focus.name);
            input?.focus({ preventScroll: true });
            try { input?.setSelectionRange(focus.start, focus.start); } catch { /* select/time inputs have no selection range */ }
        }
        const main = this.root.querySelector('.sw-main'); if (main) main.scrollTop = scroll;
    }
    world() {
        const c = this.controller, s = c.state, w = s.world, b = c.binding;
        return [
            '<section class="sw-intro"><div><div class="sw-eyebrow">一个世界，许多人的经历</div><h2>故事一直在。<br>你随时可以回来。</h2><p>各自扮演，各自续写。已经发生的事，留在同一本历史里。</p></div><span class="sw-watermark" aria-hidden="true">共</span></section>',
            '<div class="sw-section-heading"><h3>' + (w ? '正在阅读' : '选择一个世界') + '</h3><span>' + h(s.cardName || '请先打开一个角色聊天') + '</span></div>',
            w ? '<article class="sw-world-card"><div class="sw-eyebrow">WORLD / ' + h(w.id.slice(0, 8)) + '</div><h3>' + h(w.name) + '</h3><p>' + h(w.opening || '共同开场尚未填写。') + '</p><div class="sw-world-stats"><span><b>' + w.actors.length + '</b> 人物</span><span><b>' + w.events.length + '</b> 段经历</span><span><b>' + w.revision + '</b> 记录版本</span></div><div class="sw-actions">' + button('读取最新历史', 'sync', '', 'sw-primary') + button('复制邀请', 'invite') + button('导出世界', 'export') + '</div><div class="sw-code">世界编号 <span>' + h(w.id) + '</span></div></article>' : '<div class="sw-empty">从世界列表加入，或和朋友从一段共同开场开始。</div>',
            w ? '<div class="sw-enable"><label><input id="sw-enabled" type="checkbox" data-action="toggle" ' + (b.enabled ? 'checked' : '') + '> 在当前聊天启用联机世界书</label><p>先选择归属自己的人物；关闭后正常单人游玩。</p></div>' : '',
            '<div class="sw-section-heading"><h3>同一张卡的其他世界</h3>' + button('刷新列表', 'list', '', 'sw-quiet') + '</div>',
            s.worlds.length ? '<div class="sw-world-list">' + s.worlds.map((row) => '<article><div><h4>' + h(row.name) + '</h4><p>' + row.actors.length + ' 个人物 · ' + row.events.length + ' 段经历</p></div>' + button(row.id === w?.id ? '已加入' : '加入', 'join', row.id) + '</article>').join('') + '</div>' : '<p class="sw-muted">列表只显示当前数据来源中，卡版本相同的世界。</p>',
            '<details class="sw-fold"><summary>用编号或邀请加入</summary><form id="sw-join">' + field('世界编号或邀请链接', 'worldId', '', { required: true }) + '<button class="sw-button sw-primary">读取并加入</button></form></details>',
            '<details class="sw-fold"><summary>开始一个新的共同故事</summary><form id="sw-create-world">' + field('世界名称', 'name', '', { required: true }) + field('时间起点说明', 'origin', '故事第 0 天', { required: true }) + field('共同开场', 'opening', '', { area: true }) + '<p class="sw-muted">创建者没有房主权限；不同版本的卡进入不同世界。</p><button class="sw-button sw-primary">建立世界</button></form></details>',
        ].join('');
    }
    actors() {
        const c = this.controller, w = c.state.world, b = c.binding;
        if (!w) return '<div class="sw-empty">先在“世界”里加入一个共同故事，再建立人物。</div>';
        const view = project(w, storyTime(b.day, b.clock).tick), me = w.actors.find((row) => row.id === b.actorId);
        const owned = w.actors.filter((row) => row.ownerId === c.settings.playerId);
        return [
            '<div class="sw-page-heading"><div class="sw-eyebrow">CHARACTERS</div><h2>每一个名字，<br>都有自己的经历。</h2><p>你可保留最多 3 个人物，一次扮演 1 个。归属不因离线而转移。</p></div>',
            '<div class="sw-actor-grid">' + w.actors.map((actor) => {
                const current = view.actors[actor.id] ?? actor, mine = actor.ownerId === c.settings.playerId;
                return '<article class="sw-actor-card ' + (b.actorId === actor.id ? 'sw-selected' : '') + '"><div class="sw-section-heading"><span class="sw-badge">' + (b.actorId === actor.id ? '正在扮演' : mine ? '属于你' : actor.ownerId ? '他人的角色' : '公共人物') + '</span><span class="sw-actor-initial">' + h(actor.name.slice(0, 1)) + '</span></div><h3>' + h(actor.name) + '</h3><p>' + h(current.profile.identity || '身份尚未展开') + '</p><dl><dt>所在地</dt><dd>' + h(current.profile.location || '未记录') + '</dd><dt>能力</dt><dd>' + h(current.profile.abilities || '由正文逐渐展开') + '</dd></dl>' + (mine ? button('扮演此人', 'select-actor', actor.id) : actor.ownerId ? '<span class="sw-muted">归属已保留，不能接手</span>' : button('接手此人', 'claim', actor.id)) + '</article>';
            }).join('') + '</div>',
            '<details class="sw-fold"><summary>新增人物 · 已拥有 ' + owned.length + '/3</summary><form id="sw-create-actor">' + field('人物名字', 'name', '', { required: true }) + '<label class="sw-field"><span>登记方式</span><select name="kind"><option value="player">归属自己的人物</option><option value="npc">尚未归属任何人的公共 NPC</option></select></label>' + PROFILE_FIELDS.map((key) => field(labels[key], key, '', { area: ['background', 'abilities', 'relationships'].includes(key), rows: 2 })).join('') + '<p class="sw-muted">字段固定。登记之后，人物状态和资产变化由正文提取，不提供手改事实的入口。</p><button class="sw-button sw-primary">登记人物</button></form></details>',
            me ? '<section class="sw-section"><div class="sw-section-heading"><h3>' + h(me.name) + ' · 托管范围</h3><span>你离线以后</span></div><form id="sw-policy"><div class="sw-policy-grid">' + POLICY_FIELDS.map((key) => '<label><input type="checkbox" name="' + key + '" ' + (me.delegation[key] ? 'checked' : '') + '><span>' + POLICY_LABELS[key] + '</span></label>').join('') + '</div><button class="sw-button sw-primary">保存托管范围</button></form><p class="sw-muted">已经发生的托管经历会保留，回归不自动撤销。</p><div class="sw-actions">' + button('退出并托管', 'exit', 'delegated', 'sw-quiet') + button('退出，留作背景人物', 'exit', 'background', 'sw-quiet') + '</div></section>' : '',
            me ? '<details class="sw-fold"><summary>开局物品</summary><div class="sw-item-list">' + Object.values(view.items).filter((item) => item.ownerId === me.id).map((item) => '<p><b>' + h(item.name) + '</b> ' + h(item.description) + '</p>').join('') + '</div><form id="sw-create-item">' + field('物品名称', 'name', '', { required: true }) + field('物品描述', 'description') + '<p class="sw-muted">仅在这个人物尚无游玩记录时可登记，后续从正文记录获得与转交。</p><button class="sw-button">登记开局物品</button></form></details>' : '',
        ].join('');
    }
    history() {
        const c = this.controller, w = c.state.world, b = c.binding;
        if (!w) return '<div class="sw-empty">加入世界后，这里会留下共同的年表。</div>';
        const time = storyTime(b.day, b.clock), view = project(w, time.tick), actor = view.actors[b.actorId];
        const nearby = Object.values(view.actors).filter((row) => row.id !== b.actorId && actor?.profile.location && row.profile.location === actor.profile.location);
        const pending = c.settings.pending.filter((row) => row.worldId === w.id);
        return [
            '<div class="sw-page-heading"><div class="sw-eyebrow">CHRONICLE</div><h2>发生过的事，<br>有迹可循。</h2><p>插件里可以查看历史。正文只使用人物此时应当知道的部分。</p></div>',
            '<form id="sw-time" class="sw-time-form">' + field('故事日', 'day', b.day, { type: 'number', required: true, extra: 'min="0" max="999999"' }) + field('具体时间', 'clock', b.clock, { type: 'time', required: true }) + '<label class="sw-field sw-targets"><span>已经在故事中找到的互动对象</span><select name="participants" multiple size="2">' + nearby.map((row) => '<option value="' + h(row.id) + '" ' + (b.participants.includes(row.id) ? 'selected' : '') + '>' + h(row.name) + '</option>').join('') + '</select></label><button class="sw-button">设置本轮时间与对象</button></form>',
            pending.length ? '<section class="sw-conflicts"><h3>需要你选择 · ' + pending.length + '</h3>' + pending.map((row) => '<article><span class="sw-badge">尚未影响共同世界</span><h4>' + h(row.error || '正在提取本轮变化…') + '</h4><details><summary>查看保留的正文</summary><pre>' + h(row.narration) + '</pre></details><div class="sw-actions">' + (row.proposal ? button('重试共享', 'retry', row.id) : '') + button('保留个人草稿', 'archive', row.id) + '</div><p class="sw-muted">也可以回到酒馆修改本方正文，再重新生成。插件不会替你改写原文。</p></article>').join('') + '</section>' : '',
            '<div class="sw-section-heading"><h3>共同历史</h3>' + button('读取最新', 'sync', '', 'sw-quiet') + '</div>',
            '<ol class="sw-timeline">' + [...w.events].sort((a, z) => a.time.tick - z.time.tick || a.id.localeCompare(z.id)).map((event) => '<li><time>' + h(timeLabel(event.time)) + '</time><div><span class="sw-badge">' + (event.time.tick > time.tick ? '尚未经历' : event.visibility === 'participants' ? '角色知情有限' : '已记录') + '</span><p>' + h(event.summary) + '</p><small>' + h(w.actors.find((row) => row.id === event.actorId)?.name ?? '') + ' · ' + h(event.location || '地点未记') + '</small></div></li>').join('') + '</ol>',
            !w.events.length ? '<div class="sw-empty">第一段共同经历，会从你们的正文开始。</div>' : '',
            '<section class="sw-section"><div class="sw-section-heading"><h3>我的经历摘要</h3>' + button('整理摘要', 'summarize', '', 'sw-quiet') + '</div><p class="sw-muted">使用你配置的摘要接口；没有单独配置时沿用酒馆接口。</p>' + (c.state.summary ? '<pre class="sw-summary">' + h(c.state.summary) + '</pre>' : '') + '</section>',
            '<details class="sw-fold"><summary>本机个人草稿 · ' + c.settings.archivedDrafts.filter((row) => row.worldId === w.id).length + ' 段</summary><p class="sw-muted">这些正文只保留在本机，不影响共同世界。</p>' + c.settings.archivedDrafts.filter((row) => row.worldId === w.id).map((row) => '<article class="sw-section"><small>' + h(timeLabel(row.time)) + '</small><pre>' + h(row.narration) + '</pre></article>').join('') + '</details>',
        ].join('');
    }
    settings() {
        const c = this.controller, config = c.settings;
        return [
            '<div class="sw-page-heading"><div class="sw-eyebrow">CONNECTION</div><h2>把世界连起来。</h2><p>正文仍用自己的酒馆。额外接口负责整理资料，存储服务保存共同记录。</p></div>',
            '<form id="sw-settings"><label class="sw-field"><span>世界记录来源</span><select name="provider"><option value="local" ' + (config.provider === 'local' ? 'selected' : '') + '>本机演示（仅当前浏览器）</option><option value="github" ' + (config.provider === 'github' ? 'selected' : '') + '>GitHub（实验适配）</option></select></label>',
            '<section class="sw-section"><h3>GitHub 存储</h3><p class="sw-muted">当前仅作框架验证。统一上传与正式发布授权方案仍需研究。</p><div class="sw-two-col">' + field('账户 / 组织', 'owner', config.github.owner) + field('数据仓库', 'repo', config.github.repo) + field('分支', 'branch', config.github.branch) + field('数据目录', 'directory', config.github.directory) + '</div>' + field('本次会话的写入凭据', 'githubToken', '', { type: 'password', extra: 'autocomplete="off" placeholder="不写入世界文件，不随导出分享"' }) + '</section>',
            ['extraction', 'summary', 'reasoning'].map((slot) => '<section class="sw-section"><h3>' + ({ extraction: '本轮变化提取', summary: '经历摘要', reasoning: '合理性接口（预留）' }[slot]) + '</h3><p class="sw-muted">' + (slot === 'reasoning' ? '框架保留配置，不自动运行复核，也不决定正文结果。' : '不填额外接口时，使用当前酒馆模型。') + '</p>' + field('兼容接口地址（例如 https://example.com/v1）', slot + 'Endpoint', config.models[slot]?.endpoint ?? '', { type: 'url' }) + '<div class="sw-two-col">' + field('模型名称', slot + 'Model', config.models[slot]?.model ?? '') + field('本次会话的 API Key', slot + 'Key', '', { type: 'password', extra: 'autocomplete="off"' }) + '</div></section>').join(''),
            '<div class="sw-actions"><button class="sw-button sw-primary">保存设置</button></div></form>',
            '<section class="sw-section sw-important"><h3>发布前必须再确认</h3><p>不能把你的个人上传凭据分发给其他玩家。统一上传、免账号加入和正式数据服务，仍列为重要问题，不在框架中假装已经解决。</p></section>',
        ].join('');
    }
    async click(event) {
        const tab = event.target.closest('[data-tab]');
        if (tab) { this.tab = tab.dataset.tab; this.render(); this.root.querySelector('.sw-main').scrollTop = 0; return; }
        const el = event.target.closest('[data-action]'); if (!el) return;
        const { action, value } = el.dataset, c = this.controller;
        if (action === 'close') return this.close();
        await c.run(async () => {
            if (action === 'list') await c.listWorlds();
            if (action === 'sync') await c.sync();
            if (action === 'join') { await c.joinWorld(value); this.inputCache.clear(); }
            if (action === 'select-actor') c.selectActor(value);
            if (action === 'claim') await c.claimActor(value);
            if (action === 'exit') await c.exitWorld(value);
            if (action === 'retry') await c.publishDraft(value);
            if (action === 'archive') c.archiveDraft(value);
            if (action === 'summarize') await c.summarize();
            if (action === 'toggle') {
                if (el.checked && !c.state.world?.actors.some((row) => row.id === c.binding.actorId && row.ownerId === c.settings.playerId)) throw new Error('请先选择归属自己的人物');
                c.bind({ enabled: el.checked });
            }
            if (action === 'invite') {
                const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('sworld', c.binding.worldId);
                await navigator.clipboard.writeText(url.href);
                c.state.notice = '邀请已复制。朋友仍需配置同一数据来源；邀请不含任何密钥。';
            }
            if (action === 'export') {
                const link = document.createElement('a'), url = URL.createObjectURL(new Blob([c.exportWorld()], { type: 'application/json' }));
                link.href = url; link.download = 'shared-world-' + c.binding.worldId + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        });
    }
    async submit(event) {
        event.preventDefault();
        const form = event.target, c = this.controller, data = Object.fromEntries(new FormData(form));
        await c.run(async () => {
            if (form.id === 'sw-create-world') await c.createWorld(data);
            if (form.id === 'sw-join') {
                let id = data.worldId;
                if (/^https?:\/\//.test(id)) id = new URL(id).searchParams.get('sworld') ?? '';
                await c.joinWorld(id);
            }
            if (form.id === 'sw-create-actor') await c.createActor(data);
            if (form.id === 'sw-create-item') await c.addStartingItem(data);
            if (form.id === 'sw-policy') await c.savePolicy(Object.fromEntries(POLICY_FIELDS.map((key) => [key, data[key] === 'on'])));
            if (form.id === 'sw-time') c.setTime(data.day, data.clock, new FormData(form).getAll('participants'));
            if (form.id === 'sw-settings') {
                const models = {}, secrets = { github: data.githubToken };
                for (const slot of ['extraction', 'summary', 'reasoning']) {
                    models[slot] = { endpoint: data[slot + 'Endpoint'].trim(), model: data[slot + 'Model'].trim() };
                    secrets['model.' + slot] = data[slot + 'Key'];
                }
                c.saveSettings({ provider: data.provider, github: { owner: data.owner.trim(), repo: data.repo.trim(), branch: data.branch.trim(), directory: data.directory.trim() }, models }, secrets);
            }
            this.inputCache.delete(form.id);
        });
    }
}
