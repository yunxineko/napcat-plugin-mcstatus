/**
 * napcat-plugin-mcstatus —— 主入口
 *
 * 功能：机器人收到关键词（rules.json 中配置）后，向 mcstatus-api 发起请求，
 *       把返回的服务器状态图 / 多服一览图发送到当前会话。
 *
 * NapCat 插件生命周期：
 *   plugin_init             插件加载时调用（必选）
 *   plugin_onmessage        收到消息事件时调用
 *   plugin_cleanup          插件卸载 / 重载时调用
 *   plugin_config_ui        导出的 WebUI 配置 Schema（plugin_config_schema 同为兼容别名）
 *   plugin_get_config       读取配置（WebUI 打开配置面板时调用）
 *   plugin_set_config       保存配置（WebUI 保存时调用）
 *   plugin_on_config_change 单个配置项变更时调用
 *
 * 请求地址：全局默认取配置里的 apiBaseUrl（默认 http://127.0.0.1:3002，可自定义），
 *          单条规则可用 rules.json 里的 apiBaseUrl 字段单独覆盖。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  buildConfigSchema,
  loadConfig,
  saveConfig,
  sanitizeConfig,
} from './lib/config.mjs';
import { createRulesStore } from './lib/rules.mjs';
import { createEngine } from './lib/engine.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** WebUI 配置 Schema；plugin_init 时会替换成带 rules.json 实际路径的版本 */
export let plugin_config_ui = buildConfigSchema('');
/** 兼容别名（部分 NapCat 版本读取这个名字） */
export let plugin_config_schema = plugin_config_ui;

/** 插件运行时状态（plugin_init 后可用） */
let state = null;

// ==================== 生命周期 ====================

/** 插件初始化（必选）：加载配置与规则 */
export const plugin_init = async (ctx) => {
  try {
    const pluginDir = ctx.pluginPath || MODULE_DIR;
    const rulesPath = path.join(pluginDir, 'rules.json');

    state = {
      ctx,
      config: loadConfig(ctx.configPath, ctx.logger),
      rulesStore: createRulesStore(rulesPath, ctx.logger),
      engine: null,
    };
    // 消息处理逻辑与 OneBot 客户端模式（client.mjs）共用同一个引擎
    state.engine = createEngine({
      getConfig: () => state.config,
      getRules: () => state.rulesStore.getRules().rules,
      logger: ctx.logger,
    });

    // 用真实路径刷新 WebUI 配置面板里的提示
    plugin_config_ui = buildConfigSchema(rulesPath);
    plugin_config_schema = plugin_config_ui;

    // 预加载规则（文件不存在 / 有错误都会在这里打出日志）
    state.rulesStore.getRules();

    ctx.logger.info(`mcstatus 插件已加载 | API: ${state.config.apiBaseUrl} | 规则: ${rulesPath}`);
  } catch (error) {
    ctx.logger.error('mcstatus 插件初始化失败:', error);
  }
};

/** 收到消息：交给共用引擎（匹配关键词 → 请求图片 → 发送） */
export const plugin_onmessage = async (ctx, event) => {
  try {
    if (!state) return;
    await state.engine.handleMessage(event, (targetEvent, message) =>
      sendMessage(ctx, targetEvent, message),
    );
  } catch (error) {
    state?.ctx?.logger?.error('mcstatus 处理消息时出错:', error);
  }
};

/** 插件卸载 / 重载：释放状态 */
export const plugin_cleanup = async (ctx) => {
  state = null;
  ctx?.logger?.info('mcstatus 插件已卸载');
};

// ==================== 配置管理 ====================

/** 读取配置（WebUI 打开配置面板时调用） */
export const plugin_get_config = async () => (state ? { ...state.config } : { ...DEFAULT_CONFIG });

/** 保存配置（WebUI 保存时调用，写入 ctx.configPath） */
export const plugin_set_config = async (ctx, config) => {
  const next = sanitizeConfig(config);
  if (state) state.config = next;
  saveConfig(ctx?.configPath, next, ctx?.logger);
  ctx?.logger?.info(`mcstatus 配置已更新 | API: ${next.apiBaseUrl}`);
};

/** 单个配置项变更（reactive 字段逐项保存时调用） */
export const plugin_on_config_change = async (ctx, _ui, key, value) => {
  const next = sanitizeConfig({ ...(state?.config ?? DEFAULT_CONFIG), [key]: value });
  if (state) state.config = next;
  saveConfig(ctx?.configPath, next, ctx?.logger);
};

// ==================== 内部工具 ====================

/** 发送消息（群 / 私聊自动区分目标），失败只记日志不影响后续 */
async function sendMessage(ctx, event, message) {
  const params =
    event.message_type === 'group'
      ? { message, message_type: 'group', group_id: String(event.group_id) }
      : { message, message_type: 'private', user_id: String(event.user_id) };
  try {
    await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
  } catch (error) {
    ctx.logger.warn('mcstatus 发送消息失败:', error);
  }
}
