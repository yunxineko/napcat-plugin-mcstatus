/**
 * 冒烟测试：用本地假 mcstatus-api 验证「拼请求地址 → 下载 PNG」整条链路（不依赖 NapCat）：
 *   node test/smoke.mjs
 */

import http from 'node:http';
import assert from 'node:assert/strict';

import { buildStatusUrl, fetchStatusImage } from '../lib/api.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BODY = Buffer.concat([PNG_HEADER, Buffer.from('...fake png payload...')]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/banner.png') {
    // 校验参数确实拼到了请求上
    assert.equal(url.searchParams.get('host'), 'play.example.com');
    assert.equal(url.searchParams.get('port'), '25565');
    assert.equal(url.searchParams.get('queryPort'), '25566');
    assert.equal(url.searchParams.get('name'), '主服');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(BODY);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

try {
  const url = buildStatusUrl(`http://127.0.0.1:${port}`, {
    endpoint: 'banner',
    params: { host: 'play.example.com', port: 25565, queryPort: 25566, name: '主服' },
  });
  console.log('请求地址：', url);

  const { buffer, status } = await fetchStatusImage(url, 5000);
  assert.equal(status, 200);
  assert.equal(Buffer.compare(buffer, BODY), 0);
  console.log(`✅ banner 链路正常：拿到 PNG ${buffer.length} 字节`);

  try {
    await fetchStatusImage(`http://127.0.0.1:${port}/api/nope.png`, 5000);
    throw new Error('预期应抛出 ApiError');
  } catch (error) {
    assert.match(error.message, /不是 PNG 图片/);
    console.log('✅ 非图片响应被正确识别：', error.message);
  }
} finally {
  server.close();
}
