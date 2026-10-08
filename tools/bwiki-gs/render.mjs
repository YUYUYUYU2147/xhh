// Bwiki HTML 解析结果 → 真实 gsRoleView → 真实模板 → 出图（第 3 步）
// 图标全部走 Bwiki 自己的 patchwiki.biligame.com，不依赖 nanoka
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/root/TRSS_AllBot/TRSS-Yunzai/');
import puppeteer from 'puppeteer';
import { gsRoleView } from '/root/TRSS_AllBot/TRSS-Yunzai/plugins/xhh/system/role_detail.js';

const ROOT = '/root/TRSS_AllBot/TRSS-Yunzai';
const XHH = `${ROOT}/plugins/xhh`;
mkdirSync('/tmp/opencode/out', { recursive: true });
const who = process.argv[2] || '菲林斯';

const d = JSON.parse(readFileSync('/tmp/opencode/out/gs-html.json', 'utf8'));
if (d.page !== who) throw new Error(`JSON 里是 ${d.page}，要渲染 ${who}？先跑 parse_html.mjs ${who}`);
// parse.mjs 会把渲染 HTML 落到 out/<角色名>.html。按角色名读，不要写死文件名，
// 也不要用「文件里含不含角色名」去猜——之前就因为读了别的角色的残留文件，
// 渲染出甘雨的技能名和材料却顶着菲林斯的标题，这类错很难一眼看出来。
let html = '';
try { html = readFileSync(`/tmp/opencode/out/${who}.html`, 'utf8'); }
catch { console.log(`⚠️ 找不到 out/${who}.html，先跑 parse.mjs ${who}`); }

const g = k => { const v = d.basic?.[k]; return Array.isArray(v) ? (v[0] ?? '') : (v ?? ''); };
const first = v => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

// ── 立绘：从 HTML 里挑最宽的「角色名立绘」 ──
let portrait = '';
if (html) {
  let best = 0;
  for (const m of html.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)) {
    const a = m[1], src = m[2];
    if (!a.includes(who) || !/立绘|抽卡立绘/.test(a)) continue;
    const w = Number((m[0].match(/width="(\d+)"/) || [])[1] || 0);
    if (w > best) { best = w; portrait = src; }
  }
  if (!portrait) {
    const m = [...html.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)]
      .find(x => x[1].includes(who));
    if (m) portrait = m[2];
  }
}

// ── 等级属性：图上要显示 90 级满级，不是一级 ──
// Bwiki 的 90 级行「突破后」列是空的（表里写的是 -），所以取 after ?? before。
const lv1 = d.growth?.find(x => x.level === 1) || {};
// 之前写成 reduce((a,b)=> b.level > a.level ? b : a, {})，初值 {} 没有 level，
// 比较恒为 false，结果永远是 {}。改成先过滤掉无 level 的行再取最大。
const lvMax = (d.growth || []).filter(x => Number.isFinite(x.level))
  .reduce((a, b) => (!a || b.level > a.level ? b : a), null) || {};
const at90 = k => (lvMax[k]?.after && lvMax[k].after !== '-' ? lvMax[k].after : lvMax[k]?.before) || '';
console.log(`  等级属性: 1级 HP ${lv1.hp?.before} → 90级 HP ${at90('hp')}  ATK ${at90('atk')}  DEF ${at90('def')}  爆伤加成 ${at90('bonus')}`);

// ── 突破：各档 → gsRoleView 的 ascensions 形状 ──
const ascensions = (d.ascendStages || []).map(s => ({
  cost: Number((s.mats.find(m => m.name === '摩拉')?.count || 0).toString().replace(/[^\d]/g, '')) || 0,
  mats: s.mats.filter(m => m.name !== '摩拉').map(m => ({
    id: '', name: m.name, count: Number(String(m.count).replace(/[^\d.]/g, '')) || 0,
    _bwIcon: m.icon, _unlock: s.unlock || '',
  })),
}));

// 技能名与描述：渲染 HTML 的技能块里已经全有（r-skill-title-1 标题 + 描述段），
// 不必再单独请求 wikitext —— 少一次请求，也少一个会被 Cloudflare 拦的点。
const blocks = d.skillBlocks || [];
console.log('  技能块:', blocks.map(x => x.name).join(' / ') || '(空)');

