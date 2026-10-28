import { assert, hash } from './domain.js';

const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function createInvite(world, settings) {
    assert(settings.provider === 'github', 'LOCAL_ONLY', '本机世界不能跨设备邀请；先连接共同数据仓库');
    const value = { v: 1, worldId: world.id, cardKey: world.cardKey, provider: 'github', github: { owner: settings.github.owner, repo: settings.github.repo, branch: settings.github.branch, directory: settings.github.directory } };
    return 'sw1:' + encode(new TextEncoder().encode(JSON.stringify(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function parseInvite(input) {
    const value = input.trim();
    if (!value.startsWith('sw1:')) return { worldId: /^https?:\/\//.test(value) ? new URL(value).searchParams.get('sworld') : value };
    assert(value.length < 12000, 'INVALID_INVITE', '邀请过长');
    let data;
    try { data = JSON.parse(new TextDecoder().decode(decode(value.slice(4).replaceAll('-', '+').replaceAll('_', '/')))); }
    catch { throw new Error('邀请内容损坏，请重新复制'); }
    assert(data.v === 1 && data.provider === 'github' && /^[\w-]{1,100}$/.test(data.worldId), 'INVALID_INVITE', '不支持的邀请格式');
    const source = data.github;
    assert(source && /^[\w.-]+$/.test(source.owner) && /^[\w.-]+$/.test(source.repo), 'INVALID_INVITE', '邀请的数据仓库无效');
    assert(typeof source.branch === 'string' && typeof source.directory === 'string' && !source.directory.split('/').some((part) => !part || part === '.' || part === '..'), 'INVALID_INVITE', '邀请的数据目录无效');
    return { worldId: data.worldId, cardKey: data.cardKey, provider: 'github', github: { owner: source.owner, repo: source.repo, branch: source.branch, directory: source.directory } };
}
export class SecretVault {
    constructor(storage, key = 'shared-world.encrypted-secrets.v1') { this.storage = storage; this.key = key; }
    async derive(password, salt) {
        assert(globalThis.crypto?.subtle, 'SECURE_CONTEXT_REQUIRED', '加密保存需要 HTTPS 或 localhost；当前仍可使用会话密钥');
        assert(typeof password === 'string' && password.length >= 10, 'WEAK_PASSPHRASE', '本机解锁口令至少 10 个字符');
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async save(secrets, password) {
        const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this.derive(password, salt);
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(Object.fromEntries(secrets))));
        this.storage.setItem(this.key, JSON.stringify({ v: 1, salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(data)) }));
    }
    async unlock(password) {
        const raw = this.storage.getItem(this.key); assert(raw, 'NO_VAULT', '本机还没有保存加密凭据');
        try {
            const value = JSON.parse(raw); assert(value.v === 1, 'INVALID_VAULT', '凭据格式不兼容');
            const key = await this.derive(password, decode(value.salt));
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, key, decode(value.data));
            const result = JSON.parse(new TextDecoder().decode(plain));
            assert(result && typeof result === 'object' && Object.entries(result).every(([name, secret]) => /^(github|model\.(extraction|summary|reasoning))$/.test(name) && typeof secret === 'string'), 'INVALID_VAULT', '凭据内容无效');
            return new Map(Object.entries(result));
        } catch { throw new Error('解锁失败：口令不正确或加密记录损坏，原记录未覆盖'); }
    }
}
export async function identityBackup(playerId) {
    return JSON.stringify({ format: 'shared-world/identity/1', playerId, checksum: await hash(playerId) }, null, 2);
}
export async function readIdentity(raw) {
    let value; try { value = JSON.parse(raw); } catch { throw new Error('身份文件不是有效 JSON'); }
    assert(value.format === 'shared-world/identity/1' && typeof value.playerId === 'string' && value.playerId.length <= 100 && await hash(value.playerId) === value.checksum, 'INVALID_IDENTITY', '身份文件校验失败');
    assert(!value.playerId.startsWith('github:'), 'GITHUB_IDENTITY', 'GitHub 身份请用本人凭据连接恢复，不能通过文件冒用');
    return value.playerId;
}
