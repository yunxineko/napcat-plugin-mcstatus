/**
 * 关键词规则（rules.json）的解析、校验、热加载与匹配。
 *
 * 规则文件是 JSONC 风格：允许 // 与 注释、尾随逗号，方便在文件里写说明。
 * 插件每次收到消息时用「mtime + 文件大小」判断文件是否变化，变化即重新解析，
 * 因此用户改完 rules.json 保存后立即生效，无需重启 NapCat。
 */

import fs from 'node:fs';

import { normalizeApiBaseUrl } from './config.mjs';

/** endpoint 字段 → mcstatus-api 路径 */
export const ENDPOINTS = Object.freeze({
  banner: '/api/banner.png',
  overview: '/api/overview.png',
});

const MATCH_MODES = new Set(['exact', 'contains', 'regex']);

const KNOWN_RULE_KEYS = new Set([
  'keyword',
  'keywords',
  'apiBaseUrl',
  'endpoint',
  'match',
  'params',
  'servers',
  'beforeText',
  'cooldownSeconds',
  'enabled',
  'note',
]);

/** 去掉 JSONC 里的 // 行注释与 块注释（字符串内部的不动） */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === '\\') {
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }

  return out;
}

/** 去掉尾随逗号（,] 或 ,}），字符串内部的不动 */
export function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  let lastCommaIndex = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      out += char;
      if (char === '\\') {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      lastCommaIndex = out.length;
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      if (lastCommaIndex >= 0 && /^\s*$/.test(out.slice(lastCommaIndex + 1))) {
        out = out.slice(0, lastCommaIndex) + out.slice(lastCommaIndex + 1);
      }
      lastCommaIndex = -1;
      out += char;
      continue;
    }
    out += char;
  }

  return out;
}

/** 解析 JSONC 文本（注释 + 尾随逗号） */
export function parseJsonc(text) {
  const withoutBom = String(text ?? '').replace(/^\uFEFF/, '');
  return JSON.parse(removeTrailingCommas(stripJsonComments(withoutBom)));
}

/** 归一化 endpoint：接受 banner / banner.png / /api/banner.png 等写法 */
function normalizeEndpoint(value) {
  if (value === undefined || value === null || value === '') return 'banner';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\/?api\//, '')
    .replace(/\.png$/, '');
}

/**
 * 校验并归一化单条规则。
 * @returns {{ rule: object } | { error: string }} 校验通过返回 { rule }，否则 { error }
 */
export function normalizeRule(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `第 ${index + 1} 条规则不是对象` };
  }

  const errors = [];
  const warnings = [];

  // 关键词（字符串或字符串数组）
  const rawKeywords = raw.keyword ?? raw.keywords;
  const keywords = (Array.isArray(rawKeywords) ? rawKeywords : [rawKeywords])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  if (keywords.length === 0) errors.push('缺少 keyword（触发关键词，字符串或数组）');

  // 端点
  const endpoint = normalizeEndpoint(raw.endpoint);
  if (!ENDPOINTS[endpoint]) {
    errors.push(`endpoint "${raw.endpoint}" 无效（可用：banner / overview）`);
  }

  // 匹配模式
  const match = raw.match === undefined ? 'exact' : String(raw.match).trim().toLowerCase();
  if (!MATCH_MODES.has(match)) {
    errors.push(`match "${raw.match}" 无效（可用：exact / contains / regex）`);
  }

  // 请求参数（直接透传给 mcstatus-api），支持两种写法：
  //   - 对象：{ "host": "play.example.com", "theme": "midnight" }
  //   - 查询串："?host=play.example.com&theme=midnight&layout=stack"（原样跟在地址后面）
  const params = {};
  let paramsRaw;
  if (raw.params !== undefined) {
    if (typeof raw.params === 'string') {
      paramsRaw = raw.params.trim().replace(/^\?+/, '');
      if (!paramsRaw) paramsRaw = undefined;
    } else if (typeof raw.params !== 'object' || raw.params === null || Array.isArray(raw.params)) {
      errors.push(
        'params 必须是对象（键值对）或字符串（查询串，如 "?host=play.example.com&theme=midnight"）',
      );
    } else {
      for (const [key, value] of Object.entries(raw.params)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
          warnings.push(`参数名 "${key}" 含特殊字符，已忽略`);
          continue;
        }
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          params[key] = value;
        } else {
          warnings.push(`参数 "${key}" 的值不是字符串/数字/布尔，已忽略`);
        }
      }
    }
  }
  // 便利写法：overview 规则可以把服务器列表直接写在 rules[i].servers
  if (
    paramsRaw === undefined &&
    typeof raw.servers === 'string' &&
    raw.servers.trim() &&
    params.servers === undefined
  ) {
    params.servers = raw.servers.trim();
  }

  // 可选：这条规则单独使用的 API 地址（不写则用全局配置里的地址）
  let apiBaseUrl;
  if (raw.apiBaseUrl !== undefined) {
    if (typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim()) {
      apiBaseUrl = normalizeApiBaseUrl(raw.apiBaseUrl);
    } else {
      warnings.push('apiBaseUrl 应为非空字符串，已改用全局地址');
    }
  }

  const beforeText = typeof raw.beforeText === 'string' && raw.beforeText ? raw.beforeText : undefined;

  let cooldownSeconds;
  if (raw.cooldownSeconds !== undefined) {
    if (typeof raw.cooldownSeconds === 'number' && Number.isFinite(raw.cooldownSeconds) && raw.cooldownSeconds >= 0) {
      cooldownSeconds = raw.cooldownSeconds;
    } else {
      warnings.push('cooldownSeconds 无效，已改用全局冷却时间');
    }
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
    else warnings.push('enabled 应写 true / false，已按 true 处理');
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_RULE_KEYS.has(key)) warnings.push(`未知字段 "${key}"（已忽略）`);
  }

  if (errors.length > 0) {
    return { error: `第 ${index + 1} 条规则无效：${errors.join('；')}` };
  }

  return {
    rule: {
      id: index,
      keywords,
      endpoint,
      match,
      apiBaseUrl,
      params,
      paramsRaw,
      beforeText,
      cooldownSeconds,
      enabled,
    },
    warnings: warnings.map((item) => `第 ${index + 1} 条规则：${item}`),
  };
}

