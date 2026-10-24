/**
 * 插件配置：默认值、清洗、持久化、WebUI Schema。
 *
 * 配置由 NapCat 的 WebUI 管理：
 * - plugin_config_ui 导出 Schema（见 index.mjs），WebUI 据此生成配置面板
 * - plugin_get_config / plugin_set_config 负责读写，写入 ctx.configPath（JSON 文件）
 *
 * 关键词规则不存在这里，而是插件目录下的 rules.json（见 lib/rules.mjs）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 默认配置（apiBaseUrl 为实际部署的 mcstatus-api 地址） */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  apiBaseUrl: 'http://127.0.0.1:3002',
  sendMode: 'base64',
  requestTimeoutMs: 15000,
  cooldownSeconds: 5,
  allowPrivate: true,
  groupWhitelist: '',
  debug: false,
});

/** 把用户输入的地址规整成 http(s)://host[:port]（去掉末尾斜杠，缺协议自动补 http://） */
export function normalizeApiBaseUrl(value) {
  let url = String(value ?? '').trim();
  if (!url) return DEFAULT_CONFIG.apiBaseUrl;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 把来自磁盘/WebUI 的任意配置清洗成合法配置（类型不对的字段回退默认值） */
export function sanitizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim()) {
    out.apiBaseUrl = normalizeApiBaseUrl(raw.apiBaseUrl);
  }
  if (raw.requestTimeoutMs !== undefined) {
    out.requestTimeoutMs = clampNumber(raw.requestTimeoutMs, 1000, 120000, out.requestTimeoutMs);
  }
  if (raw.cooldownSeconds !== undefined) {
    out.cooldownSeconds = clampNumber(raw.cooldownSeconds, 0, 3600, out.cooldownSeconds);
  }
  if (typeof raw.allowPrivate === 'boolean') out.allowPrivate = raw.allowPrivate;
  if (typeof raw.groupWhitelist === 'string') {
    out.groupWhitelist = raw.groupWhitelist;
  } else if (Array.isArray(raw.groupWhitelist)) {
    out.groupWhitelist = raw.groupWhitelist.map(String).join(',');
  }
  if (raw.sendMode === 'url' || raw.sendMode === 'base64') out.sendMode = raw.sendMode;
  if (typeof raw.debug === 'boolean') out.debug = raw.debug;

  return out;
}

/** 解析群白名单文本（逗号/空格/分号/中文逗号分隔）为 Set */
export function parseGroupWhitelist(text) {
  return new Set(
    String(text ?? '')
      .split(/[\s,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/** 未配置白名单 → 所有群都响应；配置了 → 仅白名单内的群响应 */
export function isGroupAllowed(config, groupId) {
  const whitelist = parseGroupWhitelist(config.groupWhitelist);
  if (whitelist.size === 0) return true;
  return whitelist.has(String(groupId));
}

/** 从 ctx.configPath 读取配置；不存在或损坏时返回默认配置 */
export function loadConfig(configPath, logger) {
  try {
    if (configPath && fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return sanitizeConfig(raw);
    }
  } catch (error) {
    logger?.warn?.(`读取插件配置失败，使用默认配置：${error?.message || error}`);
  }
  return { ...DEFAULT_CONFIG };
}

/** 把配置写回 ctx.configPath */
export function saveConfig(configPath, config, logger) {
  if (!configPath) return false;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger?.error?.(`保存插件配置失败：${error?.message || error}`);
    return false;
  }
}

/** 客户端模式（client.mjs）默认配置：比插件模式多出连接 OneBot 的几项 */
export const DEFAULT_CLIENT_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  websocketUrl: 'ws://127.0.0.1:3000',
  accessToken: '',
  reconnectSeconds: 5,
});

/** 清洗客户端模式配置（先按插件配置清洗，再处理连接相关字段） */
export function sanitizeClientConfig(raw) {
  const out = {
    ...sanitizeConfig(raw),
    websocketUrl: DEFAULT_CLIENT_CONFIG.websocketUrl,
    accessToken: '',
    reconnectSeconds: DEFAULT_CLIENT_CONFIG.reconnectSeconds,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  if (typeof raw.websocketUrl === 'string' && raw.websocketUrl.trim()) {
    let url = raw.websocketUrl.trim();
    if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
    out.websocketUrl = url;
  }
  if (typeof raw.accessToken === 'string') out.accessToken = raw.accessToken.trim();
  if (raw.reconnectSeconds !== undefined) {
    const seconds = Number(raw.reconnectSeconds);
    if (Number.isFinite(seconds)) {
      out.reconnectSeconds = Math.min(300, Math.max(1, Math.round(seconds)));
    }
  }
  return out;
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (char) => map[char]);
}

/** 构建 NapCat WebUI 配置面板的 Schema */
export function buildConfigSchema(rulesPath) {
  const tip = [
    '<div style="padding:12px 16px;margin-bottom:16px;border-radius:10px;',
    'background:rgba(251,114,153,0.12);border:1px solid rgba(251,114,153,0.35);',
    'font-size:12px;line-height:1.9">',
    '<b>关键词规则</b>：插件按 <code>rules.json</code> 中的规则响应关键词，',
    '每个关键词可以配置自己的请求参数（host、port、queryPort、name、theme…），',
    '也可以给单条规则写 <code>apiBaseUrl</code> 单独指定 API 地址。<br>',
    `规则文件：<code>${escapeHtml(rulesPath || '（插件目录）/rules.json')}</code>`,
    '（修改保存后自动热加载，无需重启）<br>',
    '示例：<code>{"keyword":"查服","endpoint":"banner","params":{"host":"play.example.com","port":25565,"queryPort":25566}}</code>',
    '</div>',
  ].join('');

  return [
    {
      key: 'enabled',
      type: 'boolean',
      label: '启用插件',
      default: true,
      description: '关闭后不再响应任何关键词',
    },
    {
      key: 'apiBaseUrl',
      type: 'string',
      label: 'mcstatus-api 地址（全局默认）',
      default: DEFAULT_CONFIG.apiBaseUrl,
      description: '可自定义为任意地址（默认 http://127.0.0.1:3002）；单条关键词规则也能用 apiBaseUrl 字段单独覆盖',
    },
    {
      key: 'sendMode',
      type: 'select',
      label: '图片发送方式',
      options: [
        { label: 'base64 直传（推荐，带错误提示）', value: 'base64' },
        { label: 'URL 直链（由 NapCat 拉取）', value: 'url' },
      ],
      default: 'base64',
      description: 'base64：插件先请求图片再发送，失败时回复文字原因；url：直接把图片地址交给 NapCat',
    },
    {
      key: 'requestTimeoutMs',
      type: 'number',
      label: '请求超时（毫秒）',
      default: 15000,
      description: '插件等待 API 返回图片的最长时间，范围 1000-120000',
    },
    {
      key: 'cooldownSeconds',
      type: 'number',
      label: '冷却时间（秒）',
      default: 5,
      description: '同一会话、同一关键词的触发间隔；0 表示不限制',
    },
    {
      key: 'allowPrivate',
      type: 'boolean',
      label: '响应私聊',
      default: true,
      description: '关闭后只在群里响应关键词',
    },
    {
      key: 'groupWhitelist',
      type: 'string',
      label: '群白名单',
      default: '',
      description: '逗号/空格分隔的群号；留空 = 所有群都响应',
    },
    {
      key: 'debug',
      type: 'boolean',
      label: '调试日志',
      default: false,
      description: '在 NapCat 日志中输出关键词匹配与请求详情',
    },
    {
      key: '_html_rules_tip',
      type: 'html',
      label: '',
      default: tip,
    },
  ];
}
