/* ══════════════ 星铁光锥 / 遗器（Bwiki 词条）══════════════
   版式与原神/绝区零那套统一。

   数据来源分两层：
   ① 列表层（fetchSrLcList / fetchSrRelicList，已在列表页用）：
      name / icon(无背景立绘) / baseImg(底版) / maskImg(顶层蒙版) / starIcon(星条)
      / pathIcon(命途图标) / ji(星级) / path(命途|侵蚀隧洞) / damage(限定跃迁) / version
      —— 这一层**一次请求就有 170 光锥 / 62 遗器**，是最稳的部分。
   ② 词条层（action=parse）：遗器页给的是「基本信息」表（套装图标 / 单件图标 /
      二件套效果 / 四件套效果）+ 遗器来历 + 搭配推荐 + 推荐角色；
      光锥页给的是光锥效果与详细面板。Bwiki 对 sr 站限流很凶（实测连续请求会 567），
      所以词条层抓不到时**不阻断**，直接用列表层出卡。

   为什么不用 c_30 之类的固定字段：这两页的表格 class 与原神/绝区零都不同，
   统一按「表头文本」识别，不写死 class。
*/
const srKey = v => String(v || '')
    .replace(/&amp;/g, '&')
    .replace(/[\s·・\-—_「」『』《》【】\[\]()]/g, '')
    .toLowerCase();

const stripHtml = s => String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|tr|div|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8204;/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

const origIcon = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');
const decodeTxt = s => String(s || '').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d)).replace(/&quot;/g, '"');

const paintNumbers = txt => String(txt || '')
    .replace(/\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*\s*%/g, run =>
        run.replace(/\d+(?:\.\d+)?/g, n => `<span class="num">${n}</span>`))
    .replace(/(?<![\d/])([\d.]+)\s*%/g, '<span class="num">$1</span>')
    .replace(/<span class="num">([\d.]+)<\/span>\s*%/g, '<span class="num">$1%</span>')
    .replace(/<span class="num">\s*<\/span>/g, '');

