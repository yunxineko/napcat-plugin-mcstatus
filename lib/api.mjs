/**
 * mcstatus-api 请求封装：拼接图片接口 URL、下载 PNG、错误归一化。
 *
 * mcstatus-api 的图片接口「永远返回图片」——离线、参数非法、渲染失败都会返回
 * 一张说明图（HTTP 200/400/500 但内容是 PNG）。因此这里只要拿到合法 PNG 就
 * 照常发送，只有网络故障 / 非图片响应才算失败。
 */

import { ENDPOINTS } from './rules.mjs';

/** 面向用户的请求错误（消息可直接发到聊天里） */
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 校验 PNG 文件头 */
export function isPng(buffer) {
  if (!buffer || buffer.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
}

/** 地址是否已经带了路径（带了就视为完整接口地址，不再追加 /api/xxx.png） */
function hasEndpointPath(base) {
  try {
    const pathname = new URL(base).pathname;
    return Boolean(pathname) && pathname !== '/';
  } catch {
    return false;
  }
}

/** 组装查询串：对象形式的参数 + 查询串形式的参数（查询串原样拼接） */
function buildQueryString(params, rawQuery) {
  const parts = [];

  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'boolean') query.set(key, value ? '1' : '0');
      else query.set(key, String(value));
    }
    const encoded = query.toString();
    if (encoded) parts.push(encoded);
  }

  if (typeof rawQuery === 'string') {
    const raw = rawQuery.replace(/^\?+/, '').trim();
    if (raw) parts.push(raw);
  }

  return parts.join('&');
}

/**
 * 根据规则拼出完整请求地址。
 *
 * 两种配置方式都支持：
 * 1. 地址是**基础地址**（如 http://127.0.0.1:3002）→ 按 endpoint 自动补端点：
 *    http://127.0.0.1:3002/api/banner.png?host=play.example.com
 * 2. 地址已带路径（如 http://127.0.0.1:3002/api/banner.png）→ 视为完整接口地址，
 *    参数直接以 ?host=... 跟在后面，不会再追加端点；地址里已有 ? 时用 & 追加。
 */
export function buildStatusUrl(apiBaseUrl, rule) {
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const endpoint = ENDPOINTS[rule?.endpoint] ?? ENDPOINTS.banner;

  let target;
  if (hasEndpointPath(base)) {
    target = base; // 完整接口地址：原样使用，参数直接跟在后面
  } else if (base.includes('?')) {
    target = base.replace('?', `${endpoint}?`); // 地址只带了查询串：端点插到 ? 前面
  } else {
    target = `${base}${endpoint}`;
  }

  const queryString = buildQueryString(rule?.params, rule?.paramsRaw);
  if (!queryString) return target;
  return `${target}${target.includes('?') ? '&' : '?'}${queryString}`;
}

/**
 * 下载状态图。
 * @returns {Promise<{ buffer: Buffer, status: number }>}
 * @throws {ApiError} 超时 / 连不上 / 返回的不是图片
 */
export async function fetchStatusImage(url, timeoutMs = 15000) {
  const ms = Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw new ApiError(`请求超时（${Math.round(ms / 1000)} 秒内没有响应）`);
      }
      const code = error?.cause?.code || error?.code;
      throw new ApiError(`无法连接 mcstatus-api（${code || error?.message || '网络错误'}）`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (isPng(buffer)) return { buffer, status: response.status };

    const snippet = buffer.toString('utf8', 0, 200).replace(/\s+/g, ' ').trim();
    throw new ApiError(`API 返回的不是 PNG 图片（HTTP ${response.status}${snippet ? `：${snippet}` : ''}）`);
  } finally {
    clearTimeout(timer);
  }
}
