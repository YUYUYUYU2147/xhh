import fs from 'node:fs';
import yaml from './system/yaml.js';

logger.info('\x1B[31m---------៷>ᴗ<៷---------\x1B[0m');
logger.info('\x1B[31m小花火插件正在载入...\x1B[0m');
logger.info('\x1B[31m-------------------------\x1B[0m');

var paths = ['config/', 'temp/', 'data/', 'data/fp/', 'data/Stoken/'];

paths.map(path => {
  if (!fs.existsSync('./plugins/xhh/' + path)) {
    fs.mkdirSync('./plugins/xhh/' + path);
  }
});

let paths_ = ['config.yaml', 'sign.yaml', 'other.yaml', 'bh3_remind.yaml', 'activity_remind.yaml'];

for (const _path of paths_) {
  const cfg_path = './plugins/xhh/config/' + _path;
  const def_cfg_path = './plugins/xhh/system/default/default_config/' + _path;
  if (!fs.existsSync(cfg_path)) {
    fs.cpSync(def_cfg_path, cfg_path);
    continue;
  }

  let cfg = yaml.get('./plugins/xhh/config/' + _path);
  let def_cfg = yaml.get(def_cfg_path);

  // 只补默认配置里新增的键，绝不覆盖、绝不删除用户已有的键。
  //
  // 原来这里是「键数不一致就 fs.cpSync 整份覆盖，再把两边都有的键回填」，
  // 有两个问题（见 issue #2）：
  //   1) 整份覆盖会静默删掉所有只存在于用户配置的键。锅巴面板 setConfigData
  //      写入的键（abyss_report_sr_fiction_levels、abyss_report_zzz_shiyu_stages、
  //      bili_live_priority 等）默认配置里并没有，每次重启都会被抹掉。
  //   2) 触发条件是「键数」而不是「缺哪些键」：用户删掉一个默认键、又自己加了
  //      一个键，键数正好相等 → 整段同步被跳过，插件新增的默认键永远补不进来。
  //      反过来只要键数有差就整份覆盖，损失远大于收益。
  //
  // 现在逐键比对：默认里有、用户里没有的才补进去，其余一律不动。
  // 用户想清理废弃键可以自己删，插件不该替用户做这个决定。
  //
  // 嵌套对象要递归补：activity_remind.yaml 的 groups 就是一层对象，
  // 只比顶层的话，默认配置以后给 groups 加新游戏（如 nte: []）就补不进来。
  // 数组一律整个保留用户的（顺序和内容都是用户自己定的，不该插手）。
  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  // 只收集「缺失的键路径」，不修改内存里的对象，最后交给 yaml.setMissing 增量写盘。
  // 千万别把补完的 cfg 整个 stringify 回去 —— 那样会抹掉用户配置文件里
  // 全部注释和排版（实测 84 行注释会变成 0 行）。
  // 键路径用 \0 分隔各层，避免键名本身带 '.' 时被 setIn 拆错层级。
  const missing = [];
  const find = (userObj, defObj, prefix) => {
    for (const key in defObj) {
      if (!Object.prototype.hasOwnProperty.call(defObj, key)) continue;
      const path = prefix ? `${prefix}\0${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(userObj, key)) {
        missing.push({ path, key });
        continue;
      }
      if (isPlainObject(userObj[key]) && isPlainObject(defObj[key])) {
        find(userObj[key], defObj[key], path);
      }
    }
  };
  find(cfg, def_cfg, '');
  // 取值要按整条路径在 def_cfg 里逐层走，不能只取最后一段 ——
  // 否则嵌套键（如 groups.nte）会取到 undefined，把 undefined 写进配置文件。
  const pickDefault = p => p.split('\0').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), def_cfg);
  if (missing.length && yaml.setMissing(cfg_path, missing.map(m => m.path), pickDefault)) {
    logger.info(`[xhh] 配置 ${_path} 补充新增键：${missing.map(m => m.path.replace(/\0/g, '.')).join(', ')}`);
  }
}

const files = fs
  .readdirSync('./plugins/xhh/apps')
  .filter(file => file.endsWith('.js'));

let ret = [];

const cacheKey = Date.now();
files.forEach(file => {
  // TRSS 的插件热重载只给 index.js 加 cache bust；apps 子模块也要带版本号，
  // 否则 #重启/#热重载 后仍可能使用旧的 ESM 缓存。
  ret.push(import(`./apps/${file}?v=${cacheKey}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
  let name = files[i].replace('.js', '');

  if (ret[i].status != 'fulfilled') {
    logger.error(`载入插件错误：${logger.red(name)}`);
    logger.error(ret[i].reason);
    continue;
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]];
}

// 启动手动验证码服务（必须在所有模块就绪后调用，config 才可读）
try {
  const { startManualGeetest } = await import('./system/manual_geetest.js');
  startManualGeetest();
} catch (err) {
  logger.error(`[xhh] 手动验证码服务启动异常：${err?.message || err}`);
}

// 补齐配置里群号对应的群名，供锅巴群白名单下拉展示
setTimeout(async () => {
  try {
    const { refreshGroupNames, cacheGroupList } = await import('./system/group_name.js');
    cacheGroupList();
    setInterval(() => {
      try {
        cacheGroupList();
      } catch {}
    }, 5 * 60 * 1000).unref?.();
    const collect = (file, pick) => {
      try {
        return pick(yaml.get('./plugins/xhh/config/' + file) || {});
      } catch {
        return [];
      }
    };
    const ids = [
      ...collect('bh3_remind.yaml', v => [...(v.groups || []), ...(v.all_note_groups || [])]),
      ...collect('sign.yaml', v => [...(v.sign_group || []), ...(v.bbs_sign_group || [])]),
      ...collect('activity_remind.yaml', v => Object.values(v.groups || {}).flat()),
      ...collect('config.yaml', v => v.groups || []),
    ].map(v => String(v).trim()).filter(Boolean);
    if (ids.length) await refreshGroupNames([...new Set(ids)]);
  } catch (err) {
    logger.debug(`[xhh] 群名缓存刷新失败：${err.message}`);
  }
}, 30 * 1000);

export { apps };
