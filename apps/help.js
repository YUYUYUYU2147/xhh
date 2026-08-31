import { pluginPriority } from '#xhh';

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
    const url = 'https://yuyu2147.dpdns.org/';
    await e.reply(`【小花火命令帮助】\n在线查看：${url}`);
  }
}
