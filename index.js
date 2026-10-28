import { WorldController } from './src/controller.js';
import { WorldPanel } from './src/panel.js';
import { attachTavern } from './src/tavern.js';
import { mountWandMenu } from './src/menu.js';
import { resolveWorldbooks } from './src/compatibility.js';

let integration;
let ready;
globalThis.sharedWorldBeforeGenerate = async (...args) => {
    await ready;
    return integration?.intercept(...args);
};
async function initialize() {
    if (globalThis.sharedWorld?.version) return;
    const getContext = () => globalThis.SillyTavern?.getContext?.();
    if (!getContext()) return;
    const controller = new WorldController({ getContext, resolveCompatibility: resolveWorldbooks });
    const panel = new WorldPanel(controller);
    integration = attachTavern(controller, getContext);
    mountWandMenu(document, () => panel.open());
    const button = document.createElement('button');
    button.id = 'sw-launcher'; button.type = 'button'; button.textContent = '共叙';
    button.title = '打开联机世界书'; button.addEventListener('click', () => panel.open());
    const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (target) {
        const block = document.createElement('div'); block.id = 'sw-settings-entry';
        const title = document.createElement('strong'); title.textContent = '共叙 · 联机世界书';
        const note = document.createElement('p'); note.textContent = '共同历史 · 在所选聊天中开启联机';
        block.append(title, note, button); target.append(block);
    } else { button.className = 'sw-floating-launcher'; document.body.append(button); }
    globalThis.sharedWorld = { version: '1.0.0-rc.4', open: () => panel.open() };
    await controller.refreshContext();
    const invite = new URL(location.href).searchParams.get('sworld');
    if (invite) {
        controller.state.notice = '收到世界邀请：' + invite + '。先配置相同数据来源，再在“用编号加入”中读取。';
        controller.changed(); panel.open();
    }
}
ready = (document.readyState === 'loading' ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true })) : Promise.resolve()).then(initialize).catch((error) => {
    const item = document.createElement('div'); item.id = 'sw-startup-error'; item.textContent = '共叙未启动：' + error.message;
    (document.querySelector('#extensions_settings2') ?? document.body).append(item);
});
