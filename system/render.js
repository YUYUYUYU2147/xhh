import { config } from '#xhh';
import fs from 'node:fs';
// 临时自测：验证 system/ 下的模块是否随热重载重新求值。
// 置于模块顶层 —— 只要本模块被重新加载就会输出一行，无需触发任何指令。
// 日志之外再落盘一份标记，避免日志被过滤或 console 未被捕获导致误判。
// 验证通过后删除本段。
logger.info?.('[xhh][热重载自测] system/render.js 模块已加载');
try { fs.appendFileSync('./plugins/xhh/temp/hot_reload.log', `${new Date().toISOString()} render.js 模块加载\n`) } catch (_) { }
async function render(path, data_, cfg) {
  let tplFile =
    data_.tplFile || process.cwd() + '/plugins/xhh/resources/' + path + '.html';
  let { e } = cfg;
  if (!e.runtime) {
    logger.error('未找到e.runtime');
  }
  if (path.includes('bilibili')) {
    data_.emoji = config().emoji;
  }
  return e.runtime.render('小花火', path, data_, {
    retType: cfg.ret ? 'default' : 'base64',
    fullPage: cfg.fullPage !== false,
    beforeRender({ data }) {
      // 本地图标（wiki/imgs/*.png）的相对路径必须按实际落盘深度算，不能写死：
      // 框架把 HTML 存在 ./temp/html/小花火/{path}/{saveId}.html，
      // 从那张 HTML 所在目录回到 TRSS-Yunzai 根要上跳「path 段数 + 3」层：
      //   wiki/gs_role_nk（2 段）→ temp/html/小花火/wiki/gs_role_nk → 5 层
      //   abyss_report/nanoka_report_sr（2 段）→ temp/html/xhh/… → 5 层
      // 实测过 4 层不通（CSS 404），框架默认的 3+段数 才是对的，这里保持一致。
      // 写死层数会让 CSS 和图标全部 404 —— 页面上就变成没样式的裸 HTML：
      // 原图按原始尺寸铺开（攻略区几张武器图能占几千 px）、
      // 正文字号回到默认、角色详细那种长段落也不换行约束，图高能到 7000+ px。
      const depth = path.split('/').filter(Boolean).length + 3;
      const ppath = '../'.repeat(depth) + 'plugins/xhh/resources/';
      return {
        sys: {
          scale: `style=zoom:${cfg.pct || (config().img_quality / 100) * 2.4 || 2.4 * 0.8}`,
        },
        ...data_,
        ppath: data_.ppath || ppath,
        tplFile: tplFile,
        saveId: path.split('/')[path.split('/').length - 1],
      };
    },
  });
}
export default render;