/**
 * 解析整个规则文件。
 * @returns {{ rules: object[], errors: string[], warnings: string[] }}
 */
export function parseRules(text) {
  let data;
  try {
    data = parseJsonc(text);
  } catch (error) {
    return { rules: [], errors: [`rules.json 不是合法的 JSON：${error?.message || error}`], warnings: [] };
  }

  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? data.rules : undefined;
  if (!Array.isArray(list)) {
    return {
      rules: [],
      errors: ['rules.json 顶层应为 { "rules": [...] } 或直接是数组'],
      warnings: [],
    };
  }

  const rules = [];
  const errors = [];
  const warnings = [];

  list.forEach((raw, index) => {
    const result = normalizeRule(raw, index);
    if (result.error) {
      errors.push(result.error);
      return;
    }
    rules.push(result.rule);
    warnings.push(...result.warnings);
  });

  // 重新编号，保证热加载前后冷却 key 稳定
  rules.forEach((rule, index) => {
    rule.id = index;
  });

  return { rules, errors, warnings };
}

/**
 * 创建规则存储器：每次 getRules() 都检查文件是否有变化，有变化立即重新解析。
 */
export function createRulesStore(filePath, logger) {
  let lastSignature = null;
  let cache = { rules: [], errors: [], warnings: [] };

  /** 返回解析结果（有效的规则 + 错误/警告信息） */
  function getRules() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (lastSignature !== 'missing') {
        lastSignature = 'missing';
        cache = { rules: [], errors: [`规则文件不存在：${filePath}`], warnings: [] };
        logger?.warn?.(`未找到 ${filePath}，插件不会响应任何关键词（请创建 rules.json）`);
      }
      return cache;
    }

    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature === lastSignature) return cache;
    lastSignature = signature;

    try {
      const parsed = parseRules(fs.readFileSync(filePath, 'utf8'));
      cache = parsed;
      for (const warning of parsed.warnings) logger?.warn?.(warning);
      for (const error of parsed.errors) logger?.error?.(error);
      if (parsed.errors.length === 0) {
        logger?.info?.(`已加载 ${parsed.rules.length} 条关键词规则（${filePath}）`);
      }
    } catch (error) {
      // 读取失败：保留上一份规则，避免影响已生效的配置
      logger?.error?.(`读取 ${filePath} 失败：${error?.message || error}`);
    }
    return cache;
  }

  return { filePath, getRules };
}

/** 从消息中取出用于匹配的纯文本（优先拼接消息段的文本，兜底用 raw_message 去 CQ 码） */
export function getPlainText(event) {
  const parts = [];
  if (Array.isArray(event?.message)) {
    for (const segment of event.message) {
      if (segment && segment.type === 'text' && segment.data && typeof segment.data.text === 'string') {
        parts.push(segment.data.text);
      }
    }
  }
  const text = parts.length > 0 ? parts.join('') : String(event?.raw_message ?? '');
  return text.replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/** 判断消息文本是否命中规则（多个关键词命中任意一个即可） */
export function matchRule(rule, text) {
  if (!rule || !text) return false;
  const haystack = text.toLowerCase();

  for (const keyword of rule.keywords) {
    if (rule.match === 'exact') {
      if (haystack === keyword.toLowerCase()) return true;
    } else if (rule.match === 'contains') {
      if (haystack.includes(keyword.toLowerCase())) return true;
    } else if (rule.match === 'regex') {
      try {
        if (new RegExp(keyword, 'i').test(text)) return true;
      } catch {
        // 非法正则：忽略该关键词
      }
    }
  }
  return false;
}
