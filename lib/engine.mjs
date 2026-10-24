/**
 * 消息处理引擎：NapCat 插件模式（index.mjs）与 OneBot 11 客户端模式（client.mjs）共用。
 *
 * 流程：过滤事件 → 关键词匹配 → 冷却检查 → 请求 mcstatus-api → 组装消息段 → 交给发送适配器。
 */

import { buildStatusUrl, fetchStatusImage } from './api.mjs';
import { isGroupAllowed } from './config.mjs';
import { getPlainText, matchRule } from './rules.mjs';

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig  读取当前配置
 * @param {() => object[]} deps.getRules 读取当前规则列表
 * @param {{ info: Function, warn: Function, error: Function }} deps.logger 日志
 */
export function createEngine({ getConfig, getRules, logger }) {
  /** 冷却记录：`会话:规则id` → 过期时间戳 */
  const cooldown = new Map();

  /** 调试日志（配置里开 debug 才输出） */
  function debugLog(config, ...args) {
    if (!config?.debug) return;
    try {
      logger.info('[debug]', ...args);
    } catch {
      // 日志失败不影响主流程
    }
  }

  /** 冷却表过大时清理已过期项 */
  function pruneCooldown(now) {
    if (cooldown.size < 500) return;
    for (const [key, expireAt] of cooldown) {
      if (expireAt <= now) cooldown.delete(key);
    }
  }

  /**
   * 处理一条 OneBot 消息事件（插件事件与客户端事件字段一致）。
   * @param {object} event
   * @param {(event: object, message: object[]) => Promise<void>} sendMessage 发送适配器
   */
  async function handleMessage(event, sendMessage) {
    if (!event || event.post_type !== 'message') return;

    const config = getConfig();
    if (!config.enabled) return;

    const isGroup = event.message_type === 'group';
    const isPrivate = event.message_type === 'private';
    if (!isGroup && !isPrivate) return;
    if (isPrivate && !config.allowPrivate) return;
    if (isGroup && !isGroupAllowed(config, event.group_id)) return;

    const text = getPlainText(event);
    if (!text) return;

    const rule = getRules().find((item) => item.enabled && matchRule(item, text));
    if (!rule) return;

    // 冷却：同一会话 + 同一规则，防止刷屏
    const sessionId = isGroup ? `g:${event.group_id}` : `u:${event.user_id}`;
    const cooldownSeconds = rule.cooldownSeconds ?? config.cooldownSeconds;
    const cooldownKey = `${sessionId}:${rule.id}`;
    if (cooldownSeconds > 0) {
      const now = Date.now();
      if ((cooldown.get(cooldownKey) ?? 0) > now) {
        debugLog(config, `冷却中，忽略关键词「${rule.keywords[0]}」（${sessionId}）`);
        return;
      }
      cooldown.set(cooldownKey, now + cooldownSeconds * 1000);
      pruneCooldown(now);
    }

    // 单条规则可单独指定 API 地址，未指定则用全局配置
    const url = buildStatusUrl(rule.apiBaseUrl || config.apiBaseUrl, rule);
    debugLog(config, `命中关键词「${rule.keywords[0]}」→ ${url}`);

    const prefix = rule.beforeText
      ? [{ type: 'text', data: { text: rule.beforeText } }]
      : [];

    if (config.sendMode === 'url') {
      // 直接把图片地址交给 OneBot 端拉取
      await sendMessage(event, [...prefix, { type: 'image', data: { file: url } }]);
      return;
    }

    // 默认：自己请求图片，失败时回复文字原因
    try {
      const { buffer } = await fetchStatusImage(url, config.requestTimeoutMs);
      await sendMessage(event, [
        ...prefix,
        { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } },
      ]);
    } catch (error) {
      const reason = error?.message || String(error);
      logger.warn(`查询失败（${url}）：${reason}`);
      await sendMessage(event, [{ type: 'text', data: { text: `服务器状态查询失败：${reason}` } }]);
    }
  }

  return { handleMessage };
}
