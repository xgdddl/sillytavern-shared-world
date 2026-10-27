import { WorldError, assert, copy, validateWorld } from './domain.js';

const safeId = (id) => {
    assert(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id), 'INVALID_ID', '世界编号不合法');
    return id;
};
export function parseStored(raw) {
    let world;
    try { world = typeof raw === 'string' ? JSON.parse(raw) : copy(raw); }
    catch { throw new WorldError('CORRUPT_STORAGE', '世界文件不是有效 JSON，未覆盖原始内容'); }
    return validateWorld(world);
}
export class MemoryStore {
    constructor() { this.worlds = new Map(); this.label = '内存测试'; }
    async read(id) {
        const world = this.worlds.get(id);
        return world ? { world: copy(world), token: String(world.revision) } : null;
    }
    async list() { return [...this.worlds.values()].map(copy); }
    async write(id, world, expected) {
        const current = this.worlds.get(id);
        assert((current ? String(current.revision) : null) === expected, 'STORAGE_CONFLICT', '世界版本已更新');
        validateWorld(world); this.worlds.set(id, copy(world));
        return { world: copy(world), token: String(world.revision) };
    }
}
export class LocalStore {
    constructor(storage = globalThis.localStorage, locks = globalThis.navigator?.locks) {
        this.storage = storage; this.locks = locks; this.label = '本机演示';
        this.prefix = 'shared-world.data.v1:';
    }
    async read(id) {
        const raw = this.storage.getItem(this.prefix + safeId(id));
        if (raw === null) return null;
        const world = parseStored(raw);
        return { world, token: String(world.revision) };
    }
    async list() {
        const worlds = [];
        for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i);
            if (key.startsWith(this.prefix)) worlds.push(parseStored(this.storage.getItem(key)));
        }
        return worlds;
    }
    async write(id, world, expected) {
        const run = async () => {
            const current = await this.read(id);
            assert((current?.token ?? null) === expected, 'STORAGE_CONFLICT', '世界版本已更新');
            validateWorld(world);
            this.storage.setItem(this.prefix + safeId(id), JSON.stringify(world));
            const saved = await this.read(id);
            assert(saved && saved.world.revision === world.revision, 'STORAGE_CONFLICT', '本机记录写入后校验失败');
            return saved;
        };
        assert(this.locks?.request, 'LOCAL_LOCK_UNAVAILABLE', '本机演示需要浏览器 Web Locks；请使用 localhost 或安全地址');
        return this.locks.request(this.prefix + safeId(id), run);
    }
}
function utf8Base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
}
function decode64(value) {
    const binary = atob(value.replace(/\s/g, ''));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
export class GitHubStore {
    constructor({ owner, repo, branch = 'main', directory = 'shared-world/worlds', token = () => '', fetchImpl = globalThis.fetch }) {
        for (const [name, value] of Object.entries({ owner, repo, branch, directory })) assert(typeof value === 'string' && value.length > 0, 'INVALID_CONFIG', name + '不能为空');
        assert(/^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo), 'INVALID_CONFIG', '仓库账户或名称不合法');
        assert(!directory.split('/').some((part) => part === '..' || part === '.' || !part), 'INVALID_CONFIG', '数据目录不合法');
        this.owner = owner; this.repo = repo; this.branch = branch; this.directory = directory;
        this.token = token; this.fetchImpl = fetchImpl; this.label = 'GitHub · ' + owner + '/' + repo;
    }
    async request(path, { method = 'GET', body, signal } = {}) {
        const key = this.token();
        const timeout = AbortSignal.timeout(15_000);
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (key) headers.Authorization = 'Bearer ' + key;
        if (body) headers['Content-Type'] = 'application/json';
        const response = await this.fetchImpl('https://api.github.com/repos/' + this.owner + '/' + this.repo + path, {
            method, headers, body: body ? JSON.stringify(body) : undefined,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 404 && method === 'GET') return null;
        if (response.status === 409) throw new WorldError('STORAGE_CONFLICT', 'GitHub 上的版本已更新，需要重新读取');
        if (!response.ok) {
            const label = response.status === 403 || response.status === 429 ? '访问受限或达到请求限制，请稍后重试' : '请求失败，请检查仓库、分支和读写权限';
            throw new WorldError('REMOTE_ERROR', 'GitHub ' + response.status + '：' + label, { status: response.status });
        }
        return response.json();
    }
    path(id) { return '/contents/' + this.directory.split('/').map(encodeURIComponent).join('/') + '/' + safeId(id) + '.json'; }
    async read(id, options = {}) {
        const result = await this.request(this.path(id) + '?ref=' + encodeURIComponent(this.branch), options);
        if (!result) return null;
        assert(result.encoding === 'base64' && typeof result.content === 'string', 'REMOTE_FORMAT', '世界文件过大或返回格式不支持');
        const world = parseStored(decode64(result.content));
        assert(world.id === id, 'REMOTE_FORMAT', '文件中的世界编号与路径不符');
        return { world, token: result.sha };
    }
    async list() {
        const root = await this.request('');
        assert(root, 'REMOTE_NOT_FOUND', '仓库不可读或不存在；公开仓库也不代表拥有写入权限');
        const path = '/contents/' + this.directory.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(this.branch);
        const rows = await this.request(path);
        if (!rows) return [];
        assert(Array.isArray(rows), 'REMOTE_FORMAT', '世界目录不是文件列表');
        const files = rows.filter((row) => row.type === 'file' && /^[\w-]+\.json$/.test(row.name));
        assert(files.length <= 50, 'LIST_LIMIT', '框架版最多列出 50 个世界，请使用世界编号直接加入');
        const worlds = [];
        for (const file of files) {
            const result = await this.read(file.name.slice(0, -5));
            if (result) worlds.push(result.world);
        }
        return worlds;
    }
    async write(id, world, expected, options = {}) {
        assert(this.token(), 'NO_CREDENTIAL', '上传需要在本机填写 GitHub 写入凭据；凭据不会上传到世界文件');
        validateWorld(world);
        const json = JSON.stringify(world);
        assert(new TextEncoder().encode(json).length < 900_000, 'STORAGE_SIZE', '框架版单个世界接近容量上限，请先导出；没有截断历史');
        const body = {
            message: 'Shared world: ' + id + ' revision ' + world.revision,
            content: utf8Base64(json), branch: this.branch,
        };
        if (expected !== null) body.sha = expected;
        const result = await this.request(this.path(id), { ...options, method: 'PUT', body });
        assert(result?.content?.sha, 'REMOTE_FORMAT', 'GitHub 未返回写入版本，不能标记同步成功');
        return { world: copy(world), token: result.content.sha };
    }
}
