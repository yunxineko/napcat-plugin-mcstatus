/**
 * 引擎集成测试（本地假 mcstatus-api + 假发送器）：
 * 验证「关键词 → 请求图片 → 组装消息」「冷却」「群白名单」「失败回复文字」。
 *   node --test test/engine.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createEngine } from '../lib/engine.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png'),
]);

/** 启动一个假 mcstatus-api（/api/*.png 一律返回上面这张图） */
function startFakeApi() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const RULE = {
  id: 0,
  keywords: ['查服'],
  endpoint: 'banner',
  match: 'exact',
  params: { host: 'play.example.com' },
  enabled: true,
};

function makeConfig(port, overrides = {}) {
  return {
    enabled: true,
    apiBaseUrl: `http://127.0.0.1:${port}`,
    sendMode: 'base64',
    requestTimeoutMs: 5000,
    cooldownSeconds: 0,
    allowPrivate: true,
    groupWhitelist: '',
    debug: false,
    ...overrides,
  };
}

function makeEngine(config, rules = [RULE]) {
  const logger = { info() {}, warn() {}, error() {} };
  return createEngine({ getConfig: () => config, getRules: () => rules, logger });
}

function groupEvent(text, groupId = 123) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: 456,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  };
}

test('命中关键词：请求图片并发送 base64 图', async (t) => {
  const { server, port } = await startFakeApi();
  t.after(() => closeServer(server));

  const engine = makeEngine(makeConfig(port));
  const sent = [];
  await engine.handleMessage(groupEvent('查服'), async (_event, message) => {
    sent.push(message);
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].type, 'image');
  assert.ok(sent[0][0].data.file.startsWith('base64://'));
});

test('冷却时间内不重复触发，换会话可重新触发', async (t) => {
  const { server, port } = await startFakeApi();
  t.after(() => closeServer(server));

  const engine = makeEngine(makeConfig(port, { cooldownSeconds: 60 }));
  const sent = [];
  const send = async (_event, message) => void sent.push(message);

  await engine.handleMessage(groupEvent('查服'), send);
  await engine.handleMessage(groupEvent('查服'), send); // 冷却中 → 忽略
  assert.equal(sent.length, 1);

  await engine.handleMessage(groupEvent('查服', 999), send); // 另一个群 → 可以
  assert.equal(sent.length, 2);
});

test('群白名单与私聊开关生效', async (t) => {
  const { server, port } = await startFakeApi();
  t.after(() => closeServer(server));

  const config = makeConfig(port, { groupWhitelist: '111' });
  const engine = makeEngine(config);
  const sent = [];
  const send = async (_event, message) => void sent.push(message);

  await engine.handleMessage(groupEvent('查服', 222), send); // 不在白名单 → 忽略
  await engine.handleMessage(groupEvent('查服', 111), send); // 在白名单 → 发送
  assert.equal(sent.length, 1);

  config.allowPrivate = false;
  await engine.handleMessage(
    {
      post_type: 'message',
      message_type: 'private',
      user_id: 9,
      message: [{ type: 'text', data: { text: '查服' } }],
      raw_message: '查服',
    },
    send,
  );
  assert.equal(sent.length, 1);
});

test('非消息事件与未命中关键词不发送', async () => {
  const engine = makeEngine(makeConfig(1));
  const sent = [];
  const send = async (_event, message) => void sent.push(message);

  await engine.handleMessage({ post_type: 'meta_event' }, send);
  await engine.handleMessage(groupEvent('无关内容'), send);
  assert.equal(sent.length, 0);
});

test('API 不可用时回复文字原因', async (t) => {
  const { server, port } = await startFakeApi();
  await closeServer(server); // 端口刚关闭 → 连接被拒绝

  const engine = makeEngine(makeConfig(port));
  const sent = [];
  await engine.handleMessage(groupEvent('查服'), async (_event, message) => {
    sent.push(message);
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].type, 'text');
  assert.match(sent[0][0].data.text, /查询失败/);
});
