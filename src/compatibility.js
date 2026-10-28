// Read lorebooks through Tavern's own module. Never modify or rebind a lorebook.
export async function resolveWorldbooks(context, card) {
    if (!globalThis.location || !globalThis.SillyTavern) return null;
    const module = await import('/scripts/world-info.js');
    const fileName = card.avatar?.replace(/\.[^.]+$/, '');
    const extra = module.world_info?.charLore?.find((row) => row.name === fileName)?.extraBooks ?? [];
    const names = [...new Set([...(module.selected_world_info ?? []), card.data?.extensions?.world, context.chatMetadata?.world_info, ...extra].filter((name) => typeof name === 'string' && name))];
    const result = [];
    for (const name of names) {
        const book = await module.loadWorldInfo(name);
        if (!book?.entries) throw new Error('无法读取已绑定的世界书“' + name + '”，本轮没有错误匹配到其他版本');
        const entries = Object.values(book.entries).map((entry) => Object.fromEntries(['key', 'keysecondary', 'content', 'constant', 'selective', 'selectiveLogic', 'order', 'position', 'depth', 'disable', 'role', 'probability', 'useProbability', 'excludeRecursion', 'preventRecursion'].map((key) => [key, entry[key] ?? null])));
        entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        result.push(entries);
    }
    return result.length ? result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : null;
}