/** 故事正文：合并软换行，只保留段落分隔（与另几个游戏同一套） */
const flowStory = txt => String(txt || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\u0000')
    .replace(/\n/g, '')
    .replace(/\u0000/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/** 顶层表格（正确处理嵌套） */
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
 * 解析星铁遗器/光锥词条。
 * @param {string} html 页面 HTML
 * @param {'gz'|'yq'} type 光锥 / 遗器
 */
export function parseSrBwikiItem(html, type = 'gz') {
    if (!html) return null;
    const out = {
        icon: '', setIcons: [], pieceIcons: [], set2: '', set4: '', origin: '',
        talent: '', talentDesc: '', panel: [], panelHead: [], agents: [], stories: [],
        version: '', obtain: '', tags: '', materialTotal: [],
        baseStats: [], tag: '', date: '', art: '', pageIcon: '', desc: '',
    };
    const text = stripHtml(html);

    if (type === 'yq') {
        // 遗器：一张「基本信息」表里同时有套装图标 / 单件图标 / 二件套 / 四件套
        for (const t of topLevelTables(html)) {
            const txt = stripHtml(t);
            if (!/二件套效果|四件套效果/.test(txt)) continue;
            /* 图标：alt 是**道具名本身**（套装名.png / 散件名.png），不带「套装图标」字样，
               所以不能按 alt 关键字认；改成看表头那行「套装图标 | 单件图标」，
               再按列序取：第 1 列是套装图，第 2 列是 5 个散件图。 */
            const rows = [...t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)];
            const headRow = rows.find(tr => /套装图标/.test(stripHtml(tr)) && /单件图标/.test(stripHtml(tr)));
            if (headRow) {
                const headCols = [...headRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => stripHtml(x[1]));
                const setCol = headCols.findIndex(v => /套装图标/.test(v));
                const pieceCol = headCols.findIndex(v => /单件图标/.test(v));
                for (const tr of rows) {
                    if (tr === headRow) continue;
                    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
                    if (tds.length < 2) continue;
                    /* 页面上「套装图标 / 单件图标」这两行**内容完全重复**
                       （同一套装出现两次），逐行收就会变成 8 个散件图标
                       （实测「死水深潜的先驱」4 件套显示 8 个图）。
                       所以按 URL 去重。 */
                    const grab = idx => [...new Set([...String(tds[idx] || '').matchAll(/<img[^>]*src="([^"]+)"/g)].map(m => origIcon(m[1])))];
                    if (setCol >= 0) for (const u of grab(setCol)) if (!out.setIcons.includes(u)) out.setIcons.push(u);
                    if (pieceCol >= 0) for (const u of grab(pieceCol)) if (!out.pieceIcons.includes(u)) out.pieceIcons.push(u);
                }
            }
            for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => stripHtml(x[1]));
                if (cs.length < 2) continue;
                const body = cs.join('\n');
                if (/二件套效果/.test(body)) out.set2 = paintNumbers(body.replace(/^二件套效果/, '').trim());
                else if (/四件套效果/.test(body)) out.set4 = paintNumbers(body.replace(/^四件套效果/, '').trim());
                else if (/获取途径/.test(body)) out.obtain = body.replace(/^获取途径/, '').trim();
                else if (/实装版本/.test(body)) out.version = body.replace(/^实装版本/, '').trim();
                else if (/遗器描述|描述/.test(body)) out.origin = body.replace(/^[^\n]*描述/, '').trim();
            }
            if (out.set2 || out.set4) break;
        }
        // 遗器来历
        {
            // ⚠ 不能用 html.indexOf('id="遗器来历"')：目录里每个 toctext 都带这个锚点，
            // 命中的是目录而不是正文，会把「id="遗器来历">遗器来历[编辑]」当正文抓出来。
            const i = html.indexOf('mw-headline" id="遗器来历"');
            if (i >= 0) {
                const segHtml = html.slice(i, i + 20000);
                /* 遗器来历是**分件页签**：4 个 tab 标题（散件名）对应 4 段故事。
                   直接 stripHtml 会把 4 个 tab 名连在正文前面（实测开头变成
                   「伶人的悲泣假面伶人的斑斓折扇…」）。所以：
                     ① tab 名从 resp-tabs-list 里按顺序取，
                     ② 正文只取 display:block 的那个 resp-tab-content（当前选中件）。 */
                const tabs = [...segHtml.matchAll(/class="tab-panel"[^>]*>([^<]+)</g)].map(m => decodeTxt(m[1]).trim());
                const panes = [...segHtml.matchAll(/<div class="resp-tab-content"[^>]*>([\s\S]*?)<\/p>/g)].map(m => m[1]);
                const activeIdx = panes.findIndex(p => /display:\s*block/.test(p));
                const pane = panes[activeIdx >= 0 ? activeIdx : 0] || '';
                if (pane) {
                    const piece = tabs[activeIdx >= 0 ? activeIdx : 0];
                    const body = stripHtml(pane)
                        .replace(/^\s*[\[\]\s]+/, '')
                        .trim();
                    const cut = body.search(/搭配推荐|推荐角色|速查|获取途径|参考链接|编辑/);
                    let story = cut > 0 ? body.slice(0, cut) : body;
                    story = story.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
                    if (story) {
                        // 段首那句粗体是散件简介，作为标题行放在最前
                        const head = story.split('\n')[0].trim();
                        const rest = story.slice(head.length).trim();
                        out.origin = piece
                            ? `${piece}${head && head !== piece ? `\n${head}` : ''}${rest ? `\n${rest}` : ''}`
                            : story;
                        // 台词斜体，和光锥故事一套观感
                        out.origin = out.origin.replace(/(「[^」]{1,80}」|『[^』]{1,80}』)/g, '<i>$1</i>');
                    }
                }
            }
        }
    } else {
        /* 光锥：sr 站光锥页主表用的不是「光锥效果」而是
           「技能名称 / 技能效果」，另外还有「基础生命 / 基础攻击 / 基础防御」、
           「获取途径 / TAG / 实装日期 / 卡池信息」。
           早期版本按「光锥效果|基础攻击力」找，整页都搜不到（实测 -1），
           所以卡只有列表层字段。这里按表头文本逐行取。 */
        const rowsOf = t => (t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])
            .map(tr => [...tr.matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)]
                .map(c => ({ tag: c[1], v: stripHtml(c[2]).replace(/\s+/g, ' ').trim() })));
        for (const t of topLevelTables(html)) {
            for (const cs of rowsOf(t)) {
                const head = cs[0]?.v || '';
                if (!head || cs.length < 2) continue;
                const rest = cs.slice(1).map(c => c.v).filter(Boolean).join('\n');
                // ⚠ 技能名在**值列**（colspan=3 那一格），不在表头列：
                //   <td>技能名称</td><td colspan="3">挥墨</td>
                if (/^技能名称/.test(head)) out.talent = rest.replace(/\n/g, ' ').trim() || '光锥效果';
                else if (/^技能效果/.test(head)) {
                    // 「【以下效果仅对 欢愉 命途生效】」是生效范围说明，提到效果前面
                    const scope = (rest.match(/^【[^】]*】/) || [])[0] || '';
                    out.talentDesc = paintNumbers((scope ? scope + '\n' : '') + rest.replace(/^【[^】]*】/, '').trim());
                }
                else if (/^(基础生命|基础攻击|基础防御)/.test(head)) {
                    // 该行形如：基础生命 48 / 满级生命 1058
                    out.baseStats.push(`${head.replace(/^基础/, '')}${rest ? ` ${rest.replace(/\n/g, ' ')}` : ''}`);
                }
                else if (/^获取途径/.test(head)) out.obtain = rest.replace(/\n/g, ' / ');
                else if (/^TAG/.test(head)) out.tag = rest;
                else if (/^实装日期/.test(head)) out.date = rest;
            }
            if (out.talentDesc) break;
        }
        /* 详细面板：两级表头
             等级(rowspan=2) | 生命值(colspan=2) | 攻击力(colspan=2) | 防御力(colspan=2)
             突破前 突破后 ×3
           早期版本把 colspan=2 的一格当成单个值，20 级以下整行都被丢掉。 */
        for (const t of topLevelTables(html)) {
            const txt = stripHtml(t);
            if (!/等级/.test(txt) || !/攻击力/.test(txt)) continue;
            const groups = [];
            const rs = rowsOf(t);
            // 一级表头只取**第一行**的 th；rowspan 的就是「等级」列。
            // 全表扫 th 会把第二行 6 个「突破前/突破后」也算进来，表头就变成 12 列。
            const firstTr = (t.match(/<tr[^>]*>[\s\S]*?<\/tr>/) || [''])[0];
            const h1 = [...firstTr.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)];
            for (const c of h1) {
                const cs2 = Number((c[1].match(/colspan="(\d+)"/) || [])[1] || 1);
                if (/rowspan/.test(c[1])) continue;
                for (let k = 0; k < cs2; k++) groups.push(stripHtml(c[2]).trim());
            }
            const sub = (rs[1] || []).map(c => c.v);
            out.panelHead = groups.map((g, k) => `${g}·${sub[k] || ''}`.replace(/·$/, ''));
            for (const cs of rs.slice(2)) {
                if (!cs.length || !/^\d+$/.test(cs[0].v)) continue;
                const cells = [];
                for (let k = 1; k < cs.length; k++) {
                    const span = Number((cs[k].tag.match(/colspan="(\d+)"/) || [])[1] || 1);
                    const v = cs[k].v || '-';
                    for (let n = 0; n < span; n++) cells.push({ v });
                }
                out.panel.push({ lv: cs[0].v, cells });
            }
            if (out.panel.length) break;
        }
        /* 详细面板只保留最高等级那一行（与角色卡/邦布/原神武器同一口径）。
           顺带避免和上面的「基础属性」重复 —— 基础数值面板里已经有了。 */
        if (out.panel.length > 1) {
            const lvOf = r => Number(String(r?.lv ?? '').replace(/[^\d.]/g, ''))
            out.panel = [out.panel.reduce((a, b) => (lvOf(b) > lvOf(a) ? b : a))]
        }
        /* 面板不再分「突破前 / 突破后」：表头压成 生命值/攻击力/防御力 三列
           （「生命值·突破前/后」这类带后缀的先去掉后缀、再按相邻同组去重），
           单元格每组取突破后的值，该档没有突破后数据（满级行是「-」）时退回突破前。
           与原神武器卡（bwiki_gs_item.js）同一做法。 */
        out.panelHead = out.panelHead
            .map(g => String(g).replace(/·(突破前|突破后)$/, ''))
            .filter((g, i, arr) => g !== arr[i - 1]);
        for (const r of out.panel) {
            const vals = (r.cells || []).map(c => c.v);
            const merged = [];
            for (let i = 0; i < vals.length; i += 2) {
                const after = vals[i + 1] ?? '-';
                merged.push({ v: after !== '-' ? after : (vals[i] ?? '-') });
            }
            r.cells = merged;
        }

        /* 晋阶材料：小节里是一张 6 行的表 —— 等级标签行（<th>20级</th>）与数值行交替，
           数值单元格里有两个 .cailiaoxiao 块（材料、信用点），形如
             <div class="cailiaoxiao"><a …><img alt="古代零件" …></a><div>8</div></div>
           按名称累加成总计（信用点同样是这类块，一并计入）。
           旧模板 wiki/gz 一直有这一块，新版 sr_item_bwiki 没有 ——
           同一条指令会因数据源不同出两种版式，这里补上以对齐。 */
        {
            const at = html.indexOf('mw-headline" id="晋阶材料"');
            if (at >= 0) {
                const seg = html.slice(at, at + 20000);
                const t = (topLevelTables(seg) || [])[0] || '';
                const acc = new Map();
                for (const m of String(t).matchAll(/<div class="cailiaoxiao">([\s\S]*?)<\/div><\/div>/g)) {
                    const b = m[1] || '';
                    const name = decodeTxt((b.match(/<img[^>]*alt="([^"]*)"/) || [])[1] || '').trim();
                    const num = Number((b.match(/<div[^>]*>\s*([\d.]+)\s*<\/div>/) || [])[1] || 0);
                    if (!name || !num) continue;
                    const img = origIcon((b.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
                    const cur = acc.get(name) || { name, img, num: 0 };
                    cur.num += num;
                    acc.set(name, cur);
                }
                out.materialTotal = [...acc.values()];
            }
        }

        /* 故事：光锥页的正文是「单元格一整段」的表（没有表头），
           里面 <i>「……」</i> 是台词。<br /> 直接 stripHtml 会把台词和正文粘成一片，
           所以按 <br /> 断行、再给「……」套回斜体（flowStory 只合并软换行，不改语义）。 */
        for (const t of topLevelTables(html)) {
            const txt = stripHtml(t);
            // 排除主表（有技能效果）和面板表（有等级+攻击力）
            if (/技能效果|等级/.test(txt)) continue;
            if (txt.length < 120 || !/[「『]/.test(txt)) continue;
            let story = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
            // <i>…</i> 先换成占位符，stripHtml 后再还原成语速斜体标记，
            // 这样不用让 stripHtml 支持保留标签
            const italics = [];
            story = story.replace(/<i>([\s\S]*?)<\/i>/gi, (_, x) => {
                italics.push(stripHtml(x).replace(/\s+/g, ' ').trim());
                return `\u0001${italics.length - 1}\u0001`;
            });
            /* 光锥故事**排成一段**（：一行写完，没写完不得转行）。
               页面里每个单元格/每个 <br /> 都会留下换行，卡面上就成了一行一句；
               这里把所有换行（含段落空行）统统去掉，让浏览器按宽度自动折行。 */
            story = stripHtml(story)
                .replace(/[ \t\u00a0]+/g, ' ')
                .replace(/\n+/g, '')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
            // 还原 <i> 占位符（此时正文已 stripHtml 干净，可以安全回包标签）
            story = story.replace(/\u0001(\d+)\u0001/g, (_, n) => `<i>${italics[Number(n)] ?? ''}</i>`);
            // 原文里没包 <i> 的台词（如「真珠」出现在句尾）也补上斜体
            story = story.replace(/(?<!<i>)(「[^」]{1,80}」|『[^』]{1,80}』)(?!<\/i>)/g, '<i>$1</i>');
            if (story) { out.origin = story; break; }
        }
        // 立绘 + 卡片图标：两个都要。列表层的 thumb 要靠后台预热才填得上
        // （shrinkSrArt 没暖到的条目是空串），实测就因为这个左上角只剩占位字。
        for (const m of html.matchAll(/<img[^>]*alt="光锥-立绘-([^"]+?)\.png"[^>]*src="([^"]+)"/g)) {
            out.art = origIcon(m[2]);
            break;
        }
    }

    /* 卡片图（pageIcon）：遗器/光锥页都有一个「道具名.png」的方图
       （光锥是「献给明日的色彩.png」，遗器是「戏梦点星的伶人.png」）。
       列表层的 thumb 要靠后台预热才填得上，这层能兜住。
       要排掉的：真珠（未实装角色占位）、聊天表情、立绘、星级星条、命途图（xx-白/xx-黑）。 */
    for (const m of html.matchAll(/<img[^>]*alt="([^"]+?)\.png"[^>]*src="([^"]+)"/g)) {
        const alt = decodeTxt(m[1]).trim();
        if (/真珠|聊天表情|立绘|星|-白$|-黑$/.test(alt)) continue;
        out.pageIcon = origIcon(m[2]);
        break;
    }

    /* 遗器说明：星铁遗器页有个 mw-headline id="遗器说明" 的小节，写的是
       「该遗器套装适合……使用」这类成套推荐说明 —— 推荐角色小节里只有头像和链接，
       没有理由，这段就是星铁版的「推荐理由」，取出来填进 desc，
       模板的「推荐理由」区块三家就统一了。
       ⚠ 必须用 mw-headline 锚点定位：正文里「遗器说明」四个字在目录和相关页面
       链接里也会出现，用 indexOf('遗器说明') 会命中目录而不是正文。 */
    {
        const di = html.indexOf('mw-headline" id="遗器说明"');
        if (di >= 0) {
            let seg = stripHtml(html.slice(di, di + 4000)).trim()
                // stripHtml 会把标签换成换行，但属性的**引号内原文**仍可能留下
                // （形如 mw-headline" id="遗器说明">），按「到第一个 > 为止」剥掉
                .replace(/^[^\n>]*>/, '')
                .replace(/^遗器说明/, '')
                .replace(/^\[[^\]]*\]/, '')
                .replace(/^\[[^\]]*\]/, '')
                .trim();
            const cut = seg.search(/推荐角色|搭配推荐|参考链接|获取途径|速查/);
            if (cut > 0) seg = seg.slice(0, cut);
            seg = seg.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
            if (seg) out.desc = seg;
        }
    }

    // 推荐角色：alt 形如「角色头像-xxx.png」/「无背景-角色-xxx.png」
    {
        // 锚点同样要用 mw-headline（indexOf('id="推荐角色"') 会命中目录）
        const ri = html.indexOf('mw-headline" id="推荐角色"');
        /* 没有推荐角色锚点就**跳过这一段**，不能直接 return ——
           那样等于把已经解析好的套装效果、遗器来历、图标全丢掉，返回 undefined，
           fetchSrBwikiItem 判定为失败，卡面就只剩列表层的名字/星级/版本（空壳）。
           实测「星体差分机」这类位面饰品没有推荐角色小节，卡面因此完全空白。
           同时也别扫全页：否则属性图（雷/风/物理）、表情图甚至导航框里的角色
           都会被当成推荐角色（实测误抓 41 个）。 */
        if (ri >= 0) {
        const scope = html.slice(ri, ri + 40000);
        // sr 站推荐角色块的 alt 就是**角色名本身**（戏梦点星的伶人.png / 毁灭-白.png …），
        // 「角色头像-」前缀是原神/绝区零的写法，这里匹配不到；
        // 命途图 alt 形如「毁灭-白」，按「以 -白/ -黑 结尾」剔除。
        /* 只取编辑精选的 role-box 块：
           - 先把范围截断到第一个「X竖版头像」之前（后面那份是「使用到该遗器的角色」
             整份名单，实测 15 个，不是推荐）
           - 每块取第一张 `X.png` 作为角色；命途图（毁灭-白.png）和属性图
             （雷/风/物理…）形状一样，要排除
           - 不按「N件套」角标筛：不死途的角标是空的，筛了会漏（实测推荐只有 4 个）
           这段与 relic_view.js 同一套规则，两边都要改。 */
        const cut2 = scope.search(/alt="[^"]*竖版头像\.png"/);
        const scope2 = cut2 > 0 ? scope.slice(0, cut2) : scope;
        for (const blk of scope2.split(/<div class="role-box">/).slice(1)) {
            const im = blk.match(/<img[^>]*alt="([^"]+?)\.png"[^>]*src="([^"]+)"/);
            if (!im) continue;
            const nm = decodeTxt(im[1]).trim();
            if (!nm || /-(白|黑)$/.test(nm)) continue;                       // 命途图
            if (/^(雷|风|物理|火|冰|虚数|量子|光|电)$/.test(nm)) continue;   // 属性图
            if (/竖版头像$|头像$/.test(nm)) continue;                        // 「用过该遗器」列表
            if (out.agents.some(a => a.name === nm)) continue;
            out.agents.push({ name: nm, icon: origIcon(im[2]) });
            if (out.agents.length >= 24) break;
        }
        }
    }

    /* 页面归属判定：光锥页有「技能名称/技能效果」，遗器页有「二件套效果/四件套效果」，
       两类页面特征互斥。按光锥查询命中遗器页（或反之）时直接放弃 Bwiki 版式，
       让调用方回落原渲染路径，避免用残缺数据拼卡。 */
    out.pageKind = /技能名称|技能效果/.test(text) ? 'gz'
        : (/二件套效果|四件套效果/.test(text) ? 'yq' : '');
    if (type === 'gz' && out.pageKind === 'yq') return null;
    if (type === 'yq' && out.pageKind === 'gz') return null;

    const ok = out.set2 || out.set4 || out.talentDesc || out.panel.length || out.origin;
    return ok ? out : null;
}

