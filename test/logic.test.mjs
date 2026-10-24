/**
 * 纯逻辑单元测试（不依赖 NapCat、不访问网络）：
 *   node --test test/logic.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  isGroupAllowed,
  parseGroupWhitelist,
  sanitizeConfig,
} from '../lib/config.mjs';
import {
  getPlainText,
  matchRule,
  parseJsonc,
  parseRules,
  removeTrailingCommas,
  stripJsonComments,
} from '../lib/rules.mjs';
import { buildStatusUrl, isPng } from '../lib/api.mjs';

// ==================== JSONC 解析 ====================

test('stripJsonComments 不破坏字符串里的斜杠', () => {
  const raw = '{ "url": "http://a//b", /* 块注释 */ "x": 1 } // 行注释';
  const out = stripJsonComments(raw);
  assert.ok(out.includes('"http://a//b"'));
  assert.ok(!out.includes('块注释'));
  assert.ok(!out.includes('行注释'));
});

test('removeTrailingCommas 只删除尾随逗号', () => {
  assert.equal(removeTrailingCommas('[1,2,]'), '[1,2]');
  assert.equal(removeTrailingCommas('[1,2]'), '[1,2]');
  assert.equal(removeTrailingCommas('{"a":"x,]",}'), '{"a":"x,]"}');
});

test('parseJsonc 支持注释与尾随逗号', () => {
  const raw = `{
    // 规则说明
    "rules": [
      { "keyword": "a", },
    ],
  }`;
  assert.deepEqual(parseJsonc(raw), { rules: [{ keyword: 'a' }] });
});

// ==================== 规则解析 ====================

test('parseRules 解析对象形式并对齐默认值', () => {
  const { rules, errors } = parseRules(
    JSON.stringify({
      rules: [{ keyword: ['查服', ' mc状态 '], params: { host: 'play.example.com', port: 25565 } }],
    }),
  );
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].keywords, ['查服', 'mc状态']);
  assert.equal(rules[0].endpoint, 'banner');
  assert.equal(rules[0].match, 'exact');
  assert.equal(rules[0].enabled, true);
  assert.equal(rules[0].apiBaseUrl, undefined);
  assert.deepEqual(rules[0].params, { host: 'play.example.com', port: 25565 });
});

test('parseRules 跳过非法规则并给出错误', () => {
  const { rules, errors } = parseRules(
    JSON.stringify({
      rules: [
        { keyword: 'ok', endpoint: 'banner' },
        { keyword: 'bad', endpoint: 'nope' },
        { endpoint: 'banner' },
        'not-an-object',
      ],
    }),
  );
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 3);
});

test('parseRules 支持裸数组形式', () => {
  const { rules, errors } = parseRules('[{"keyword":"查服","params":{"host":"a"}}]');
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].keywords[0], '查服');
});

test('规则可以单独指定 apiBaseUrl（覆盖全局地址）', () => {
  const { rules, errors } = parseRules(
    JSON.stringify({
      rules: [{ keyword: '查服', apiBaseUrl: 'other-host:2555/', params: { host: 'a' } }],
    }),
  );
  assert.deepEqual(errors, []);
  assert.equal(rules[0].apiBaseUrl, 'http://other-host:2555');
});

test('parseRules 对未知字段给出警告', () => {
  const { warnings } = parseRules(JSON.stringify({ rules: [{ keyword: 'a', parms: {} }] }));
  assert.ok(warnings.some((item) => item.includes('parms')));
});

// ==================== 关键词匹配 ====================

test('matchRule 支持 exact / contains / regex（大小写不敏感）', () => {
  assert.equal(matchRule({ keywords: ['查服'], match: 'exact' }, '查服'), true);
  assert.equal(matchRule({ keywords: ['查服'], match: 'exact' }, '查服一下'), false);
  assert.equal(matchRule({ keywords: ['MCSTATUS'], match: 'exact' }, 'mcstatus'), true);
  assert.equal(matchRule({ keywords: ['查服'], match: 'contains' }, '来查服吧'), true);
  assert.equal(matchRule({ keywords: ['^状态\\s+主服$'], match: 'regex' }, '状态 主服'), true);
  assert.equal(matchRule({ keywords: ['['], match: 'regex' }, '[ 非法正则'), false);
});

test('getPlainText 拼接文本段并清理 CQ 码', () => {
  assert.equal(
    getPlainText({
      message: [
        { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: ' 查服 ' } },
      ],
      raw_message: '[CQ:at,qq=123] 查服',
    }),
    '查服',
  );
  assert.equal(getPlainText({ raw_message: '[CQ:at,qq=1] mc状态' }), 'mc状态');
  assert.equal(getPlainText({}), '');
});

// ==================== URL 拼接 ====================

