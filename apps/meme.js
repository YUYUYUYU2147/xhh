// xhh-meme：在线查询/制作 meme 表情包
// 数据源：yunzai-meme 服务（默认为派蒙使用的 misaka20001-memegenerator.hf.space）
// 功能：
//   #meme列表 / #表情包列表        查看全部 meme（渲染图片）
//   #meme搜索<关键词>              搜索 meme
//   #meme详情<关键词>              在线查询 meme 详情（渲染图片）
//   #<关键词> 或 #<关键词>详情     制作表情 / 查询该表情详情
//   #随机meme                     随机一个 meme
//   #meme帮助                     帮助
//   #meme更新                     （主人）更新远端资源缓存

import fetch, { FormData, Blob } from 'node-fetch';
import fs from 'fs';
import path from 'node:path';
import lodash from 'lodash';
import sharp from '../node_modules/sharp/lib/index.js';
import puppeteer from '../../../lib/puppeteer/puppeteer.js';
import { render, config, pluginPriority, getSource } from '#xhh';

const DATA_DIR = './plugins/xhh/data/memes/';
const INFOS_FILE = DATA_DIR + 'infos.json';
const KEYMAP_FILE = DATA_DIR + 'keyMap.json';

const DEFAULT_BASE_URL = 'http://113.31.103.19:50835';

// 主人类表情保护（制作对象是主人时，换成发送者本人头像）
const protectList = ['lash', 'do', 'beat_up', 'little_do', 'fast_do', 'qi', 'fast_qi'];

let keyMap = {};
let infos = {};
let loadPromise = null;


const getCfg = () => config();

function memeBaseUrl() {
  return getCfg().meme_baseUrl || DEFAULT_BASE_URL;
}

function memeEnabled() {
  return getCfg().meme !== false;
}

function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 渲染出的 PNG 长图体积过大，NapCat 发送 base64 图片会报
// "rich media transfer failed"。这里统一转 JPEG、限宽压体积，
// 若高度仍过大则切割成多张发送，避免 QQ 富媒体超限
const MAX_IMG_WIDTH = 1000;
const MAX_IMG_BYTES = 2 * 1024 * 1024;
const MAX_IMG_HEIGHT = 8000;

async function compressImageBuf(buf, opts = {}) {
  const maxWidth = opts.maxWidth || MAX_IMG_WIDTH;
  const maxBytes = opts.maxBytes || MAX_IMG_BYTES;
  let quality = opts.quality || 82;
  const meta = await sharp(buf).metadata();
  const width = Math.min(meta.width || maxWidth, maxWidth);
  let out = await sharp(buf)
    .resize({ width })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  while (out.length > maxBytes && quality > 40) {
    quality -= 10;
    out = await sharp(buf)
      .resize({ width })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  logger.mark(
    `[xhh-meme] 图片压缩 ${(buf.length / 1024 / 1024).toFixed(2)}MB -> ${(out.length / 1024 / 1024).toFixed(2)}MB (${meta.width}x${meta.height} -> ${width}px, jpeg q${quality})`
  );
  return out;
}

// 压缩后若图片过高，切成多张（NapCat 对超高长图也会传失败）
async function compressAndSplit(buf) {
  const jpeg = await compressImageBuf(buf);
  const meta = await sharp(jpeg).metadata();
  const { width, height } = meta;
  if (height <= MAX_IMG_HEIGHT) return [jpeg];
  const parts = Math.ceil(height / MAX_IMG_HEIGHT);
  const chunkH = Math.floor(height / parts);
  const list = [];
  for (let i = 0; i < parts; i++) {
    const top = i * chunkH;
    const h = i === parts - 1 ? height - top : chunkH;
    list.push(
      await sharp(jpeg)
        .extract({ left: 0, top, width, height: h })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
    );
  }
  logger.mark(`[xhh-meme] 长图 ${height}px 切割为 ${parts} 张`);
  return list;
}

// puppeteer.render 直接返回 Buffer（bh3_profile 等已验证），拿到后压缩/切割再发送
async function renderImg(e, path, data_, cfg = {}) {
  const tplFile = process.cwd() + '/plugins/xhh/resources/' + path + '.html';
  let buf;
  try {
    buf = await puppeteer.render('小花火/' + path, {
      ...data_,
      sys: { scale: 'style=transform:scale(1)' },
      deviceScaleFactor: cfg.scale || 2,
      ppath: data_.ppath || '../../../../../plugins/xhh/resources/',
      tplFile: tplFile,
      saveId: path.split('/')[path.split('/').length - 1],
    });
  } catch (err) {
    logger.error(`[xhh-meme] 渲染失败 ${path}: ${err.message}`);
    return [{ type: 'text', data: { text: '图片渲染失败，请稍后再试' } }];
  }
  if (!buf || !Buffer.isBuffer(buf)) {
    logger.error(`[xhh-meme] 渲染返回异常 ${path}: ${typeof buf}`);
    return [{ type: 'text', data: { text: '图片渲染失败，请稍后再试' } }];
  }
  const bufs = await compressAndSplit(buf);
  return bufs.map(b => segment.image(b));
}

function mkdirs(dirname) {
  if (fs.existsSync(dirname)) return true;
  if (mkdirs(path.dirname(dirname))) {
    fs.mkdirSync(dirname);
    return true;
  }
}

function safeJson(response) {
  if (!response || response.status !== 200) return null;
  const ct = response.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('json')) return null;
  try {
    return response.json();
  } catch {
    return null;
  }
}

