import { POLICY_FIELDS, POLICY_LABELS, PROFILE_FIELDS, project, storyTime, timeLabel, sameLocation } from './domain.js';

const h = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (label, name, value = '', options = {}) => '<label class="sw-field"><span>' + label + '</span>' + (options.area
    ? '<textarea name="' + name + '" rows="' + (options.rows ?? 3) + '" ' + (options.required ? 'required' : '') + '>' + h(value) + '</textarea>'
    : '<input name="' + name + '" type="' + (options.type ?? 'text') + '" value="' + h(value) + '" ' + (options.required ? 'required' : '') + ' ' + (options.extra ?? '') + '>') + '</label>';
const button = (label, action, value = '', className = '') => '<button type="button" class="sw-button ' + className + '" data-action="' + action + '" data-value="' + h(value) + '">' + label + '</button>';
const labels = { identity: '身份', background: '背景与经历', personality: '性格', abilities: '能力描述', location: '所在地', status: '状态', relationships: '人物关系' };
export class WorldPanel {
    constructor(controller, { container, standalone = false } = {}) {
        this.controller = controller; this.tab = 'world'; this.standalone = standalone; this.inputCache = new Map(); this.historyLimit = 50;
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
        controller.addEventListener('change', () => { if (!this.dialog || this.dialog.open) this.render(); });
        this.render();
    }
    open() { if (this.dialog && !this.dialog.open) this.dialog.showModal(); this.render(); }
    close() { for (const el of this.root.querySelectorAll('input[type="password"]')) el.value = ''; this.dialog?.close(); }
    render() {
        const c = this.controller, s = c.state, b = c.binding;
        const focus = this.root.contains(document.activeElement) ? { name: document.activeElement.name, start: document.activeElement.selectionStart } : null;
        const scroll = this.root.querySelector('.sw-main')?.scrollTop ?? 0;
        const expanded = Array.from(this.root.querySelectorAll('details[open]')).map((el) => el.querySelector('form')?.id ?? el.querySelector('summary')?.textContent);
        const transientPasswords = new Map(Array.from(this.root.querySelectorAll('input[type="password"]')).map((el) => [el.name, el.value]));
        const content = this.tab === 'world' ? this.world() : this.tab === 'actors' ? this.actors() : this.tab === 'history' ? this.history() : this.settings();
        this.root.innerHTML = [
            '<header class="sw-header"><div class="sw-brand"><span class="sw-seal" aria-hidden="true">叙</span><div><div class="sw-eyebrow">SHARED WORLD · 1.0.0-rc.3</div><h1>共叙<span>联机世界书</span></h1></div></div>',
            '<div class="sw-header-right"><span class="sw-status"><i class="' + (b.enabled ? 'is-active' : '') + '"></i>' + (b.enabled ? '当前聊天已开启' : '当前聊天未开启') + '</span>' + (this.standalone ? '' : button('关闭', 'close', '', 'sw-quiet')) + '</div></header>',
            '<nav class="sw-tabs" aria-label="世界书导航">' + [['world', '世界'], ['actors', '人物'], ['history', '年表'], ['settings', '设置']].map(([id, label], index) => '<button type="button" data-tab="' + id + '" aria-current="' + (id === this.tab ? 'page' : 'false') + '"><span>0' + (index + 1) + '</span>' + label + (id === 'history' && c.settings.pending.length ? '<b>' + c.settings.pending.length + '</b>' : '') + '</button>').join('') + '</nav>',
            '<main class="sw-main" aria-busy="' + s.busy + '">' + (s.error ? '<div class="sw-message sw-error" role="alert">' + h(s.error) + '</div>' : '') + (s.notice ? '<div class="sw-message" role="status">' + h(s.notice) + '</div>' : '') + content + '</main>',
            '<footer class="sw-footer"><span>' + (c.settings.provider === 'local' ? '本机演示 · 不会同步到其他设备' : h(c.service.store.label)) + '</span><span>' + (s.busy ? '正在处理…' : s.lastSync ? '上次读取 ' + h(s.lastSync) : '最多等待 60 秒') + '</span></footer>',
        ].join('');
        for (const el of this.root.querySelectorAll('input[type="password"]')) el.value = transientPasswords.get(el.name) ?? '';
        if (s.busy) for (const el of this.root.querySelectorAll('.sw-main button')) el.disabled = true;
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
            '<div class="sw-onboarding"><span class="' + (c.settings.provider === 'github' ? 'is-done' : '') + '">01 连接共同记录</span><span class="' + (w ? 'is-done' : '') + '">02 加入故事</span><span class="' + (b.actorId ? 'is-done' : '') + '">03 选择人物</span><span class="' + (b.enabled ? 'is-done' : '') + '">04 开始续写</span></div>',
            c.settings.provider === 'local' ? '<div class="sw-message">当前是本机模式，朋友还不能看到这里的变化。到“设置”配置共同数据仓库，再使用你本人的凭据检查读写连接。</div>' : '',
            '<div class="sw-section-heading"><h3>' + (w ? '正在阅读' : '选择一个世界') + '</h3><span>' + h(s.cardName || '请先打开一个角色聊天') + '</span></div>',
            w ? '<article class="sw-world-card"><div class="sw-eyebrow">WORLD / ' + h(w.id.slice(0, 8)) + '</div><h3>' + h(w.name) + '</h3><p>' + h(w.opening || '共同开场尚未填写。') + '</p><div class="sw-world-stats"><span><b>' + w.actors.length + '</b> 人物</span><span><b>' + w.events.length + '</b> 段经历</span><span><b>' + w.revision + '</b> 记录版本</span></div><div class="sw-actions">' + button('读取最新历史', 'sync', '', 'sw-primary') + button('复制邀请', 'invite') + button('导出世界', 'export') + '</div><div class="sw-code">世界编号 <span>' + h(w.id) + '</span></div></article>' : '<div class="sw-empty">从世界列表加入，或和朋友从一段共同开场开始。</div>',
            w ? '<div class="sw-enable"><label><input id="sw-enabled" type="checkbox" data-action="toggle" ' + (b.enabled ? 'checked' : '') + '> 在当前聊天启用联机世界书</label><p>先选择归属自己的人物；关闭后正常单人游玩。</p></div>' : '',
            w ? '<details class="sw-fold"><summary>此时的共同事实 · ' + Object.keys(project(w, storyTime(b.day, b.clock).tick).facts).length + '</summary>' + Object.values(project(w, storyTime(b.day, b.clock).tick).facts).map((fact) => '<p><b>' + h(fact.label) + '</b> ' + h(w.actors.find((actor) => actor.id === fact.value)?.name ?? fact.value) + '</p>').join('') + '</details>' : '',
            '<div class="sw-section-heading"><h3>同一张卡的其他世界</h3>' + button('刷新列表', 'list', '', 'sw-quiet') + '</div>',
            s.worlds.length ? '<div class="sw-world-list">' + s.worlds.map((row) => '<article><div><h4>' + h(row.name) + '</h4><p>' + row.actors.length + ' 个人物 · ' + row.events.length + ' 段经历</p></div>' + button(row.id === w?.id ? '已加入' : '加入', 'join', row.id) + '</article>').join('') + '</div>' : '<p class="sw-muted">列表只显示当前数据来源中，卡版本相同的世界。</p>',
            '<details class="sw-fold"><summary>用编号或邀请加入</summary><form id="sw-join">' + field('世界编号或邀请链接', 'worldId', '', { required: true }) + '<button class="sw-button sw-primary">读取并加入</button></form></details>',
            '<details class="sw-fold"><summary>开始一个新的共同故事</summary><form id="sw-create-world">' + field('世界名称', 'name', '', { required: true }) + field('时间起点说明', 'origin', '故事第 0 天', { required: true }) + field('共同开场', 'opening', '', { area: true }) + '<p class="sw-muted">创建者没有房主权限；不同版本的卡进入不同世界。</p><button class="sw-button sw-primary">建立世界</button></form></details>',
            '<details class="sw-fold"><summary>从导出文件恢复世界</summary><form id="sw-import-world"><label class="sw-field"><span>选择世界 JSON 文件</span><input type="file" name="worldFile" accept=".json,application/json" required></label><p class="sw-muted">恢复为独立副本，保留人物归属和完整历史，不覆盖原世界。使用与文件相同的角色卡和外置世界书。</p><button class="sw-button">恢复副本</button></form></details>',
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
                return '<article class="sw-actor-card ' + (b.actorId === actor.id ? 'sw-selected' : '') + '"><div class="sw-section-heading"><span class="sw-badge">' + (b.actorId === actor.id ? '正在扮演' : mine ? '属于你' : actor.ownerId ? '他人的角色' : '公共人物') + '</span><span class="sw-actor-initial">' + h(actor.name.slice(0, 1)) + '</span></div><h3>' + h(actor.name) + '</h3><p>' + h(current.profile.identity || '身份尚未展开') + '</p><dl><dt>所在地</dt><dd>' + h(current.profile.location || '未记录') + '</dd><dt>能力</dt><dd>' + h(current.profile.abilities || '由正文逐渐展开') + '</dd><dt>状态</dt><dd>' + h(current.profile.status || '未记录') + '</dd></dl><details><summary>背景与关系</summary><p>' + h(current.profile.background) + '</p><p>' + h(current.profile.relationships) + '</p><small>' + h((actor.aliases ?? []).join('、')) + '</small></details>' + (mine ? button('扮演此人', 'select-actor', actor.id) : actor.ownerId ? '<span class="sw-muted">归属已保留，不能接手</span>' : button('接手此人', 'claim', actor.id)) + '</article>';
            }).join('') + '</div>',
            '<details class="sw-fold"><summary>新增人物 · 已拥有 ' + owned.length + '/3</summary><form id="sw-create-actor">' + field('人物名字', 'name', '', { required: true }) + '<label class="sw-field"><span>登记方式</span><select name="kind"><option value="player">归属自己的人物</option><option value="npc">尚未归属任何人的公共 NPC</option></select></label>' + PROFILE_FIELDS.map((key) => field(labels[key], key, '', { area: ['background', 'abilities', 'relationships'].includes(key), rows: 2 })).join('') + '<p class="sw-muted">字段固定。登记之后，人物状态和资产变化由正文提取，不提供手改事实的入口。</p><button class="sw-button sw-primary">登记人物</button></form></details>',
            me ? '<section class="sw-section"><div class="sw-section-heading"><h3>' + h(me.name) + ' · 托管范围</h3><span>你离线以后</span></div><form id="sw-policy"><div class="sw-policy-grid">' + POLICY_FIELDS.map((key) => '<label><input type="checkbox" name="' + key + '" ' + (me.delegation[key] ? 'checked' : '') + '><span>' + POLICY_LABELS[key] + '</span></label>').join('') + '</div><button class="sw-button sw-primary">保存托管范围</button></form><p class="sw-muted">已经发生的托管经历会保留，回归不自动撤销。</p><div class="sw-actions">' + button('退出并托管', 'exit', 'delegated', 'sw-quiet') + button('退出，留作背景人物', 'exit', 'background', 'sw-quiet') + '</div></section>' : '',
            me ? '<details class="sw-fold"><summary>物品与开局登记</summary><div class="sw-item-list">' + Object.values(view.items).filter((item) => item.ownerId === me.id).map((item) => '<p><b>' + h(item.name) + '</b> ×' + h(item.quantity ?? 1) + ' · ' + h(item.status ?? '可用') + '<br>' + h(item.description) + '</p>').join('') + '</div><form id="sw-create-item">' + field('物品名称', 'name', '', { required: true }) + field('物品描述', 'description') + '<p class="sw-muted">仅在这个人物尚无游玩记录时可登记，后续获得、消耗、转交和损坏从正文记录。</p><button class="sw-button">登记开局物品</button></form></details>' : '',
        ].join('');
    }
    history() {
        const c = this.controller, w = c.state.world, b = c.binding;
        if (!w) return '<div class="sw-empty">加入世界后，这里会留下共同的年表。</div>';
        const time = storyTime(b.day, b.clock), view = project(w, time.tick), actor = view.actors[b.actorId];
        const nearby = Object.values(view.actors).filter((row) => row.id !== b.actorId && sameLocation(row.profile.location, actor?.profile.location));
        const pending = c.settings.pending.filter((row) => row.worldId === w.id);
        return [
            '<div class="sw-page-heading"><div class="sw-eyebrow">CHRONICLE</div><h2>发生过的事，<br>有迹可循。</h2><p>插件里可以查看历史。正文只使用人物此时应当知道的部分。</p></div>',
            '<form id="sw-time" class="sw-time-form">' + field('故事日', 'day', b.day, { type: 'number', required: true, extra: 'min="0" max="999999"' }) + field('具体时间', 'clock', b.clock, { type: 'time', required: true }) + '<label class="sw-field sw-targets"><span>已经在故事中找到的互动对象</span><select name="participants" multiple size="2">' + nearby.map((row) => '<option value="' + h(row.id) + '" ' + (b.participants.includes(row.id) ? 'selected' : '') + '>' + h(row.name) + '</option>').join('') + '</select></label><button class="sw-button">设置本轮时间与对象</button></form>',
            pending.length ? '<section class="sw-conflicts"><h3>需要你选择 · ' + pending.length + '</h3>' + pending.map((row) => '<article><span class="sw-badge">尚未影响共同世界</span><h4>' + h(row.error || '正在提取本轮变化…') + '</h4><details><summary>查看或修改这段草稿，再重新提取</summary><form id="sw-reextract-' + h(row.id) + '" data-draft="' + h(row.id) + '">' + field('保留的正文', 'narration', row.narration, { area: true, rows: 8 }) + '<button class="sw-button">重新提取并尝试共享</button></form></details><div class="sw-actions">' + (row.proposal ? button('重试共享', 'retry', row.id) : '') + button('保留个人草稿', 'archive', row.id) + '</div><p class="sw-muted">修改只作用于这段待处理草稿，不会替你改写酒馆聊天或已经确认的共同事实。</p></article>').join('') + '</section>' : '',
            '<div class="sw-section-heading"><h3>共同历史</h3>' + button('读取最新', 'sync', '', 'sw-quiet') + '</div>',
            '<ol class="sw-timeline">' + [...w.events].sort((a, z) => a.time.tick - z.time.tick || a.id.localeCompare(z.id)).slice(-this.historyLimit).map((event) => '<li><time>' + h(timeLabel(event.time)) + '</time><div><span class="sw-badge">' + (event.time.tick > time.tick ? '尚未经历' : event.scope === 'world' ? '世界大事件' : event.visibility === 'participants' ? '角色知情有限' : '已记录') + '</span><p>' + h(event.summary) + '</p><small>' + h(w.actors.find((row) => row.id === event.actorId)?.name ?? '') + ' · ' + h(event.location || '地点未记') + '</small></div></li>').join('') + '</ol>',
            w.events.length > this.historyLimit ? button('查看更早的 50 段经历', 'older', '', 'sw-quiet') : '',
            !w.events.length ? '<div class="sw-empty">第一段共同经历，会从你们的正文开始。</div>' : '',
            '<section class="sw-section"><div class="sw-section-heading"><h3>我的经历摘要</h3>' + button('整理摘要', 'summarize', '', 'sw-quiet') + '</div><p class="sw-muted">使用你配置的摘要接口；没有单独配置时沿用酒馆接口。</p>' + (c.state.summary ? '<pre class="sw-summary">' + h(c.state.summary) + '</pre>' : '') + '</section>',
            '<details class="sw-fold"><summary>本机个人草稿 · ' + c.settings.archivedDrafts.filter((row) => row.worldId === w.id).length + ' 段</summary><p class="sw-muted">这些正文只保留在本机，不影响共同世界。</p>' + c.settings.archivedDrafts.filter((row) => row.worldId === w.id).map((row) => '<article class="sw-section"><small>' + h(timeLabel(row.time)) + '</small><pre>' + h(row.narration) + '</pre></article>').join('') + '</details>',
        ].join('');
    }
    settings() {
        const c = this.controller, config = c.settings;
        return [
            '<div class="sw-page-heading"><div class="sw-eyebrow">CONNECTION</div><h2>把世界连起来。</h2><p>正文仍用自己的酒馆。额外接口负责整理资料，存储服务保存共同记录。</p></div>',
            '<form id="sw-settings"><label class="sw-field"><span>世界记录来源</span><select name="provider"><option value="local" ' + (config.provider === 'local' ? 'selected' : '') + '>本机演示（仅当前浏览器）</option><option value="github" ' + (config.provider === 'github' ? 'selected' : '') + '>GitHub 共同记录</option></select></label>',
            '<section class="sw-section"><h3>共同数据仓库</h3><p class="sw-muted">每位玩家使用自己账号的仓库读写权限；资源管理员授予协作者权限，不获得额外游戏裁定权。插件代码仓库和故事数据仓库请分开。</p><div class="sw-two-col">' + field('账户 / 组织', 'owner', config.github.owner) + field('数据仓库', 'repo', config.github.repo) + field('分支', 'branch', config.github.branch) + field('数据目录', 'directory', config.github.directory) + '</div>' + field('你本人的 GitHub 写入凭据', 'githubToken', '', { type: 'password', extra: 'autocomplete="off" placeholder="仅授权数据仓库的 Contents 读写，不分享管理密钥"' }) + '<p class="sw-muted">' + (config.githubAccount ? '上次验证账号：' + h(config.githubAccount.login) + '。' : '') + (c.secrets.has('github') ? '本次会话已有凭据。' : '本次会话尚未填写或解锁凭据。') + '</p></section>',
            ['extraction', 'summary', 'reasoning'].map((slot) => '<section class="sw-section"><h3>' + ({ extraction: '本轮变化提取', summary: '经历摘要', reasoning: '合理性接口（预留）' }[slot]) + '</h3><p class="sw-muted">' + (slot === 'reasoning' ? '保留配置，不自动运行复核，也不决定正文结果。' : '不填额外接口时，使用当前酒馆模型；自定义流式连接会沿用流式方式。') + '</p>' + field('兼容接口地址（例如 https://example.com/v1）', slot + 'Endpoint', config.models[slot]?.endpoint ?? '', { type: 'url' }) + '<div class="sw-two-col">' + field('模型名称', slot + 'Model', config.models[slot]?.model ?? '') + field('本次会话的 API Key', slot + 'Key', '', { type: 'password', extra: 'autocomplete="off"' }) + '</div><label><input type="checkbox" name="' + slot + 'Stream" ' + (config.models[slot]?.stream ? 'checked' : '') + '> 额外接口使用流式响应</label></section>').join(''),
            '<label class="sw-field"><span><input type="checkbox" name="autoSummary" ' + (config.autoSummary ? 'checked' : '') + '> 每增加约 20 段经历自动整理长期记忆（会增加模型用量）</span></label><div class="sw-actions"><button class="sw-button sw-primary">保存设置</button></div></form>',
            '<section class="sw-section"><h3>连接与控制</h3><p class="sw-muted">先保存上面的设置，再验证你本人的账号、仓库写入和读回。测试只写入连接检查记录，不发送聊天正文。</p><div class="sw-actions">' + button('检查读写连接', 'connect', '', 'sw-primary') + button('把人物控制转到本设备', 'takeover', '', 'sw-quiet') + button('锁定本机会话凭据', 'lock', '', 'sw-quiet') + '</div></section>',
            '<details class="sw-fold"><summary>加密保存与解锁本机凭据</summary><p class="sw-muted">默认只保留到页面关闭。可用本机口令加密保存；口令不上传，丢失后需要重新填写 API Key。</p><form id="sw-vault-save">' + field('本机解锁口令（至少 10 字符）', 'vaultSavePassword', '', { type: 'password', required: true, extra: 'autocomplete="new-password" minlength="10"' }) + '<button class="sw-button">加密保存当前会话凭据</button></form><form id="sw-vault-unlock">' + field('本机解锁口令', 'vaultUnlockPassword', '', { type: 'password', required: true, extra: 'autocomplete="current-password"' }) + '<button class="sw-button">解锁已保存凭据</button></form></details>',
            '<details class="sw-fold"><summary>身份与换设备</summary><p class="sw-muted">GitHub 模式使用本人账号恢复同一身份；本机模式可导出身份编号后，在另一浏览器恢复。这是受信任玩家的协作模式，仓库写权限仍能直接改文件，不能用于竞技防作弊。</p><div class="sw-code">当前身份 <span>' + h(config.playerId) + '</span></div>' + (config.provider === 'local' ? button('导出本机身份', 'export-identity') + '<form id="sw-import-identity"><label class="sw-field"><span>本机身份文件</span><input name="identityFile" type="file" accept=".json,application/json" required></label><button class="sw-button">恢复本机身份</button></form>' : '') + '</details>',
            '<section class="sw-section sw-important"><h3>共同记录的边界</h3><p>共同历史依靠各自正文和有依据的事实提取。明确冲突会暂停共享并保留草稿；模型对隐含矛盾的识别仍可能出错。公开数据仓库中的故事记录可被其他人读取。</p></section>',
        ].join('');
    }
    async click(event) {
        const tab = event.target.closest('[data-tab]');
        if (tab) { this.tab = tab.dataset.tab; this.render(); this.root.querySelector('.sw-main').scrollTop = 0; return; }
        const el = event.target.closest('[data-action]'); if (!el) return;
        const { action, value } = el.dataset, c = this.controller;
        if (action === 'close') return this.close();
        if (action === 'older') { this.historyLimit += 50; this.render(); return; }
        await c.run(async () => {
            if (action === 'list') await c.listWorlds();
            if (action === 'sync') await c.sync();
            if (action === 'join') { await c.joinWorld(value); this.inputCache.clear(); }
            if (action === 'select-actor') c.selectActor(value);
            if (action === 'claim') await c.claimActor(value);
            if (action === 'exit') await c.exitWorld(value);
            if (action === 'retry') await c.publishDraft(value);
            if (action === 'archive') await c.archiveDraft(value);
            if (action === 'summarize') await c.summarize();
            if (action === 'connect') await c.connect();
            if (action === 'takeover') await c.acquireControl(true);
            if (action === 'lock') { await c.setEnabled(false); c.secrets.clear(); c.configureStore(); c.state.notice = '会话凭据已锁定，当前聊天联机已关闭。加密记录仍保留，可再次解锁。'; c.changed(); }
            if (action === 'export-identity') download('shared-world-identity.json', await c.exportIdentity());
            if (action === 'toggle') {
                if (el.checked && !c.state.world?.actors.some((row) => row.id === c.binding.actorId && row.ownerId === c.settings.playerId)) throw new Error('请先选择归属自己的人物');
                await c.setEnabled(el.checked);
            }
            if (action === 'invite') {
                await navigator.clipboard.writeText(c.invite());
                c.state.notice = '邀请已复制，包含世界编号与数据来源，不含密钥。朋友在自己的酒馆粘贴加入，并使用本人的仓库权限。';
            }
            if (action === 'export') {
                download('shared-world-' + c.binding.worldId + '.json', c.exportWorld());
            }
        });
    }
    async submit(event) {
        event.preventDefault();
        const form = event.target, c = this.controller, data = Object.fromEntries(new FormData(form));
        await c.run(async () => {
            if (form.id === 'sw-create-world') await c.createWorld(data);
            if (form.id === 'sw-join') {
                await c.acceptInvite(data.worldId);
            }
            if (form.dataset.draft) await c.reextractDraft(form.dataset.draft, data.narration);
            if (form.id === 'sw-import-world') await c.importWorld(await data.worldFile.text());
            if (form.id === 'sw-import-identity') await c.importIdentity(await data.identityFile.text());
            if (form.id === 'sw-vault-save') { await c.vault.save(c.secrets, data.vaultSavePassword); c.state.notice = '凭据已在当前浏览器加密保存，口令未上传。'; c.changed(); }
            if (form.id === 'sw-vault-unlock') { c.secrets = await c.vault.unlock(data.vaultUnlockPassword); c.configureStore(); c.state.notice = '本机会话凭据已解锁，可检查连接后继续。'; c.changed(); }
            if (form.id === 'sw-create-actor') await c.createActor(data);
            if (form.id === 'sw-create-item') await c.addStartingItem(data);
            if (form.id === 'sw-policy') await c.savePolicy(Object.fromEntries(POLICY_FIELDS.map((key) => [key, data[key] === 'on'])));
            if (form.id === 'sw-time') c.setTime(data.day, data.clock, new FormData(form).getAll('participants'));
            if (form.id === 'sw-settings') {
                const models = {}, secrets = { github: data.githubToken };
                for (const slot of ['extraction', 'summary', 'reasoning']) {
                    models[slot] = { endpoint: data[slot + 'Endpoint'].trim(), model: data[slot + 'Model'].trim(), stream: data[slot + 'Stream'] === 'on' };
                    secrets['model.' + slot] = data[slot + 'Key'];
                }
                c.saveSettings({ provider: data.provider, github: { owner: data.owner.trim(), repo: data.repo.trim(), branch: data.branch.trim(), directory: data.directory.trim() }, models, autoSummary: data.autoSummary === 'on' }, secrets);
            }
            this.inputCache.delete(form.id);
            for (const el of this.root.querySelectorAll('input[type="password"]')) el.value = '';
        });
    }
}
function download(name, raw) {
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
