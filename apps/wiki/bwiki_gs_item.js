/* ══════════════ 原神武器 / 圣遗物（Bwiki 词条）══════════════
   Bwiki 版式与绝区零那套统一：顶部信息 + 分栏表格。

   页面结构（实测 雾切之回光 / 苍古自由之誓，两者一致）：
     标题下方 infobox 文本块：
       名称 / ★稀有度 / 攻击力 48-674 / 暴击伤害 9.6%-44.1%
       武器技能 - <技能名> + 技能描述 + 技能解析
       武器介绍 / 实装版本 / 获取途径 / 武器类型 / 武器TAG / 精炼材料 / 卡池信息
     <div class="YSCard YS-WeaponData"> 里的 YS-DataTable：详细面板（等级/基础攻击力突破前后/副属性）
     YSCard YS-WeaponMat：突破材料表 YS-MatTable
     「故事」段：正文
     「推荐角色」段：头像 + 名字

   注意：infobox 是**文本流**（一堆 div/span），不是表格，
   必须按行拆 + 「字段名 值」配对，不能按 <td> 切。
*/
// 与 wiki.js 里的角色名归一化规则保持一致（去掉间隔符与大小写）
const gsKey = v => String(v || '')
    .replace(/[\s·・\-—_「」『』《》【】\[\]()]/g, '')
    .toLowerCase();

const stripHtml = s => String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|tr|div|td|th|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8204;/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

const origIcon = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');
const decodeTxt = s => String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/&quot;/g, '"');

/** 百分比染蓝（与绝区零卡同一套视觉） */
export const paintNumbers = txt => String(txt || '')
    .replace(/\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*\s*%/g, run =>
        run.replace(/\d+(?:\.\d+)?/g, n => `<span class="num">${n}</span>`))
    .replace(/(?<![\d/])([\d.]+)\s*%/g, '<span class="num">$1</span>')
    .replace(/<span class="num">([\d.]+)<\/span>\s*%/g, '<span class="num">$1%</span>')
    .replace(/<span class="num">\s*<\/span>/g, '');

/** 取顶层表格（正确处理嵌套），非贪婪正则会在第一个 </table> 截断 */
function topLevelTables(html) {
    const src = String(html || '');
    const out = [];
    let depth = 0, start = -1;
    const tagRe = /<table\b[^>]*>|<\/table>/g;
    let m;
    while ((m = tagRe.exec(src))) {
        if (m[0][1] === '/') {
            depth--;
            if (depth === 0 && start >= 0) { out.push(src.slice(start, m.index + m[0].length)); start = -1; }
        } else {
            if (depth === 0) start = m.index;
            depth++;
        }
    }
    return out;
}


/**
 * 故事正文排版：Bwiki 正文里每句话后面都有 <br>，纯文本化后每句各占一行，
 * 卡面行数会暴涨（1145 字能撑出四五十行）。
 * 中文不需要空格，所以把**单换行直接合并**（让它按容器宽度自然折行），
 * 只保留真正的段落分隔（空行 →\n\n）。
 */
