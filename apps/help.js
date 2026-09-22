import { render, pluginPriority, yaml } from '#xhh';

const HELP_PATH = './plugins/xhh/system/default/help.yaml';
const HELP_URL = 'https://yuyu2147.dpdns.org/';

export class help extends plugin {
  constructor(e) {
    super({
      name: '[小花火]帮助',
      dsc: '帮助',
      event: 'message',
      priority: pluginPriority('help', 100),
      rule: [
        {
          reg: '^#*(小花火|xhh)(命令|帮助|菜单|help|说明|功能|指令|使用说明)$',
          fnc: 'help',
        },
      ],
    });
  }

  async help(e) {
    try {
      const raw = yaml.get(HELP_PATH) || [];
      const data = Array.isArray(raw) ? raw : (raw.list || raw.data || []);
      if (!data.length) {
        return e.reply('帮助内容为空，可在线查看：' + HELP_URL, true, { recallMsg: 60 });
      }
      // au 为主人时才展示「主人专用指令」分组
      const img = await render('help/help', { data, au: !!e.isMaster }, { e, pct: 1 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[xhh][help] 帮助图渲染失败: ${err?.message || err}`);
      return e.reply(`小花火命令帮助：${HELP_URL}`, true, { recallMsg: 60 });
    }
  }
}
