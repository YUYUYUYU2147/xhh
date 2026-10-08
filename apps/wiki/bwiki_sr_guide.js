// 星铁攻略：米游社 sr_wiki 的「光锥推荐 / 遗器推荐」模块
//
// 数据源（不需要签名，实测直接可取）：
//   https://api-takumi-static.mihoyo.com/common/blackboard/sr_wiki/v1/content/info
//     ?content_id=<id>&app_sn=sr_wiki
// 返回 JSON，rpg_new_tmp_content.modules 里按名字挂载各块，其中：
//   光锥推荐 / 遗器推荐 / 配队推荐 → components[0].data（JSON 字符串）里的 richText（HTML）
//
// 两块 richText 都是规整的表格，不用猜下标：
//   光锥：每 4 行一条 —— [图]+名称 / 生攻防 / 推荐度★★★★ / 定位词+效果全文
//   遗器：每 5 行一套 —— 隧洞遗器+四件套 / 位面饰品+饰品 / 推荐指数★ / ※主词条 / ※副词条
//
// 取舍（卡面空间有限）：
//   光锥保留 名称 + 图标 + 推荐度 + 定位词；丢掉生攻防（页面已有基础属性）和效果全文（太长）
//   遗器保留 四件套 + 位面饰品 + 图标 + 推荐指数 + 主词条 + 副词条
const API = 'https://api-takumi-static.mihoyo.com/common/blackboard/sr_wiki/v1/content/info';
const CACHE_TTL = 12 * 3600 * 1000;
const cache = new Map();

const plain = s => String(s || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 取某个 content 的模块 richText（按模块名） */
async function fetchModuleRichText(contentId, moduleName) {
  const key = `${contentId}:${moduleName}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let rich = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${API}?content_id=${contentId}&app_sn=sr_wiki`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://bbs.mihoyo.com/' },
        signal: AbortSignal.timeout(15000),
      });
      if (!(r.headers.get('content-type') || '').includes('json')) { await new Promise(s => setTimeout(s, 1200)); continue; }
      const j = await r.json();
      const mods = j?.data?.content?.rpg_new_tmp_content?.modules || [];
      const mod = mods.find(m => m?.name === moduleName);
      const comp = mod?.components?.[0];
      if (!comp?.data) break;
      try { rich = JSON.parse(comp.data)?.richText || ''; } catch { rich = ''; }
      break;
    } catch { await new Promise(s => setTimeout(s, 1000)); }
  }
  cache.set(key, { t: Date.now(), v: rich });
  return rich;
}

/** HTML 表格 → 行数组（每格 { t, img }） */
function rows(html) {
  return [...String(html || '').matchAll(/<tr[\s\S]*?<\/tr>/g)].map(tr =>
    [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => ({
      t: plain(c[1]),
      img: (c[1].match(/data-image-url="([^"]+)"/) || c[1].match(/<img[^>]*src="([^"]+)"/) || [])[1] || '',
    })));
}

/** 光锥推荐：每 4 行一条 */
export function parseSrLightconeGuide(html) {
  const R = rows(html);
  const out = [];
  for (let i = 0; i + 3 < R.length; i += 4) {
    const head = R[i];
    const name = String(head[head.length - 1]?.t || '').trim();
    if (!name) continue;
    const stats = String(R[i + 1][0]?.t || '').trim();          // 生1058 攻423 防661
    const scoreRow = String(R[i + 2][0]?.t || '').trim();       // 推荐度★★★★★
    const descRow = String(R[i + 3][0]?.t || '').trim();        // 定位词 + 效果全文
    out.push({
      name,
      icon: head.find(c => c.img)?.img || '',
      stats,
      score: (scoreRow.match(/★+/) || [''])[0],
      // 效果全文第一段就是定位词（「全下」「决断」「珍存」…），其余丢掉
      tag: descRow.split(/\\s{2,}|(?=[使使])/)[0]?.slice(0, 8) || '',
    });
  }
  return out;
}

/** 遗器推荐：每 5 行一套 */
export function parseSrRelicGuide(html) {
  const R = rows(html);
  const out = [];
  for (let i = 0; i + 4 < R.length; i += 5) {
    const set4 = String(R[i][1]?.t || R[i][0]?.t || '').replace(/四件套/, '').trim();
    const planar = String(R[i + 1][1]?.t || R[i + 1][0]?.t || '').trim();
    if (!set4 && !planar) continue;
    const score = (String(R[i + 2][1]?.t || '').match(/★+/) || [''])[0];
    out.push({
      set4,
      planar,
      icon: R[i].find(c => c.img)?.img || R[i + 1].find(c => c.img)?.img || '',
      score,
      // 「【躯干】效果命中/防御力 【脚部】速度…」拆成条目，模板里更好排
      main: [...String(R[i + 3][1]?.t || '').matchAll(/【([^】]+)】([^【]*)/g)]
        .map(m => ({ slot: m[1].trim(), value: m[2].trim() })).filter(x => x.slot),
      sub: String(R[i + 4][1]?.t || '').trim(),
    });
  }
  return out;
}

/**
 * 抓一个角色的光锥 + 遗器推荐。
 * contentId 来自 sr_content_id.json（一次性扫出来的 角色名 → content_id 映射）。
 * 任何一块拿不到就返回空数组，调用方按「有就用、没有就跳过」处理。
 */
export async function fetchSrGuide(contentId) {
  if (!contentId) return { lightcones: [], relics: [] };
  const [lcHtml, relicHtml] = await Promise.all([
    fetchModuleRichText(contentId, '光锥推荐'),
    fetchModuleRichText(contentId, '遗器推荐'),
  ]);
  return {
    lightcones: lcHtml ? parseSrLightconeGuide(lcHtml) : [],
    relics: relicHtml ? parseSrRelicGuide(relicHtml) : [],
  };
}