const skillObjs = [];
// 只遍历 kind==='skill' 的块来配倍率表。原先靠「表有没有 attrs」间接推断，
// 那是巧合不是规则（见 parseSkillBlocks 里的说明）。
const skillBlocks = blocks.filter(b => b.kind === 'skill');
for (const t of (d.skillTables || [])) {
  if (!t.attrs.length) continue;
  const blk = skillBlocks[skillObjs.length];
  const nm = blk?.name?.trim() || `技能${skillObjs.length + 1}`;
  const desc = [], param = [], brackets = [];
  for (const a of t.attrs) {
    const lvKeys = Object.keys(a.levels);
    const topRaw = a.levels[lvKeys[lvKeys.length - 1]];
    // Bwiki 有「双值格」：一个格写 '271%/338%'（低空/高空各一套）。
    // 之前 parseFloat('271%/338%') 只取到 271，再被 F1P 乘 100，
    // 拼接后就成了 271338%。这里拆成两行分别显示。
    const parts = String(topRaw).split('/').map(x => x.trim()).filter(Boolean);
    for (const part of parts) {
      const raw = parseFloat(part.replace(/[^\d.]/g, ''));
      if (Number.isNaN(raw)) continue;
      const isPct = part.includes('%');
      const unit = (part.match(/%(.)/) || [])[1] || '';
      param.push(isPct ? raw / 100 : raw);
      const fmt = isPct ? 'F1P' : 'F1';
      desc.push(unit ? `${a.name}(${unit})|{param${param.length}:${fmt}}` : `${a.name}|{param${param.length}:${fmt}}`);
    }
    brackets.push(`${a.name}：${lvKeys.map(k => a.levels[k]).join(' / ')}`);
  }
  skillObjs.push({
    name: nm,
    // 图标取同名技能块里的 patchwiki 图链。之前这里写死空串，
    // 结果 Bwiki 路径的技能图标全是空的（而 skillBlocks 里 7 条都带 icon）。
    promote: { 0: { level: Object.keys(t.attrs[0].levels).length, icon: blk?.icon || '', desc, param, brackets } },
  });
}

const detail = {
  name: who,
  icon: '',
  rarity: (g('稀有度') || '5星').replace(/[^0-9]/g, '') || '5',
  base_hp: at90('hp'),        // 90 级满级，不是 1 级
  base_atk: at90('atk'),
  base_def: at90('def'),
  crit_rate: at90('critRate') || '0%',
  crit_dmg: at90('bonus') || '0%',
  elemental_mastery: '', stamina_recovery: '',
  desc: g('介绍'),
  chara_info: {
    vision: g('月之轮') || g('元素属性'),
    constellation: g('命之座'),
    region: g('所属地区'),
    title: g('称号'),
    birth: (() => { const b = (d.other?.['生日'] || '').match(/(\d+)月(\d+)日/); return b ? [b[1], b[2]] : []; })(),
    release_date: (g('实装日期') || '').replace(/（.*?）/, '').trim(),
  },
  skills: skillObjs,
  constellations: (d.constellations || []).map(c => ({ name: c.name, desc: c.desc })),
  // 天赋直接取 parseSkillBlocks 标好的 kind==='passive'，不再靠倍率表反推。
  passives: blocks.filter(b => b.kind === 'passive' && b.desc)
    .map(b => ({ name: b.name, desc: b.desc, unlock: b.unlock || '' })),
  // levelUp / skillUp 都要传，否则「材料总览」里升级材料与技能书两组是空的。
  // talents 保持空：Bwiki 没有与 gsRoleView 期望形态对应��天赋材料。
  materials: {
    ascensions,
    talents: [],
    levelUp: d.materials?.levelUp || [],
    skillUp: d.skillMats || [],
  },
};

const view = gsRoleView(detail, '');
view.ppath = 'file://' + XHH + '/resources/';
view.sys = { scale: 1 };
view.name = who;
view.icon = portrait;
view.source = '数据来源 wiki.biligame.com';
// 角色档案：基础信息 + 其他信息合成一张键值表。顺序按维基页面的排布来，
// 去掉「介绍」和「TAG」这类长文本（简介区块单独有），避免档案块被撑得过长。
const SKIP = new Set(['介绍', 'TAG', '个人任务', '衣装', '祈愿名']);
const ORDER = ['称号', '全名/本名', '稀有度', '常驻/限定', '性别', '种族', '所属地区', '出身地区',
  '月之轮', '武器类型', '羁绊属性', '命之座', '特殊料理', '实装日期',
  '中文CV', '日文CV', '英文CV', '韩文CV', '生日', '体型', '昵称/外号', '所属', '身份',
  '游逸旅闻', '尘歌壶', '名片', '卡牌', '卡池信息', '幻想真境剧诗', '专属交互事件'];