async function fetchJsonWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      const data = await safeJson(res);
      if (data) return data;
      logger.warn(`[xhh-meme] 拉取 ${url} 返回非预期内容 (第${i + 1}次)`);
    } catch (e) {
      logger.warn(`[xhh-meme] 拉取 ${url} 失败 (第${i + 1}次): ${e.message}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return null;
}

function readJsonFile(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    logger.warn(`[xhh-meme] 本地缓存 ${file} 读取失败，已忽略: ${e.message}`);
    try { fs.unlinkSync(file); } catch { }
  }
  return {};
}

async function loadData(force = false) {
  if (!force && Object.keys(keyMap).length && Object.keys(infos).length) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    mkdirs(DATA_DIR);
    if (!force) {
      infos = readJsonFile(INFOS_FILE);
      keyMap = readJsonFile(KEYMAP_FILE);
    } else {
      infos = {};
      keyMap = {};
    }
    const base = memeBaseUrl();
    if (!base) {
      logger.warn('[xhh-meme] meme_baseUrl 未配置');
      return;
    }
    try {
      if (Object.keys(infos).length === 0) {
        const data = await fetchJsonWithRetry(`${base}/memes/static/infos.json`);
        if (data && Object.keys(data).length) {
          infos = data;
          fs.writeFileSync(INFOS_FILE, JSON.stringify(infos));
        }
      }
      if (Object.keys(keyMap).length === 0) {
        const data = await fetchJsonWithRetry(`${base}/memes/static/keyMap.json`);
        if (data && Object.keys(data).length) {
          keyMap = data;
          fs.writeFileSync(KEYMAP_FILE, JSON.stringify(keyMap));
        }
      }
      // 静态资源获取失败时，走逐条查询兜底（并发分批，避免串行过慢）
      if (Object.keys(infos).length === 0 || Object.keys(keyMap).length === 0) {
        logger.mark('[xhh-meme] 静态资源拉取失败，尝试逐条在线查询');
        const keys = await fetchJsonWithRetry(`${base}/memes/keys`);
        if (Array.isArray(keys) && keys.length) {
          const keyMapTmp = {};
          const infosTmp = {};
          const CONCURRENCY = 12;
          for (let i = 0; i < keys.length; i += CONCURRENCY) {
            const batch = keys.slice(i, i + CONCURRENCY);
            const results = await Promise.all(batch.map(async key => {
              const info = await fetchJsonWithRetry(`${base}/memes/${key}/info`, 1);
              return { key, info };
            }));
            for (const { key, info } of results) {
              if (info && Array.isArray(info.keywords)) {
                info.keywords.forEach(kw => { keyMapTmp[kw] = key; });
                infosTmp[key] = info;
              }
            }
            logger.mark(`[xhh-meme] 正在拉取表情信息 ${Math.min(i + CONCURRENCY, keys.length)}/${keys.length}`);
          }
          if (Object.keys(infosTmp).length) infos = infosTmp;
          if (Object.keys(keyMapTmp).length) keyMap = keyMapTmp;
          fs.writeFileSync(KEYMAP_FILE, JSON.stringify(keyMap));
          fs.writeFileSync(INFOS_FILE, JSON.stringify(infos));
        }
      }
    } catch (err) {
      logger.warn(`[xhh-meme] 远端资源拉取失败，插件仍可加载: ${err.message}`);
    }
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/**
 * 在线查询单个 meme 详情：
 * 本地缓存有则直接用，否则实时请求远端 /memes/{key}/info 并回写缓存
 */
async function queryMemeInfo(key) {
  if (infos[key]) return infos[key];
  const base = memeBaseUrl();
  try {
    const data = await fetchJsonWithRetry(`${base}/memes/${key}/info`, 2);
    if (data && data.key) {
      infos[key] = data;
      fs.writeFileSync(INFOS_FILE, JSON.stringify(infos));
      return data;
    }
  } catch (err) {
    logger.warn(`[xhh-meme] 在线查询 ${key} 详情失败: ${err.message}`);
  }
  return null;
}

// 根据消息文本匹配最长关键词，返回 {keyword, key}
function matchKeyword(msg) {
  const cleaned = String(msg).trim().replace(/^#/, '');
  const matching = Object.keys(keyMap).filter(k => cleaned.startsWith(k));
  if (!matching.length) return null;
  matching.sort((a, b) => b.length - a.length);
  return { keyword: matching[0], key: keyMap[matching[0]] };
}

export class meme extends plugin {
  constructor() {
    let option = {
      name: '[小花火]Meme表情包',
      dsc: 'meme表情包制作/在线查询详情',
      event: 'message',
      priority: pluginPriority('meme', 50),
      rule: [
        {
          reg: '^#?(meme(s)?|表情包)(列表|大全|总览)(\\s*\\d+)?$',
          fnc: 'memesList',
        },
        {
          reg: '^#?(meme(s)?|表情包)搜索',
          fnc: 'memesSearch',
        },
        {
          reg: '^#?(meme(s)?|表情包)(详情|查询|介绍)',
          fnc: 'memesDetail',
        },
        {
          reg: '^#?(meme(s)?|表情包)帮助',
          fnc: 'memesHelp',
        },
        {
          reg: '^#?(meme(s)?|表情包)更新',
          fnc: 'memesUpdate',
          permission: 'master',
        },
        {
          reg: '^#?随机(meme(s)?|表情包)',
          fnc: 'randomMemes',
        },
      ],
    };
    super(option);

    this.task = {
      cron: '0 3 * * * *',
      name: '[小花火]meme资源自动更新',
      fnc: () => this.init(true),
      log: false,
    };

    // 异步加载资源，完成后注册动态关键词规则
    this.init().catch(err => {
      logger.warn(`[xhh-meme] 初始化失败: ${err.message}`);
    });
  }

  async init(force = false) {
    await loadData(force);
    let rules = [
      {
        reg: '^#?(meme(s)?|表情包)(列表|大全|总览)(\\s*\\d+)?$',
        fnc: 'memesList',
      },
      {
        reg: '^#?(meme(s)?|表情包)搜索',
        fnc: 'memesSearch',
      },
      {
        reg: '^#?(meme(s)?|表情包)(详情|查询|介绍)',
        fnc: 'memesDetail',
      },
      {
        reg: '^#?(meme(s)?|表情包)帮助',
        fnc: 'memesHelp',
      },
      {
        reg: '^#?(meme(s)?|表情包)更新',
        fnc: 'memesUpdate',
        permission: 'master',
      },
      {
        reg: '^#?随机(meme(s)?|表情包)',
        fnc: 'randomMemes',
      },
    ];
    // 动态关键词规则：最长关键词优先，先排长的避免短词抢先匹配
    // 强制 # 前缀开启时，规则要求消息必须以 # 开头，否则不带 # 不会触发
    const forceSharp = getCfg().meme_forceSharp !== false;
    Object.keys(keyMap)
      .sort((a, b) => b.length - a.length)
      .forEach(key => {
        rules.push({
          reg: forceSharp
            ? new RegExp(`^\\s*#${escapeRegExp(key)}`)
            : new RegExp(`^\\s*#?${escapeRegExp(key)}`),
          fnc: 'memes',
        });
      });
    // TRSS-Yunzai 的 loader 只在插件加载时把字符串 reg 转为 RegExp，
    // 动态替换 this.rule 后需手动转换，否则 v.reg.test 会报错
    this.rule = rules.map(r => ({
      ...r,
      reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg),
    }));
    logger.mark(`[xhh-meme] 资源加载完成，共 ${Object.keys(infos).length} 个 meme`);
  }

  // ---------- 列表 ----------
  async memesList(e) {
    if (!memeEnabled()) return false;
    await loadData();
    if (!Object.keys(infos).length) {
      await e.reply('meme 资源为空，请先发送 #meme更新 拉取资源', true);
      return true;
    }
    const now = Date.now();
    const NEW_MS = 30 * 24 * 60 * 60 * 1000;
    const list = Object.values(infos)
      .map(info => ({
        key: info.key,
        name: (info.keywords && info.keywords[0]) || info.key,
        aliases: (info.keywords || []).slice(1, 4).join('/'),
        created: info.date_created || 0,
        isNew: now - new Date(info.date_created || 0).getTime() < NEW_MS,
        maxImages: info.params_type?.max_images ?? 0,
        minTexts: info.params_type?.min_texts ?? 0,
      }))
      .sort((a, b) => new Date(a.created) - new Date(b.created))
      .reverse();
    const PAGE_SIZE = 48;
    const pageMatch = e.msg.match(/\d+/);
    let page = pageMatch ? parseInt(pageMatch[0], 10) : 1;
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, totalPages));
    const pageList = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const nextPage = page < totalPages ? page + 1 : 1;
    const msg = await renderImg(e, 'meme/meme', { list: pageList, total: list.length, page, totalPages, nextPage });
    await e.reply(msg);
    return true;
  }

  // ---------- 搜索 ----------
  async memesSearch(e) {
    if (!memeEnabled()) return false;
    await loadData();
    const search = e.msg.replace(/^#?(meme(s)?|表情包)搜索/, '').trim();
    if (!search) {
      await e.reply('要搜什么？例如：#meme搜索 摸', true);
      return true;
    }
    const hits = Object.keys(keyMap).filter(k => k.includes(search));
    if (!hits.length) {
      await e.reply(`没有找到包含「${search}」的 meme`, true);
      return true;
    }
    const lines = hits.slice(0, 30).map((k, i) => `${i + 1}. ${k} → ${keyMap[k]}`);
    const tip = hits.length > 30 ? `\n...等共 ${hits.length} 个` : '';
    await e.reply(`【meme搜索：${search}】共 ${hits.length} 个\n${lines.join('\n')}${tip}\n发送「#meme详情<名称>」查看详情`, e.isGroup);
    return true;
  }

  // ---------- 详情（在线查询） ----------
  async memesDetail(e) {
    if (!memeEnabled()) return false;
    await loadData();
    const search = e.msg.replace(/^#?(meme(s)?|表情包)(详情|查询|介绍)/, '').trim();
    if (!search) {
      await e.reply('要查询哪个表情？例如：#meme详情 摸', true);
      return true;
    }
    const matched = matchKeyword(search);
    if (!matched) {
      await e.reply(`没有找到「${search}」对应的 meme`, true);
      return true;
    }
    return this.memeDetail(e, matched.key);
  }

  async memeDetail(e, key) {
    const info = await queryMemeInfo(key);
    if (!info) {
      await e.reply(`查询「${key}」详情失败，请稍后再试或发送 #meme更新 刷新资源`, true);
      return true;
    }
    const data = buildDetailData(info);
    const msg = await renderImg(e, 'meme/detail', data);
    await e.reply(msg);
    return true;
  }

  // ---------- 帮助（渲染图片，meme-plugin 分组表格格式） ----------
  async memesHelp(e) {
    if (!memeEnabled()) return false;
    const total = Math.max(Object.keys(infos).length, Object.keys(keyMap).length);
    const helpGroup = [
      {
        group: '查询类',
        color: '#ff5d8f',
        list: [
          { icon: '🔍', title: '#meme列表', desc: '查看全部表情（渲染图片）' },
          { icon: '🔎', title: '#meme搜索 <词>', desc: '快速搜索，如 #meme搜索 摸' },
          { icon: '📋', title: '#meme详情 <词>', desc: '在线查询表情详情' },
          { icon: '🎲', title: '#随机meme', desc: '随机一个表情并制作' },
        ],
      },
      {
        group: '制作类',
        color: '#8b5cf6',
        list: [
          { icon: '🖼️', title: '#<表情名>', desc: '制作表情，如 #摸 好兄弟' },
          { icon: 'ℹ️', title: '#<表情名>详情', desc: '查看该表情参数' },
          { icon: '📎', title: '回复图片 + #<名>', desc: '指定图片对象制作' },
          { icon: '🎛️', title: '参数', desc: '部分表情支持，如 #摸 圆' },
        ],
      },
      {
        group: '管理类',
        color: '#f59e0b',
        list: [
          { icon: '🔄', title: '#meme更新', desc: '刷新远端资源缓存（仅主人）' },
          { icon: '❓', title: '#meme帮助', desc: '显示本帮助图' },
          { icon: '🧩', title: '锅巴面板', desc: '开关 / CD / 服务地址 / 主人保护' },
        ],
      },
    ];
    const data = {
      total: total || 0,
      baseUrl: memeBaseUrl(),
      helpGroup,
    };
    const msg = await renderImg(e, 'meme/help', data);
    await e.reply(msg);
    return true;
  }

  // ---------- 更新 ----------
  async memesUpdate(e) {
    await e.reply('xhh-meme 资源更新中…', true);
    await loadData(true);
    await this.init(true);
    await e.reply(`更新完成，当前共 ${Object.keys(infos).length} 个 meme`, true);
    return true;
  }

  // ---------- 随机 ----------
  async randomMemes(e) {
    if (!memeEnabled()) return false;
    await loadData();
    const keys = Object.keys(infos).filter(
      key => infos[key]?.params_type?.min_images === 1 && infos[key]?.params_type?.min_texts === 0
    );
    if (!keys.length) {
      await e.reply('meme 资源为空，请先 #meme更新', true);
      return true;
    }
    const key = keys[lodash.random(0, keys.length - 1)];
    // 随机制作属于主动功能，加 # 前缀以通过强制前缀校验
    e.msg = '#' + (infos[key].keywords?.[0] || key);
    return this.memes(e);
  }

  // ---------- 制作 / 详情 ----------
  async memes(e) {
    if (!memeEnabled()) return false;
    const matched = matchKeyword(e.msg);
    if (!matched) return false;

    // 强制 # 前缀：开启后不带 # 不触发 meme 制作
    if (getCfg().meme_forceSharp !== false && !String(e.msg).trim().startsWith('#')) {
      return false;
    }

    const { key, keyword } = matched;

    // 详情
    const rest = String(e.msg).trim().replace(/^#/, '').replace(keyword, '').trim();
    if (rest === '详情' || rest === '帮助' || rest === '参数') {
      return this.memeDetail(e, key);
    }

    // 冷却
    if (await this.checkCD(e)) return true;

    const info = infos[key] || (await queryMemeInfo(key));
    if (!info?.params_type) return false;
    const params = info.params_type;

    const formData = fetch.FormData ? new fetch.FormData() : new FormData();
    const replyMsg = getCfg().meme_reply !== false;
    const imgBuffers = [];

    // ---- 收集图片 ----
    if (params.max_images > 0) {
      const imgUrls = await this.collectImages(e, key);
      for (let i = 0; i < imgUrls.length; i++) {
        const buffer = await this.fetchImageBuffer(imgUrls[i]);
        if (!buffer) continue;
        imgBuffers.push(buffer);
        formData.append('images', new Blob([buffer], { type: 'image/jpeg' }), `img_${i}.jpg`);
      }
    }

    // ---- 收集文字 ----
    let text = rest.replace(/#/g, '').trim();
    if (params.max_texts === 0) text = '';
    if (!text && params.min_texts > 0) {
      text = e.sender.card || e.sender.nickname || '';
    }
    const texts = text ? text.split('/').slice(0, params.max_texts || text.split('/').length) : [];
    if (texts.length < params.min_texts) {
      await e.reply(`字数不够！至少需要 ${params.min_texts} 段文字，用 / 隔开`, true);
      return true;
    }
    texts.forEach(t => formData.append('texts', t));

    // 制作参数
    const argsStr = handleArgs(key, rest.split('#')[1] || '', e);
    if (argsStr) formData.append('args', argsStr);

    const maxMB = getCfg().meme_maxFileSize ?? 10;
    if (imgBuffers.some(b => b.length >= maxMB * 1024 * 1024)) {
      await e.reply(`图片大小超出限制，最多支持 ${maxMB}MB`, true);
      return true;
    }

    logger.info(`[xhh-meme] 制作 ${key}: images=${imgBuffers.length} texts=${JSON.stringify(texts)}`);

    let response;
    try {
      response = await fetch(`${memeBaseUrl()}/memes/${key}/`, { method: 'POST', body: formData });
    } catch (err) {
      logger.error(`[xhh-meme] 请求失败: ${err.message}`);
      await e.reply(`表情制作失败: ${err.message}`, true);
      return true;
    }
    if (response.status > 299) {
      const errText = await response.text();
      logger.error(`[xhh-meme] ${key} 制作失败: ${errText}`);
      await e.reply(`表情制作失败: ${String(errText).slice(0, 120)}`, true);
      return true;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await e.reply(segment.image('base64://' + buffer.toString('base64')), replyMsg);
    return true;
  }

  // 冷却
  async checkCD(e) {
    const cd = Number(getCfg().meme_CD) || 0;
    if (cd <= 0) return false;
    const uid = e.user_id;
    const gid = e.group_id || e.user_id;
    try {
      const last = await redis.get(`xhh:meme_cd:${gid}:${uid}`);
      if (last) {
        await e.reply(`操作太频繁了，休息一下吧`, true);
        return true;
      }
      await redis.set(`xhh:meme_cd:${gid}:${uid}`, 1, { EX: cd });
    } catch { }
    return false;
  }

  // 收集图片：回复 → 同发图片 → 艾特头像 → 发送者头像
  async collectImages(e, key) {
    const params = infos[key]?.params_type || {};
    let imgUrls = [];
    try {
      const source = await getSource(e);
      if (source?.message) {
        for (const val of source.message) {
          if (val.type === 'image' && val.url) imgUrls.push(val.url);
        }
      }
    } catch { }
    if (!imgUrls.length && e.img?.length) imgUrls.push(...e.img);
    if (!imgUrls.length) {
      const ats = e.message.filter(m => m.type === 'at');
      if (ats.length) {
        imgUrls = ats.map(at => `https://q1.qlogo.cn/g?b=qq&s=160&nk=${at.qq}`);
      }
    }
    const avatar = await getAvatar(e);
    if (!imgUrls.length) imgUrls = [avatar];
    if (imgUrls.length < params.min_images && !imgUrls.includes(avatar)) {
      imgUrls = [avatar, ...imgUrls];
    }
    // 主人保护
    if (protectList.includes(key) && getCfg().meme_masterProtectDo) {
      imgUrls = await this.masterProtect(e, imgUrls);
    }
    return imgUrls.slice(0, Math.max(1, params.max_images || 1));
  }

  async masterProtect(e, imgUrls) {
    try {
      const masters = await getMasterQQ();
      const me = await getAvatar(e);
      const protectedIdx = imgUrls.findIndex(url => {
        const m = url.match(/nk=(\d+)/);
        return m && masters.map(q => String(q)).includes(m[1]);
      });
      if (protectedIdx > -1) imgUrls[protectedIdx] = me;
    } catch { }
    return imgUrls;
  }

  async fetchImageBuffer(url) {
    try {
      if (url.startsWith('data:') || url.startsWith('base64://')) {
        const b64 = url.replace(/^data:[^;]+;base64,/, '').replace(/^base64:\/\//, '');
        return Buffer.from(b64, 'base64');
      }
      const res = await fetch(url);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      logger.warn(`[xhh-meme] 图片下载失败: ${err.message}`);
      return null;
    }
  }
}

// ================= 工具函数 =================

function buildDetailData(info) {
  const params = info.params_type || {};
  const keywords = info.keywords || [];
  const base = memeBaseUrl();

  // 参数说明文本
  const argTexts = [];
  const argsType = params.args_type;
  if (argsType?.parser_options?.length) {
    const props = argsType.args_model?.properties || {};
    const options = argsType.parser_options || [];
    for (const prop in props) {
      if (prop === 'user_infos') continue;
      const propInfo = props[prop];
      let description = propInfo.description || '';
      const option = options.find(
        opt => opt.dest === prop || (opt.args && opt.args.some(a => a.name === prop))
      );
      if (option?.help_text) description = option.help_text;
      let line = `${prop}`;
      if (description) line += `：${description}`;
      if (propInfo.enum) {
        const names = options
          .filter(opt => opt.action?.type === 0 && opt.action?.value && opt.dest === prop)
          .flatMap(opt => opt.names.filter(n => !n.startsWith('--')));
        const uniq = [...new Set(names)];
        if (uniq.length) line += `（可选：${uniq.join('、')}）`;
      } else if (propInfo.type === 'integer' || propInfo.type === 'number') {
        if (propInfo.minimum !== undefined && propInfo.maximum !== undefined) {
          line += `（范围：${propInfo.minimum}~${propInfo.maximum}）`;
        }
      }
      argTexts.push(line);
    }
  }

  // 使用示例
  let usage = `#${keywords[0] || info.key}`;
  if (params.min_images > 0) usage += ' [图片]';
  if (params.min_texts > 0) usage += ` ${(params.default_texts || ['文字']).join('/')}`;

  return {
    key: info.key,
    name: keywords[0] || info.key,
    aliases: keywords.join('、'),
    preview: `${base}/memes/${info.key}/preview`,
    minImages: params.min_images ?? 0,
    maxImages: params.max_images ?? 0,
    minTexts: params.min_texts ?? 0,
    maxTexts: params.max_texts ?? 0,
    defaultTexts: (params.default_texts || []).join('/') || '无',
    argsTexts: argTexts,
    usage,
    dateCreated: formatDate(info.date_created),
    dateModified: formatDate(info.date_modified),
  };
}

function formatDate(dateStr) {
  if (!dateStr) return '未知';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function handleArgs(key, args, e) {
  if (!args) return '';
  const params = infos[key]?.params_type;
  if (!params?.args_type?.args_model) return '';
  const argsObj = { user_infos: [{ name: e.sender.card || e.sender.nickname || '', gender: e.sender.sex || 'unknown' }] };
  const props = params.args_type.args_model.properties || {};
  const options = params.args_type.parser_options || [];
  for (const prop in props) {
    if (prop === 'user_infos') continue;
    const propInfo = props[prop];
    const related = options.filter(opt => opt.dest === prop || (opt.args && opt.args.some(a => a.name === prop)));
    if (propInfo.enum && related.length) {
      const valueMap = {};
      related.forEach(opt => {
        if (opt.action?.type === 0) {
          opt.names.forEach(name => {
            const v = name.replace(/^-+/, '');
            valueMap[v] = opt.action.value;
          });
        }
      });
      argsObj[prop] = valueMap[args.trim()] ?? propInfo.default;
    } else if (propInfo.type === 'integer' || propInfo.type === 'number') {
      if (/^\d+$/.test(args.trim())) argsObj[prop] = parseInt(args.trim());
    }
  }
  return JSON.stringify(argsObj);
}

async function getMasterQQ() {
  try {
    return (await import('../../../lib/config/config.js')).default.masterQQ;
  } catch {
    return [];
  }
}

async function getAvatar(e) {
  try {
    if (typeof e.getAvatarUrl === 'function') return await e.getAvatarUrl(0);
  } catch { }
  return `https://q1.qlogo.cn/g?b=qq&s=0&nk=${e.user_id}`;
}
