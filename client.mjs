/**
 * OneBot 11 客户端模式（不依赖 NapCat 插件系统）
 *
 * 为什么需要它：新版 NapCat（约 v4.18.11 起）的插件加载器只放行官方白名单插件，
 * 第三方插件会被直接拒绝、在 WebUI 里完全不可见。此时把本项目当作一个独立的
 * OneBot 客户端进程运行即可（NapCat 的 OneBot 功能不受插件白名单影响）：
 *
 *   NapCat（OneBot WebSocket 服务器）  ⇄  client.mjs  →  mcstatus-api
 *
 * 运行：node client.mjs
 * 配置：client.config.json（不存在会自动生成；支持 // 注释）
 * 规则：rules.json（与插件模式共用，保存即热加载）
 *
 * 要求：Node.js ≥ 21（使用内置 WebSocket），建议 22+
 *
 * NapCat 侧准备：WebUI → 网络配置 → 新建 → WebSocket 服务器，
 * 填好 host/port（例如 127.0.0.1:3000），令牌可选；保存启用后把地址填进 client.config.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CLIENT_CONFIG, sanitizeClientConfig } from './lib/config.mjs';
import { createRulesStore, parseJsonc } from './lib/rules.mjs';
import { createEngine } from './lib/engine.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(MODULE_DIR, 'client.config.json');
const RULES_PATH = path.join(MODULE_DIR, 'rules.json');

const logger = {
  info: (...args) => console.log('[mcstatus]', ...args),
  warn: (...args) => console.warn('[mcstatus]', ...args),
  error: (...args) => console.error('[mcstatus]', ...args),
};

if (typeof WebSocket === 'undefined') {
  logger.error(`需要 Node.js 21+（内置 WebSocket），当前版本 ${process.version}`);
  process.exit(1);
}

// ==================== 配置 ====================

function loadClientConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return sanitizeClientConfig(parseJsonc(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (error) {
      logger.warn(`读取 ${CONFIG_PATH} 失败，使用默认配置：${error?.message || error}`);
      return { ...DEFAULT_CLIENT_CONFIG };
    }
  }

  // 首次运行：生成一份默认配置，方便直接改
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CLIENT_CONFIG, null, 2)}\n`, 'utf8');
    logger.info(`已生成默认配置：${CONFIG_PATH}（按需修改后重启）`);
  } catch {
    // 写不了就算了，用内存里的默认配置继续
  }
  return { ...DEFAULT_CLIENT_CONFIG };
}

const config = loadClientConfig();

// ==================== 规则与引擎 ====================

const rulesStore = createRulesStore(RULES_PATH, logger);
rulesStore.getRules(); // 预加载，文件不存在 / 有错误会在这里打日志

const engine = createEngine({
  getConfig: () => config,
  getRules: () => rulesStore.getRules().rules,
  logger,
});

// ==================== OneBot WebSocket ====================

let socket = null;
let reconnectTimer = null;
let stopped = false;

/** 按 NapCat 的约定拼接连接地址（令牌支持 ?access_token= 查询参数） */
function buildConnectUrl() {
  if (!config.accessToken) return config.websocketUrl;
  const sep = config.websocketUrl.includes('?') ? '&' : '?';
  return `${config.websocketUrl}${sep}access_token=${encodeURIComponent(config.accessToken)}`;
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, Math.max(1, config.reconnectSeconds) * 1000);
  logger.warn(`${config.reconnectSeconds} 秒后重连…`);
}

function connect() {
  logger.info(
    `正在连接 OneBot WebSocket：${config.websocketUrl}${config.accessToken ? '（已带访问令牌）' : ''}`,
  );
  socket = new WebSocket(buildConnectUrl());

  socket.addEventListener('open', () => {
    logger.info('已连接，等待消息（在群里发送关键词试试）');
  });

  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return; // 忽略非 JSON 帧
    }
    handleOneBotEvent(data).catch((error) => {
      logger.error('处理事件出错：', error?.message || error);
    });
  });

  socket.addEventListener('close', (event) => {
    socket = null;
    if (stopped) return;
    logger.warn(`连接已断开（code=${event.code}）`);
    scheduleReconnect();
  });

  socket.addEventListener('error', (event) => {
    logger.warn('WebSocket 连接出错：', event?.message || '连接失败');
    // 注意：某些 Node 版本在握手失败时只触发 error、不触发 close，
    // 这里也安排一次重连（scheduleReconnect 是幂等的，不会重复安排）
    if (!stopped) scheduleReconnect();
  });
}

async function handleOneBotEvent(data) {
  if (data?.post_type === 'message') {
    await engine.handleMessage(data, sendViaOneBot);
    return;
  }
  if (config.debug && data?.post_type) {
    const type = data.meta_event_type || data.notice_type || data.request_type || '';
    logger.info(`[debug] 收到事件：${data.post_type}${type ? `/${type}` : ''}`);
  }
}

/** 发送适配器：通过 OneBot 的 send_msg 动作发出（群 / 私聊自动区分） */
async function sendViaOneBot(event, message) {
  const params =
    event.message_type === 'group'
      ? { message, message_type: 'group', group_id: String(event.group_id) }
      : { message, message_type: 'private', user_id: String(event.user_id) };
  try {
    socket?.send(JSON.stringify({ action: 'send_msg', params, echo: `mcstatus-${Date.now()}` }));
  } catch (error) {
    logger.warn('发送消息失败：', error?.message || error);
  }
}

// ==================== 启动 / 退出 ====================

function shutdown() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    socket?.close();
  } catch {
    // 忽略关闭异常
  }
  logger.info('已退出');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info(`mcstatus 客户端启动 | API: ${config.apiBaseUrl} | 规则: ${RULES_PATH}`);
connect();