const flatVal = v => (Array.isArray(v) ? v.filter(Boolean).join('、') : (v ?? ''));
view.profile = [];
for (const k of ORDER) {
  let v = flatVal(d.basic?.[k]);
  if (!v || !String(v).trim()) v = flatVal(d.other?.[k]);
  v = String(v).trim();
  if (!v || v === '-' || SKIP.has(k)) continue;
  if (k === '稀有度') v = String(v).replace(/\.png$/i, '').trim();
  // 徽章图标：所属地区/出身地区/稀有度/特殊料理这几个字段在维基里带图标（parse.mjs 的 basicIcons）
  view.profile.push({ k, v, icons: (d.basicIcons?.[k] || []).map(x => x.icon).filter(Boolean) });
}
// 顶部徽章也带图标。topBadges 的字段与档案表重叠，直接从 profile 里挑出来复用。
// 稀有度已经画在标题的星级上了，所属地区/出身地区在 tags 里也有纯文字版本，
// 直接全带上会出现「挪德卡莱」两个。这里按值去重：顶部 tags 里已出现过的就不再加。
const shownTagText = [view.element, view.region, view.constellation]
  .filter(Boolean).map(String).map(x => x.trim());
view.topBadges = (view.profile || [])
  .filter(x => x.icons && x.icons.length && x.k !== '稀有度')
  .map(x => ({ k: x.k, v: x.v, icon: x.icons[0] }))
  .filter(x => !shownTagText.includes(String(x.v).trim()));
// 角色故事：正文里的换行要保留，Bwiki 渲染后 <br> 已被我转成换行
const storyList = (d.stories || []).map(x => ({
  title: String(x.title || '').replace(/\s*[（(]解锁条件[：:][^）)]*[）)]\s*$/, '').trim(),
  unlock: x.unlock || '',
  body: String(x.body || '').trim(),
}));
// 「角色详细」单独拎出来放基础属性上面，其余好感度故事仍走底部区块。
const detailIdx = storyList.findIndex(x => /角色详细|角色简介|角色介绍/.test(x.title));
view.detailStory = detailIdx >= 0 ? storyList[detailIdx] : (storyList[0] || null);
view.characterStory = storyList.filter((_, i) => i !== detailIdx);
// 材料图标换成 Bwiki 自己的（gsRoleView 默认按 nanoka 的 item id 拼，这里覆盖）
for (const st of view.ascensionStages || []) for (const m of st.mats) if (m._bwIcon) m.icon = m._bwIcon;

console.log('════ 输入到 gsRoleView ════');
console.log(`  立绘: ${(portrait || '(无)').slice(0, 90)}`);
console.log(`  技能: ${view.skills?.map(s => `${s.name}(${s.lines?.length}行)`).join('  ')}`);
console.log(`  命座: ${view.constellations?.length} 条`);
console.log(`  天赋: ${view.passives?.map(x => x.name + (x.unlock ? '(' + x.unlock + ')' : '')).join('  ') || '(无)'}`);
console.log(`  档案: ${view.profile?.length} 项 → ${view.profile?.map(x => x.k).join('、')}`);
console.log(`  突破: ${view.ascensionStages?.length} 阶  第一阶材料 ${view.ascensionStages?.[0]?.mats?.map(m => m.name + '×' + m.count).join(', ')}`);
console.log(`  命座全文示例: ${view.constellations?.[0]?.desc?.slice(0, 80)}`);

// ── 渲染 ──
const art = require('art-template');
const tplSrc = readFileSync(`${XHH}/resources/wiki/gs_role_nk.html`, 'utf8');
const css = readFileSync(`${XHH}/resources/wiki/gs_role_nk.css`, 'utf8');
const render = art.compile(tplSrc, { url: 'gs_role_nk' });
let out = render(view);
out = out.replace('{{ppath}}', 'file://' + XHH + '/resources/').replace(/<link[^>]*>/, `<style>${css}</style>`);
console.log(`\n  HTML ${out.length} 字符`);

const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1600, deviceScaleFactor: 2 });
await page.setContent(out, { waitUntil: 'networkidle0' });
const p = `/tmp/opencode/out/${who}-full.png`;
await (await page.$('body')).screenshot({ path: p });
console.log('  已出图:', p);
await browser.close();
