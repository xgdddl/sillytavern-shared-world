// Use SillyTavern's existing wand menu; never create a second menu or server.
export function mountWandMenu(document, onOpen) {
    let observer;
    const mount = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        if (document.getElementById('shared-world-wand')) return true;
        const container = document.createElement('div');
        container.id = 'shared-world-wand-container';
        container.className = 'extension_container';
        const button = document.createElement('button');
        button.id = 'shared-world-wand';
        button.type = 'button';
        button.className = 'list-group-item flex-container flexGap5';
        button.title = '打开共叙 · 联机世界书';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-book-open';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = '共叙 · 联机世界书';
        button.append(icon, label);
        button.addEventListener('click', onOpen);
        container.append(button);
        menu.append(container);
        return true;
    };
    if (!mount()) {
        observer = new MutationObserver(() => {
            if (mount()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
        observer?.disconnect();
        document.getElementById('shared-world-wand-container')?.remove();
    };
}
