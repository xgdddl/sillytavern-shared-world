import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelResponse } from '../src/streaming.js';
import { ModelRouter } from '../src/ai.js';

function streamResponse(raw, step = 3) {
    const bytes = new TextEncoder().encode(raw); let index = 0;
    return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(index, index + step)); index += step; } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('流式中文、CRLF及跨字节分片正确合并，不把推理或工具内容当正文', async () => {
    const raw = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"甲已"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"登基🙂"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    assert.equal(await readModelResponse(streamResponse(raw)), '甲已登基🙂');
});
test('声称支持流式但返回普通JSON的接口也能读取', async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: '有效正文' } }] }), { headers: { 'content-type': 'application/json' } });
    assert.equal(await readModelResponse(response), '有效正文');
});
test('流中返回错误或损坏数据不会被当作成功资料', async () => {
    await assert.rejects(readModelResponse(streamResponse('data: {"error":{"message":"bad"}}\n\n')), /模型返回错误/);
    await assert.rejects(readModelResponse(streamResponse('data: not-json\n\n')), /损坏/);
});
test('酒馆自定义流式接口复用本地后端，不改全局配置和现有聊天', async () => {
    const settings = { chat_completion_source: 'custom', stream_openai: true, custom_model: 'fixture', custom_url: 'https://example.invalid/v1', openai_max_tokens: 2000 };
    const original = JSON.stringify(settings); let sent;
    const router = new ModelRouter({ getContext: () => ({ mainApi: 'openai', chatCompletionSettings: settings, getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture-only' }) }), getSettings: () => ({ models: {} }), getSecret: () => '', fetchImpl: async (url, options) => {
        sent = { url, body: JSON.parse(options.body) };
        return streamResponse('data: {"choices":[{"delta":{"content":"result"}}]}\n\ndata: [DONE]\n\n');
    } });
    assert.equal(await router.generate('summary', '虚构资料'), 'result');
    assert.equal(sent.url, '/api/backends/chat-completions/generate'); assert.equal(sent.body.stream, true); assert.equal(sent.body.max_tokens, 2000);
    assert.equal(JSON.stringify(settings), original); assert.equal(router.depth, 0);
});