const cache = new Map();
const CACHE_TTL = 12 * 3600 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SR_API = 'https://wiki.biligame.com/sr/api.php';

/**
 * 抓星铁词条页。
 * @param {string} name 正式名
 * @param {'gz'|'yq'} type
 * Bwiki 对 sr 站限流极凶（实测连续请求会返 567 拦截页），
 * 失败只返回空串让调用方回落，不抛错。
 */
export async function fetchSrBwikiItem(name, type = 'gz') {
    const key = `${type}:${srKey(name)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
    let blocked = 0;
    let last = '';
    for (let i = 0; i < 4; i++) {
        try {
            const u = `${SR_API}?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json&redirects=1`;
            const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
            const ct = String(r.headers.get('content-type') || '');
            if (!ct.includes('json')) {
                blocked++;
                last = `风控拦截(HTTP ${r.status})`;
                await sleep(2500 * (i + 1));
                continue;
            }
            const html = (await r.json())?.parse?.text?.['*'] || '';
            if (!html) { last = '页面不存在(parse.text 为空)'; break; }
            const d = parseSrBwikiItem(html, type);
            if (!d) { last = '页面结构未识别'; break; }
            cache.set(key, { t: Date.now(), v: d });
            return d;
        } catch (e) {
            last = `请求异常: ${e?.message || e}`;
            await sleep(1500 * (i + 1));
        }
    }
    globalThis.logger?.info?.(`[xhh][bwiki_sr] ${name} 词条抓取失败：${last}（被拦 ${blocked} 次），改用列表数据出卡`);
    return null;
}