test('buildStatusUrl 拼接参数并跳过空值', () => {
  const url = buildStatusUrl('http://127.0.0.1:3002/', {
    endpoint: 'banner',
    params: {
      host: 'play.example.com',
      port: 25565,
      queryPort: 25566,
      name: '主服',
      refresh: true,
      skip: '',
      nothing: null,
    },
  });
  assert.ok(url.startsWith('http://127.0.0.1:3002/api/banner.png?'));
  assert.ok(url.includes('host=play.example.com'));
  assert.ok(url.includes('port=25565'));
  assert.ok(url.includes('queryPort=25566'));
  assert.ok(url.includes(`name=${encodeURIComponent('主服')}`));
  assert.ok(url.includes('refresh=1'));
  assert.ok(!url.includes('skip='));
  assert.ok(!url.includes('nothing'));
});

test('buildStatusUrl 支持 overview 端点', () => {
  const url = buildStatusUrl('http://x:3001', {
    endpoint: 'overview',
    params: { servers: 'a@b:1:2' },
  });
  assert.ok(url.startsWith('http://x:3001/api/overview.png?'));
  assert.ok(url.includes(`servers=${encodeURIComponent('a@b:1:2')}`));
});

test('buildStatusUrl 支持完整接口地址：参数直接跟在后面，不再追加端点', () => {
  const url = buildStatusUrl('http://127.0.0.1:3002/api/banner.png', {
    endpoint: 'banner',
    params: { host: 'play.example.com' },
  });
  assert.equal(url, 'http://127.0.0.1:3002/api/banner.png?host=play.example.com');
});

test('buildStatusUrl 支持查询串形式的 params', () => {
  const url = buildStatusUrl('http://h:3001', {
    endpoint: 'banner',
    paramsRaw: '?host=play.example.com&theme=midnight&layout=stack',
  });
  assert.equal(
    url,
    'http://h:3001/api/banner.png?host=play.example.com&theme=midnight&layout=stack',
  );
});

test('buildStatusUrl 地址里已有查询串时用 & 追加；只有查询串时把端点插到 ? 前', () => {
  assert.equal(
    buildStatusUrl('http://h:3001/api/banner.png?x=1', { endpoint: 'banner', params: { host: 'a.b' } }),
    'http://h:3001/api/banner.png?x=1&host=a.b',
  );
  assert.equal(
    buildStatusUrl('http://h:3001?x=1', { endpoint: 'banner', params: { host: 'a.b' } }),
    'http://h:3001/api/banner.png?x=1&host=a.b',
  );
});

test('parseRules 支持字符串形式的 params（查询串）', () => {
  const { rules, errors } = parseRules(
    JSON.stringify({ rules: [{ keyword: '查服', params: '?host=play.example.com&theme=midnight' }] }),
  );
  assert.deepEqual(errors, []);
  assert.equal(rules[0].paramsRaw, 'host=play.example.com&theme=midnight');
  assert.equal(
    buildStatusUrl('http://127.0.0.1:3002', rules[0]),
    'http://127.0.0.1:3002/api/banner.png?host=play.example.com&theme=midnight',
  );
});

// ==================== 配置清洗 ====================

test('sanitizeConfig 清洗非法配置', () => {
  const config = sanitizeConfig({
    enabled: 'yes',
    apiBaseUrl: '127.0.0.1:3002/',
    requestTimeoutMs: 999999999,
    cooldownSeconds: -5,
    allowPrivate: false,
    groupWhitelist: ['1', '2'],
    sendMode: 'wat',
    debug: true,
  });
  assert.equal(config.enabled, true); // 类型不对 → 默认值
  assert.equal(config.apiBaseUrl, 'http://127.0.0.1:3002');
  assert.equal(config.requestTimeoutMs, 120000);
  assert.equal(config.cooldownSeconds, 0);
  assert.equal(config.allowPrivate, false);
  assert.equal(config.groupWhitelist, '1,2');
  assert.equal(config.sendMode, 'base64');
  assert.equal(config.debug, true);
  assert.equal(sanitizeConfig(null).apiBaseUrl, DEFAULT_CONFIG.apiBaseUrl);
});

test('群白名单为空时全部放行，配置后只放行名单内', () => {
  assert.equal(isGroupAllowed({ groupWhitelist: '' }, 123), true);
  assert.deepEqual([...parseGroupWhitelist('1, 2，3;4')], ['1', '2', '3', '4']);
  assert.equal(isGroupAllowed({ groupWhitelist: '111, 222' }, 222), true);
  assert.equal(isGroupAllowed({ groupWhitelist: '111, 222' }, 333), false);
});

// ==================== PNG 校验 ====================

test('isPng 校验 PNG 文件头', () => {
  assert.equal(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(isPng(Buffer.from('{"error":1}')), false);
  assert.equal(isPng(Buffer.alloc(0)), false);
});