const flowStory = txt => String(txt || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\u0000')      // 段落分隔先占位
    .replace(/\n/g, '')                 // 软换行合并
    .replace(/\u0000/g, '\n\n')       // 还原段落
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/** 武器页卡池信息：UP次数 + 各期祈愿时间段。 */
function parseGacha(html) {
    const frame = (html.match(/卡池信息[\s\S]*?<div[^>]*class="ys-collapse-frame"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i) || [])[1] || '';
    if (!frame) return null;
    const upCount = Number((frame.match(/UP次数[：:]\s*(\d+)\s*次/) || [])[1]) || 0;
    const banners = [];
    const re = /<p>[\s\S]*?<\/a>\s*-\s*([^<]+)<\/p>\s*<ul><li>([^<]+)<\/li>/gi;
    for (const m of frame.matchAll(re)) {
        const version = stripHtml(m[1]).trim();
        const period = stripHtml(m[2]).trim();
        if (version && period) banners.push({ version, period });
    }
    return banners.length ? { upCount, banners } : null;
}

/**
 * 解析原神武器/圣遗物词条。
 * @param {string} html Bwiki 页面 HTML
 * @param {'wq'|'syw'} type 武器 / 圣遗物
 */
export function parseGsBwikiItem(html, type = 'wq') {
    if (!html) return null;
    const out = {
        name: '', rarity: '', stars: 0, atk: '', sub: '', subName: '',
        skillName: '', skillDesc: '', skillNote: '', skillLabel: '武器技能', intro: '',
        version: '', obtain: '', typeName: '', tags: '', refine: '', pool: '',
        panel: [], panelHead: [], materials: [], materialTotal: [], story: '', agents: [], agentsSubjective: false,
        gacha: null, icon: '',
    };
    const text = stripHtml(html);

    // ── infobox 文本流 ──
    const lines = text.split('\n').map(v => v.trim()).filter(Boolean);
    // 名称 + 星级：正文第一行就是道具名、第二行是 ★★★（页面无 <h1>，别去找 h1）
    const starIdx = lines.findIndex(v => /^★+$/.test(v));
    if (starIdx > 0) {
        out.stars = lines[starIdx].length;
        // ★ 上面紧邻的是图栏标签（初始外观 / 突破2阶后…），要往上找到真正的道具名：
        // 取第一个「不是标签」的短行。标签特征是以「初始外观/突破」开头。
        for (let i = starIdx - 1; i >= Math.max(0, starIdx - 8); i--) {
            const v = lines[i];
            if (!v || /^(初始外观|突破|Appearance|突破\d)/.test(v)) continue;
            if (v.length > 20) continue;
            out.name = v;
            break;
        }
    }
    // 「圣遗物图鉴」页没有 ★ 星级行，名字在 <div class="name"> 或面包屑里
    if (!out.name) {
        const nm = stripHtml((html.match(/<div class="name">([\s\S]*?)<\/div>/) || [])[1] || '')
            || (html.match(/首页\s*&gt;\s*[\u4e00-\u9fa5]+图鉴\s*&gt;\s*([^<\n]+)</) || [])[1] || '';
        out.name = nm.replace(/&#160;|\u00a0/g, '').trim();
    }
    const fieldOf = re => (text.match(re) || [])[1]?.trim() || '';
    // 攻击力取「48-674」区间的满级值（674）；副属性支持暴击率，此前只认暴击伤害，
    // 赤月之形等副属性为暴击率的武器会被解析成空。
    out.atk = fieldOf(/攻击力\s*[\d.]+\s*-\s*([\d.]+)/);
    out.sub = fieldOf(/(?:暴击伤害|暴击率)\s*([\d.]+%\s*-\s*[\d.]+%)/);
    out.subName = /暴击伤害/.test(text) ? '暴击伤害'
        : /暴击率/.test(text) ? '暴击率'
            : /元素充能效率/.test(text) ? '元素充能效率'
                : /元素精通/.test(text) ? '元素精通' : '';
    out.version = fieldOf(/实装版本\s*\n?\s*([\d.]+)/);
    out.obtain = fieldOf(/获取途径\s*\n?\s*([^\n]+)/);
    out.typeName = fieldOf(/(?:武器类型|套装类型)\s*\n?\s*([^\n]+)/);
    out.tags = fieldOf(/(?:武器TAG|圣遗物TAG)\s*\n?\s*([^\n]+)/);
    out.refine = fieldOf(/精炼材料\s*\n?\s*([^\n]+)/);
    out.intro = fieldOf(/武器介绍\s*\n?\s*([^\n]+)/) || fieldOf(/圣遗物介绍\s*\n?\s*([^\n]+)/);
    out.pool = fieldOf(/卡池信息\s*\n?\s*([^\n]+)/);
    out.gacha = parseGacha(html);

    // 技能 / 套装效果
    if (type === 'wq') {
        const m = text.match(/武器技能\s*-\s*([^\n]+)/);
        out.skillName = (m?.[1] || '').trim();
        const start = text.indexOf('武器技能');
        const end = text.indexOf('武器介绍') > 0 ? text.indexOf('武器介绍') : text.length;
        if (start >= 0) {
            let seg = text.slice(start, end).replace(/^武器技能\s*-\s*[^\n]+/, '').trim();
            const noteIdx = seg.indexOf('技能解析');
            if (noteIdx > 0) {
                out.skillDesc = seg.slice(0, noteIdx).trim();
                out.skillNote = seg.slice(noteIdx + 4).trim();
            } else {
                out.skillDesc = seg;
            }
        }
    } else {
        // 圣遗物：Bwiki 上有**两套页面**，别只认一种 ——
        //   A)「圣遗物图鉴」页（如 血红之证）：table.effect 里就是 2件套 / 4件套，
        //      另有 TAG / 实装版本 / 基础属性 / 获取方式。**套装效果在这页**。
        //   B) 武器同款模板页（如 苍古自由之誓）：给的是攻击力/元素精通/武器技能，
        //      没有套装效果 —— 之前我只抓到这类，误判成「Bwiki 没有套装效果」。
        // 优先按 A 解析 2/4 件套；A 取不到再走 B 的技能块。
        for (const t of topLevelTables(html)) {
            const cls = (t.match(/class="([^"]*)"/) || [])[1] || '';
            if (!/(^|\s)effect(\s|$)/.test(cls)) continue;
            for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => stripHtml(x[1]));
                if (cs.length < 2) continue;
                const key = cs[0].replace(/\s+/g, '');
                const val = cs.slice(1).join(' ').replace(/\s+/g, ' ').trim();
                if (/^2件套/.test(key)) out.set2 = val;
                else if (/^4件套/.test(key)) out.set4 = val;
            }
            if (out.set2 || out.set4) break;
        }
        // TAG / 实装版本 在 <div class="tag"> 里：「TAG：暴击率」「实装版本：7.0」
        const tagM = [...html.matchAll(/<div class="tag"[^>]*>([\s\S]*?)<\/div>/g)]
            .map(m => stripHtml(m[1])).filter(Boolean);
        for (const v of tagM) {
            const g = (re) => (v.match(re) || [])[1]?.trim() || '';
            if (!out.tags) out.tags = g(/^TAG[：:]\s*(.+)$/);
            if (!out.version) out.version = g(/^实装版本[：:]\s*([\d.]+)$/);
        }
        // 获取方式
        const gi = html.indexOf('获取方式');
        if (gi >= 0) {
            // 这一段后面还跟着 <style> 的 CSS 文本，纯文本化会把 .access{…} 也带出来，
            // 所以先按 <div class="item"> 截断，只取列表内容。
            const raw = html.slice(gi, gi + 6000).split('<div class="item">').slice(0, 2).join(' ');
            const seg = stripHtml(raw).replace(/\s*\n\s*/g, ' ').trim();
            const m = seg.match(/(副本|兑换|商店|途径|获取)[^A-Za-z]{0,60}/);
            // 去掉标题残留与句尾多余符号
            out.obtain = m ? m[0].replace(/^获取方式\s*/, '').replace(/[.\s]+$/, '').trim() : '';
        }
        out.set2 = paintNumbers(out.set2);
        out.set4 = paintNumbers(out.set4);
        // B 类页面才有「武器技能 - xxx」
        if (!out.skillName && /武器技能\s*-\s*([^\n]+)/.test(text)) {
            out.skillLabel = '套装技能';
            out.skillName = (text.match(/武器技能\s*-\s*([^\n]+)/) || [])[1].trim();
            const st = text.indexOf('武器技能');
            const en = text.indexOf('武器介绍') > 0 ? text.indexOf('武器介绍') : text.indexOf('圣遗物介绍');
            if (st >= 0) {
                let seg = text.slice(st, en > 0 ? en : st + 900).replace(/^武器技能\s*-\s*[^\n]+/, '').trim();
                const ni = seg.indexOf('技能解析');
                if (ni > 0) { out.skillDesc = seg.slice(0, ni).trim(); out.skillNote = seg.slice(ni + 4).trim(); }
                else out.skillDesc = seg;
            }
            out.skillDesc = paintNumbers(out.skillDesc);
            out.skillNote = paintNumbers(out.skillNote);
        }
    }
    out.skillDesc = paintNumbers(out.skillDesc);
    out.skillNote = paintNumbers(out.skillNote);

    // ── 详细面板 ──
    for (const t of topLevelTables(html)) {
        const cls = (t.match(/class="([^"]*)"/) || [])[1] || '';
        if (!/YS-DataTable|HS-DataTable|DataTable/.test(cls)) continue;
        const rows = [...t.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]);
        let head = [];
        for (const tr of rows) {
            const cs = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => stripHtml(x[1]));
            if (!cs.length) continue;
            if (/等级/.test(cs[0]) && cs.length > 1) { head = cs; continue; }
            if (/突破前|突破后/.test(cs.join(''))) continue;
            const cells = [];
            for (let i = 1; i < cs.length; i++) {
                if (!/^[-\d.]+%?$/.test(cs[i])) continue;
                cells.push({ v: cs[i], span: /-$/.test(cs[i]) && cs[i] === '-' ? 1 : 0 });
            }
            if (!cells.length) continue;
            // 「-」表示该等级没有突破后数据（如 90 级），标记出来给模板 colspan
            out.panel.push({ lv: cs[0], cells });
        }
        if (head.length) out.panelHead = head;
        if (out.panel.length) break;
    }
    /* 详细面板只保留最高等级（90 级）那一行，并把「突破前/突破后」合并成单一攻击力。
       武器卡只需要展示满级数值，表头也只保留「等级 | 基础攻击力 | 副属性」。 */
    if (out.panel.length > 1) {
        const lvOf = r => Number(String(r?.lv ?? '').replace(/[^\d.]/g, ''))
        const hasVal = r => (r.cells || []).some(c => c && c.v && c.v !== '-')
        const rows = out.panel.filter(hasVal)
        if (rows.length) {
            const top = rows.reduce((a, b) => (lvOf(b) > lvOf(a) ? b : a))
            out.panel = [top]
        }
    }
    for (const r of out.panel) {
        const vals = r.cells.map(c => c.v);
        const before = vals[0] ?? '-';
        const after = vals[1] ?? '-';
        const sub = vals[2] ?? '-';
        const atk = after !== '-' ? after : before;   // 优先取突破后，没有则取突破前
        r.cells = [{ v: atk, span: 0 }, { v: sub, span: 0 }];
    }

    // ── 突破材料 ──
    for (const t of topLevelTables(html)) {
        const cls = (t.match(/class="([^"]*)"/) || [])[1] || '';
        if (!/YS-MatTable|MatTable/.test(cls)) continue;
        for (const tr of [...t.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0])) {
            // 阶段名在 <th> 里（「20级<br>突破」），材料在后面的 <td> ——
            // 只取 <td> 会把第一个材料格当成阶段，整行材料全丢。
            const th = (tr.match(/<th[^>]*>([\s\S]*?)<\/th>/) || [])[1] || '';
            const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
            if (!tds.length) continue;
            const stage = stripHtml(th).replace(/\s+/g, '');
            // 每个材料是一个 div.YSCard-BtnMatInfo：img alt = 材料名，
            // div.mat-name = 名称、div.mat-num = 数量
            const items = [];
            // 阶段名在 <th>，所以这里要遍历**全部** <td>（ slice(1) 会漏掉第一格材料）
            for (const raw of tds) {
                // 每个材料块：img + mat-name + 「mat-num: x<big>5</big>」，
                // 块尾还跟着 <a><div class="mat-cover">，所以不能用 </div></div> 收尾 ——
                // 改成「从 YSCard-BtnMatInfo 到下一个 YSCard-BtnMatInfo 或行尾」。
                const blocks = raw.split(/<div class="YSCard-BtnMatInfo">/).slice(1);
                for (const b of blocks) {
                    const img = origIcon((b.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
                    const nm = stripHtml((b.match(/<div class="mat-name">([\s\S]*?)<\/div>/) || [])[1] || '')
                        || decodeTxt((b.match(/<img[^>]*alt="([^"]+?)\.png"/) || [])[1] || '').trim();
                    const numRaw = (b.match(/<div class="mat-num">([\s\S]*?)<\/div>/) || [])[1] || '';
                    const num = ((numRaw.match(/<big>([\d.]+)<\/big>/) || [])[1]
                        || stripHtml(numRaw).replace(/[^\d.]/g, '')).trim();
                    if (nm && !items.some(x => x.name === nm)) items.push({ name: nm, num, img });
                }
            }
            if (!items.length) {
                for (const raw of tds) {
                    const txt = stripHtml(raw).replace(/\s+/g, ' ').trim();
                    const m = txt.match(/^([\d.]+)\s*(.+)$/);
                    if (m && !items.some(x => x.name === m[2])) items.push({ name: m[2], num: m[1], img: '' });
                }
            }
            if (!stage || !items.length) continue;
            out.materials.push({ stage, items });
        }
        if (out.materials.length) break;
    }
    // 总计：材料表后面那张「总计」表
    const totalIdx = text.indexOf('总计');
    if (totalIdx > 0) {
        const seg = text.slice(totalIdx, totalIdx + 200).replace(/\s*\n\s*/g, ' ');
        for (const m of seg.matchAll(/([\d.]+[万亿]?)\s*([^\s\d][^\s]*)/g)) {
            const nm = m[2].trim();
            if (!nm || out.materialTotal.some(x => x.name === nm)) continue;
            out.materialTotal.push({ name: nm, num: m[1] });
        }
    }

    /* 总计兜底：**自己从分级数据汇总**。
       Bwiki 武器页没有「总计」那张表（邦布页才有），所以 materialTotal 一直是空，
       模板只能回退到分级明细（6 行，）。
       这里按材料名把各突破档的数字加起来；同档材料去重（同级不会重复出现）。
       数字带「万/亿」的按原样保留文字，不做单位换算，避免算出错误数字。 */
    if (!out.materialTotal.length && out.materials.length) {
        const bag = new Map()
        for (const row of out.materials) {
            for (const it of row.items || []) {
                if (!it?.name) continue
                const prev = bag.get(it.name)
                if (!prev) { bag.set(it.name, { name: it.name, num: it.num, img: it.img || '' }); continue }
                const a = parseFloat(String(prev.num).replace(/[^\d.]/g, ''))
                const b = parseFloat(String(it.num).replace(/[^\d.]/g, ''))
                if (Number.isFinite(a) && Number.isFinite(b)) prev.num = String(a + b)
            }
        }
        out.materialTotal = [...bag.values()]
    }

    // ── 图标：文件名就是道具名 ──
    const ic = html.match(new RegExp(`<img[^>]*alt="${(out.name || '').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^"]*"[^>]*src="([^"]+)"`))
        || html.match(/<img[^>]*alt="[^"]*?(?:圣遗物|武器)[^"]*?\.png"[^>]*src="([^"]+)"/);
    if (ic) out.icon = origIcon(ic[1]);

    /* ── 兜底：把页面上的表格原样带出去（除已认领的套装效果表）──
       原神四星圣遗物（磐岩结绿这类）页面上没有 2/4 件套、没有故事，
       只有「单件属性表」和「突破材料表」。这些也是数据，
       统一模板里有「详细数据」区渲染它们，比只留名字和星级强。 */
    if (type === 'syw') {
        const effectTables = new Set(
            topLevelTables(html).filter(t => /(^|\s)effect(\s|$)/.test((t.match(/class="([^"]*)"/) || [])[1] || ''))
        );
        out.tables = topLevelTables(html)
            .filter(t => !effectTables.has(t) && /<t[hd][\s\S]*?<\/t[hd]>/.test(t))
            .slice(0, 3)
            .map((t, i) => ({ label: i === 0 ? '详细数据' : `详细数据 ${i + 1}`, html: t }));
    }

    // ── 故事 ──
    // 两套页面结构都要认：
    //   武器页 / 武器模板的圣遗物页：<h2><span class="mw-headline" id="故事">故事</span></h2>
    //   圣遗物图鉴页：<div class="intext"><div class="title">圣遗物故事</div> … resp-tab-content …
    // 之前只按 id="故事" 找，圣遗物图鉴页整段被漏掉。
    {
        const byAnchors = [html.indexOf('id="故事"'), html.indexOf('id="圣遗物故事"')].filter(v => v > 0);
        if (byAnchors.length) {
            const si = Math.min(...byAnchors);
            // mw-headline 的 id 与标题文字之间还夹着锚点 span，纯文本化后会留下
            // `id="故事">故事` 这种残渣，要一并去掉（下面 strip 后再清一次）。
            let seg = stripHtml(html.slice(si, si + 8000))
                .replace(/^\s*id=\"[^\"]*\"\s*>/, '')
                .replace(/^\s*(故事|圣遗物故事)/, '')
                .replace(/^\s*展开\/折叠\s*/, '')
                .trim();
            const e = seg.search(/推荐角色|相关角色|ROLLOUT|编辑/);
            if (e > 0) seg = seg.slice(0, e);
            out.story = flowStory(seg);
        }
    }
    if (!out.story) {
        // div.title 文本为「圣遗物故事」的块
        const ti = html.indexOf('>圣遗物故事<');
        if (ti > 0) {
            const seg = stripHtml(html.slice(ti, ti + 12000))
                .replace(/^\s*>?\s*圣遗物故事/, '').trim();
            const e = seg.search(/速查|获取方式|相关角色|推荐角色|编辑/);
            const body = (e > 0 ? seg.slice(0, e) : seg).trim();
            // 页签之间是同一段故事的不同「部位」文案，重复的段落去掉
            const seen = new Set();
            // 先按行去重（页签之间会重复同一段），再合并软换行
            const dedup = [];
            for (const line of body.split('\n')) {
                const k = line.trim();
                if (!k || seen.has(k)) continue;
                seen.add(k);
                dedup.push(k);
            }
            out.story = flowStory(dedup.join('\n'));
        }
    }

    // ── 推荐角色 + 推荐说明 ──
    // 星铁页的推荐块是 mw-headline 锚点 id="推荐角色"；原神页没有锚点，
    // 是 <div class="recommended">（见 relic_view.js RULES.gs.agentScope 的注释）。
    // 之前只认锚点写法，原神的推荐角色与推荐说明整段取不到，agents 恒为空。
    let ri = html.indexOf('id="推荐角色"');
    if (ri < 0) ri = html.search(/class="recommended"/);
    if (ri >= 0) {
        const seg = html.slice(ri, ri + 40000);
        // alt 形如「无背景-角色-神里绫华.png」（不是「角色头像-xxx」）
        /* 推荐说明在同一段里：每个 roleicon 卡后面跟一个
           `<div class="main"><div class="title">推荐说明</div><div class="item">…</div></div>`。
           只按「下一个 roleicon 之前」切段，多条说明（同一角色可能拆成几段）用换行拼起来。 */
        const cards = [...seg.matchAll(/<div class="L">([^<]+)<\/div>/g)]
        for (let ci = 0; ci < cards.length; ci++) {
            const nm = decodeTxt(cards[ci][1]).trim();
            if (!nm) continue;
            const from = cards[ci].index + cards[ci][0].length
            const to = cards[ci + 1]?.index ?? seg.length
            const parts = [...seg.slice(from, to).matchAll(/<div class="main">([\s\S]*?)<\/div>\s*<\/div>/g)]
                .map(m => decodeTxt(stripHtml(m[1]).replace(/^推荐说明/, '')).replace(/\s+/g, ' ').trim())
                .filter(Boolean)
            const reason = parts.join('\n')
            const exist = out.agents.find(a => a.name === nm)
            if (exist) { if (!exist.reason && reason) exist.reason = reason; continue }
            const imgM = seg.slice(Math.max(0, cards[ci].index - 1200), cards[ci].index).match(/<img[^>]*alt="无背景-角色-([^"]+?)\.png"[^>]*src="([^"]+)"/)
            out.agents.push({ name: nm, icon: imgM ? origIcon(imgM[2]) : '', reason })
        }
        /* 这段在 Bwiki 上自带「以下内容可能存在主观性」声明（编辑者观点）。
           头像本来就是这段的数据，所以理由同源；把声明一并带出去，不假装是官方数据。 */
        out.agentsSubjective = /以下内容可能存在主观性/.test(seg.slice(0, 2000))
    }

    /* 页面归属判定（重要）：
       「苍古自由之誓」这个标题在 Bwiki 上是**同名武器页**（枫火的五星弓），
       而圣遗物套装里也有一套叫苍古自由之誓 —— 两者共用一个标题，只有武器页存在。
       所以按圣遗物去查时可能命中的是**武器页**，这时绝不能把
       攻击力 / 元素精通 / 武器技能 / 武器面板 当成圣遗物数据显示，
       只保留故事、推荐角色、图标这些与类型无关的字段，
       套装效果交给米游社 desc2/desc4 兜底。 */
    out.pageKind = /武器技能|武器介绍|武器类型/.test(text) ? 'wq' : 'artifact';
    // 按圣遗物查、却命中**武器页**时直接放弃 Bwiki 版式（返回 null → 调用方回落原圣遗物卡）。
    // 典型case：苍古自由之誓是枫火的五星弓，Bwiki 圣遗物一览 63 套里并没有这套，
    // 所以它根本没有圣遗物页；硬拼一张卡只会缺面板/材料/套装效果，不如用原卡。
    if (type === 'syw' && out.pageKind === 'wq') return null;
    // 反向同理：按武器查询、却命中圣遗物页（血红之证这类只有圣遗物页的套装）时返回 null，
    // 让 weapon() 落空，查询继续交给 syw_yiqi 出圣遗物卡。
    // 缺这道闸时，weapon() 会以仅有故事的残缺数据截胡圣遗物单查，表现为套装属性消失。
    if (type === 'wq' && out.pageKind === 'artifact') return null;

    /* 圣遗物页只要抓到内容就算成功。四星套装（磐岩结绿这类）页面上
       **没有** 2/4 件套、没有故事，只有单件属性表/突破材料表 ——
       以前的成功条件里没有 tables，于是整页被判为「没数据」返回 null，
       卡面就只剩列表层的名字/星级/版本。现在把 tables 也算作有效数据。 */
    const ok = out.panel.length || out.materials.length || out.skillName || out.set2 || out.set4
        || out.story || (out.tables?.length);
    return ok ? out : null;
}

const cache = new Map();
const CACHE_TTL = 12 * 3600 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 按名字取 Bwiki 词条 HTML（页面名与正式名一致） */
export async function fetchGsBwikiItemHtml(name) {
    const key = `item:${gsKey(name)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
    // Bwiki 有 EdgeOne 安全策略，连续请求会返 **567**（返回的是 HTML 拦截页，不是 JSON）。
    // 实测连续抓 5 个条目就会撞上，所以这里必须：识别 567 → 退避重试，
    // 而不是当成「页面不存在」直接返回空（否则命令会误回落）。
    // 失败原因要分清，否则日志里只看到「没抓到」，排查时无从下手：
    //   blocked = 拿到非 JSON（腾讯 EdgeOne 567 风控拦截页）→ 值得退避重试
    //   missing = JSON 正常但 parse.text 为空 → 页面真的不存在，重试无意义
    const wait = ms => sleep(ms);
    let blocked = 0;
    let lastReason = '';
    for (let i = 0; i < 5; i++) {
        try {
            const u = `https://wiki.biligame.com/ys/api.php?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json&redirects=1`;
            const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
            const ct = String(r.headers.get('content-type') || '');
            if (!ct.includes('json')) {
                blocked++;
                lastReason = `风控拦截(HTTP ${r.status})`;
                // 567 退避要拉长：连续抓取时 500ms 级退避基本等于继续被拦
                await wait(2500 * (i + 1));
                continue;
            }
            const html = (await r.json())?.parse?.text?.['*'] || '';
            if (html) { cache.set(key, { t: Date.now(), v: html }); return html; }
            lastReason = '页面不存在(parse.text 为空)';
            break;
        } catch (e) {
            lastReason = `请求异常: ${e?.message || e}`;
            await wait(1500 * (i + 1));
        }
    }
    globalThis.logger?.info?.(`[xhh][bwiki_gs] ${name} 抓取失败：${lastReason}（被拦 ${blocked} 次）`);
    return '';
}

export async function fetchGsBwikiItem(name, type = 'wq') {
    const html = await fetchGsBwikiItemHtml(name);
    if (!html) return null;
    return parseGsBwikiItem(html, type);
}
