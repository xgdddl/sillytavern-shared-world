const PROMPT_KEY = 'shared_world_context_v1';
export function attachTavern(controller, getContext) {
    let capture = null, waitAbort = null, stopped = false, syncing = false;
    const context = getContext(), events = context.eventSource, types = context.eventTypes ?? context.event_types;
    const clearPrompt = () => getContext()?.setExtensionPrompt?.(PROMPT_KEY, '', -1, 0, false, 0);
    const error = (reason) => { controller.state.error = reason.message ?? '联机处理失败'; controller.changed(); };
    const refresh = async () => {
        waitAbort?.abort(new Error('聊天已切换')); capture = null; clearPrompt();
        try { await controller.refreshContext(); } catch (reason) { error(reason); }
    };
    const intercept = async (_chat, _contextSize, abort, type) => {
        if (['quiet', 'raw', 'impersonate'].includes(type) || controller.models.depth) return;
        clearPrompt();
        if (!controller.binding.enabled) return;
        stopped = false;
        const ctx = getContext();
        const lastUser = [...ctx.chat].reverse().find((message) => message.is_user);
        const input = lastUser?.mes ?? '';
        const snapshot = controller.snapshot();
        waitAbort = new AbortController();
        try {
            const prompt = await controller.preparePrompt(input, { signal: waitAbort.signal });
            if (!controller.matches(snapshot)) throw new Error('聊天已切换，已停止旧世界的生成');
            getContext().setExtensionPrompt(PROMPT_KEY, prompt, 1, 0, false, 0);
            capture = { snapshot, input };
        } catch (reason) {
            clearPrompt(); capture = null; error(reason); abort(false);
        }
    };
    const ended = async () => {
        if (!capture || stopped || controller.models.depth) return;
        const current = capture; capture = null;
        if (!controller.matches(current.snapshot)) return;
        const ctx = getContext();
        let index = ctx.chat.length - 1;
        while (index >= 0 && (ctx.chat[index].is_user || ctx.chat[index].is_system)) index--;
        const message = ctx.chat[index];
        if (!message?.mes?.trim()) return;
        const key = current.snapshot.bindingKey + ':' + index + ':' + String(message.send_date ?? '');
        try { await controller.captureNarration(message.mes, current.input, key, current.snapshot); }
        catch (reason) { error(reason); }
    };
    const stop = () => { stopped = true; capture = null; waitAbort?.abort(new Error('本轮生成已停止')); };
    events.on(types.CHAT_CHANGED, refresh);
    events.on(types.GENERATION_ENDED, ended);
    events.on(types.GENERATION_STOPPED, stop);
    const interval = setInterval(async () => {
        if (syncing || capture || controller.models.depth || !controller.binding.enabled) return;
        syncing = true;
        try { await controller.sync(); } catch (reason) { error(reason); } finally { syncing = false; }
    }, 30_000);
    return {
        intercept,
        dispose() {
            clearInterval(interval); stop(); clearPrompt();
            events.removeListener?.(types.CHAT_CHANGED, refresh);
            events.removeListener?.(types.GENERATION_ENDED, ended);
            events.removeListener?.(types.GENERATION_STOPPED, stop);
        },
    };
}
