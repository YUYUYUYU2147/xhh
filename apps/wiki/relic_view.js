/**
 * 圣遗物 / 遗器 / 驱动盘 —— 三个游戏**共用**的取图与视图组装。
 *
 * 为什么要抽这一层：这三个道具的数据形状其实完全一样（套装方图 + 若干散件图 +
 * 二/四件套效果 + 一段背景故事 + 一排适配角色 + 几个角标图标），
 * 差别只在**图片 alt 的命名习惯**上：
 *
 *   原神 圣遗物：华馆梦醒形骸记生之花.png / 无背景-角色-诺艾尔.png / 元素火.png
 *   星铁 遗器　：戏梦点星的伶人.png / 快枪手的野穗毡帽.png / 吉尔伽美什竖版头像.png / 毁灭-白.png
 *   绝区零驱动盘：驱动盘图标-荆棘玫瑰.png / 驱动盘-荆棘玫瑰-A.png / 角色头像-希格莉德.png / 图标-强攻.png
 *
 * 之前是三个游戏三套模板三个解析器，结果「推荐角色」「套装/散件图标」「右上角角标」
 * 这些字段只有星铁遗器有，原神圣遗物与绝区零驱动盘都没有 —— 
 * 所以这里按 alt 命名统一识别，输出一份**字段名完全相同**的视图，
 * 三个游戏都渲染同一个模板 wiki/relic_bwiki。
 *
 * 识别原则：只认「命名规律」，不认 class/id/位置；每个游戏一张规则表，
 * 加新游戏只需在 RULES 里加一条，不改模板、不改别的游戏。
 */

/** 三游戏的 alt 规则表 */
const RULES = {
  gs: {
    // 散件：<套装名><件名>.png（生之花/死之羽/时之沙/空之杯/理之冠）
    piece: /^(.+?)(生之花|死之羽|时之沙|空之杯|理之冠)\.png$/,
    /* 推荐角色块：<div class="recommended"><div class="title">推荐角色</div>。
       原神页没有 mw-headline 锚点（那是星铁的写法），所以按 class 定位；
       这一段里正好 23 个头像，整页扫是 132 个。 */
    agentScope: /class="recommended"/,
    agentMax: 24,
    // 套装方图：维基没有单独一套方图，页面上只有星级底图（圣遗物套装-5星.png）
    setIcon: null,
    // 适配角色：无背景-角色-<名>.png
    agent: /^(?:无背景-角色|角色头像|角色立绘)-(.+)\.png$/,
    // 属性角标：元素火.png / 元素水.png …
    corner: /^元素(火|水|风|雷|草|冰|岩)\.png$/,
    // 这些是维基自己的装饰图，不能当道具/角色
    ignore: /^(圣遗物套装-|创建图鉴|选项装饰|Logo-|黄金剧团生之花)/
  },
  sr: {
    /* 散件：星铁的散件名是「伶人的悲泣假面」，跟套装名「戏梦点星的伶人」之间
       **没有字面关系**（「X的Y」只对部分套装成立），所以按页签里出现的散件名认。
       词条解析器（bwiki_sr_item.js）已经把这四个名字取出来了，通过 pieceNames 传进来。*/
    /* 散件只按页签名（names）认；piece 正则留空，否则 /^([^.]+)\.png$/ 会把
       页面上任何 X.png 都当散件（实测 4 件的套装能收出 11 张）。*/
    piece: null,
    agentScope: /mw-headline" id="推荐角色"/,
    setIcon: /^(.+)\.png$/,
    agent: /^(.+?)竖版头像\.png$|^(.+?)头像\.png$/,
    corner: /^(.+)-(白|黑)\.png$/,
    /* 星铁的「推荐角色」小节列的是**所有用过该遗器的角色**（实测 15 个），
       真正的推荐是带「4件套 / 2件套」角标的那几个（实测死水深潜的先驱 4 个）。
       所以只收带角标的；一个都没有就当官方没写推荐。 */
    /* 星铁推荐角色是 role-box 分块（角标 team-name 只作参考，不作筛选条件） */
    agentBlockSplit: /<div class="role-box">/,
    agentMax: 20,
    ignore: /^(聊天表情|真珠|光锥-立绘|Logo|选项)/
  },
  zzz: {
    /* 散件：驱动盘-<套装>-A.png / -B.png，但**有的盘只有一张合并图**
       （囚徒手记就是 `驱动盘-囚徒手记.png`，没有 -A/-B），
       所以后缀可选。另外驱动盘图标-<套装>.png 是卡面方图，不能当散件。*/
    piece: /^驱动盘-(.+?)(?:-[A-Z])?\.png$/,
    agentScope: null,
    // 绝区零适配角色块：信息框里第一段连续的 role-img
    agentBlock: /class="star-S role-img"/,
    setIcon: /^驱动盘图标-(.+)\.png$/,
    agent: /^角色头像-(.+)\.png$/,
    corner: /^图标-(强攻|击破|异常|支援|防护|命破|锋御)\.png$/,
    agentMax: 12,
    ignore: /^(Logo-|选项|图片)/
  }
};

const origIcon = src => {
  const s = String(src || '');
  if (!s) return '';
  // patchwiki 的缩略图 URL 里带原图路径，取出来就是原图（列表图是 120px/260px 缩略图，会糊）
  const m = s.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/thumb\/[^/]+\/[^/]+\/\d+px-/);
  return m ? m[1] : s;
};

const decodeTxt = v => String(v || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;|&#160;/g, ' ');

/**
 * 从页面 HTML 里抽出「套装/散件/角色/角标」四类图片。
 * @param {string} html 页面 HTML
 * @param {'gs'|'sr'|'zzz'} game
 * @param {string} name 正式名（用于剔除「别的套装的散件」）
 * @param {string[]} [pieceNames] 该套装的散件名（星铁靠这个，散件名与套装名无字面关系）
 */
export function extractRelicArt(html, game, name = '', pieceNames = []) {
  const rule = RULES[game];
  const out = { setIcon: '', pieceIcons: [], agents: [], cornerIcons: [] };
  /* 绝区零有的盘同时有「合并图」（驱动盘-X.png）和「分件图」（驱动盘-X-A/B.png），
     两者是同一套内容的两种画法。优先只保留分件图，否则卡面上会出现 3 张
     重复的图（合并图 + A + B）。 */
  const partFlags = [];
  if (!rule || !html) return out;
  const formal = String(name || '').trim();
  const names = new Set((pieceNames || []).map(x => String(x || '').trim()).filter(Boolean));

  /* 两套取图范围，别混用：
     ① artScope —— 整页。套装方图/散件图/角标散布在信息框与各处，要全页扫。
     ② agentScopeHtml —— 只圈「推荐角色」。整页扫角色会连导航框、攻略位、
        活动图里的头像一起收进来（实测星铁遗器页整页 92 个、绝区零驱动盘页 60 个）。
        原神/星铁按小节标题切；绝区零没有标题，取信息框里第一段连续的 role-img。 */
  const artScope = String(html);
  /* 星铁的散件名从「遗器来历」页签标题取（伶人的悲泣假面…），
     因为散件名与套装名没有字面关系，靠 alt 猜会漏（实测只能猜出 3/4）。
     页签里还有「隧洞遗器/位面饰品」两个分类标签，要排掉。 */
  if (game === 'sr' && !names.size) {
    for (const m of artScope.matchAll(/class="tab-panel"[^>]*>([^<]+)</g)) {
      const t = decodeTxt(m[1]).trim();
      if (t && !/^(隧洞遗器|位面饰品|位面首饰)$/.test(t)) names.add(t);
    }
  }
  let agentScopeHtml = String(html);
  if (rule.agentScope) {
    const m = String(html).match(rule.agentScope);
    if (m) agentScopeHtml = String(html).slice(m.index, m.index + 40000);
  } else if (rule.agentBlock) {
    const m = String(html).match(rule.agentBlock);
    if (m) agentScopeHtml = String(html).slice(Math.max(0, m.index - 500), m.index + 3000);
  }

  const seenAgent = new Set();
  const seenCorner = new Set();
  /* 散件按**名字**去重，不按 URL：同一个部件在页面不同位置会出现
     缩略图/原图两个不同 src（实测 4 件的套装按 URL 去重能收出 8 张）。*/
  const seenPiece = new Set();
  // 1) 套装方图 / 散件图 / 角标：整页扫
  for (const m of artScope.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)) {
    const alt = decodeTxt(m[1]).trim();
    const src = origIcon(m[2]);
    if (!alt || !src) continue;
    if (rule.ignore.test(alt)) continue;
    const altNoExt = alt.replace(/\.png$/, '');
    if (names.has(altNoExt) || names.has(alt)) {
      if (!seenPiece.has(altNoExt)) {
        seenPiece.add(altNoExt);
        out.pieceIcons.push(src);
      }
      continue;
    }
    const pm = alt.match(rule.piece);
    /* 散件必须属于**当前套装**。绝区零驱动盘页里有一整排其它驱动盘的图标
       （囚徒手记页上有 30 个「驱动盘-XXX.png」的导航列表），不做归属判断就会
       把全游戏的盘都收进来。正则第一个捕获组就是「所属套装名」，拿它比对。 */
    const owner = pm?.[1] || '';
    if (pm && (!formal || owner === formal || alt.startsWith(formal))) {
      if (!seenPiece.has(altNoExt)) {
        seenPiece.add(altNoExt);
        out.pieceIcons.push(src);
        partFlags.push(/-[A-Z]\.png$/.test(alt));
      }
      continue;
    }
    if (rule.setIcon) {
      const sm = alt.match(rule.setIcon);
      if (sm && (!formal || sm[1] === formal)) {
        if (!out.setIcon) out.setIcon = src;
        continue;
      }
    } else if (formal && alt === `${formal}.png` && !out.setIcon) {
      // GS 四星套装页没有独立方图，但有「<套装名>.png」本体图，当卡面用
      out.setIcon = src;
      continue;
    }
    const cm = alt.match(rule.corner);
    if (cm && !seenCorner.has(cm[1])) {
      seenCorner.add(cm[1]);
      out.cornerIcons.push({ name: cm[1], icon: src });
    }
  }
  // 2a) 星铁专用：按 role-box 分块取，整块没有「N件套」角标就跳过。
  //     Bwiki 星铁遗器页的「推荐角色」小节列的是**所有用过该遗器的角色**
  //     （实测死水深潜的先驱 15 个），只有带角标的才是推荐（4 个）。
  if (rule.agentBlockSplit) {
    /* 「使用到该遗器的角色」那一大块里也是 role-box，而且排在推荐块**后面**，
       里面的头像是 `X竖版头像.png`；推荐块里的是 `X.png`。
       所以先把范围截断到第一个「竖版头像」出现为止，再按 role-box 取，
       就只拿到编辑精选的那几个（实测 4 个）。 */
    const cut = agentScopeHtml.search(/alt="[^"]*竖版头像\.png"/);
    const scope = cut > 0 ? agentScopeHtml.slice(0, cut) : agentScopeHtml;
    const blocks = scope.split(rule.agentBlockSplit).slice(1);
    /* 不按角标筛，只按 role-box 取。
       这一小节里的 role-box 就是编辑精选的推荐（实测死水深潜的先驱 4 个：
       不死途/砂金/那刻夏/黄泉，其中只有 3 个带「4件套」角标，不死途角标为空，
       按角标筛会漏掉它）。而那一小节**后面**还有另一块「所有用过该遗器的角色」
       的竖版头像列表（实测 15 个），之前就是被那里抓走了。
       所以只取 role-box，天然后面那块自然不在范围内。 */
    for (const blk of blocks) {
      const im = blk.match(/<img[^>]*alt="([^"]+?)\.png"[^>]*src="([^"]+)"/);
      if (!im) continue;
      const nm = decodeTxt(im[1]).trim();
      if (!nm || seenAgent.has(nm)) continue;
      if (rule.ignore.test(nm)) continue;
      seenAgent.add(nm);
      out.agents.push({ name: nm, icon: origIcon(im[2]) });
      if (out.agents.length >= (rule.agentMax || 30)) break;
    }
    return out;
  }
  // 2b) 其余游戏：在推荐角色范围内扫头像
  /* 窗口收窄（gs）：推荐块内每个头像都伴随角色名标签（<div class="L">名</div>），
     截到最后一个名字标签之后一点即可。agentScope 固定切 40000 字符的窗口
     会越界扫到页面后段的导航框/其他推荐位 —— 实测绝缘之旗印推荐块在 +14000
     就结束，「尼可」的头像在 +39776（别的区块）被误收进推荐角色。
     窗口内没有名字标签（zzz 走 agentBlock 小窗口）则不截。 */
  if (rule.agentScope) {
    const nameTags = [...agentScopeHtml.matchAll(/<div class="L">/g)];
    if (nameTags.length) {
      const end = nameTags[nameTags.length - 1].index + 2000;
      if (end < agentScopeHtml.length) agentScopeHtml = agentScopeHtml.slice(0, end);
    } else {
      /* 血红之证这类 7.0 新页面的 recommended 块里**没有名字标签、没有推荐说明**，
         只有 44 个头像的滚动选择器（实测几乎全角色：尼可/杜林/玛薇卡/阿蕾奇诺…）——
         那是交互组件不是推荐名单。没有名字佐证就无法区分推荐与全量，
         一律不收，让卡面走「无推荐」而不是一长串错误头像。 */
      agentScopeHtml = '';
    }
  }
  for (const m of agentScopeHtml.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)) {
    const alt = decodeTxt(m[1]).trim();
    const src = origIcon(m[2]);
    if (!alt || !src) continue;
    if (rule.ignore.test(alt)) continue;
    const am = alt.match(rule.agent);
    if (!am) continue;
    const nm = (am[1] || am[2] || '').trim();
    // 上限：防止个别页面结构异常时把整页头像灌进「推荐角色」
    if (nm && !seenAgent.has(nm) && out.agents.length < (rule.agentMax || 30)) {
      seenAgent.add(nm);
      out.agents.push({ name: nm, icon: src });
    }
  }
  // 有分件图时丢掉合并图（见 partFlags 说明）
  if (partFlags.some(Boolean)) {
    out.pieceIcons = out.pieceIcons.filter((_, i) => partFlags[i]);
  }
  /* 原神圣遗物页**没有**独立的套装方图（只有 5 张散件图 + 星级底图）。
     以前这里「拿第一张散件图当卡面」，结果同一张图在卡面和「套装与散件」行里
     各出现一次，看着就是重复（用户实图）。现在不兜底：卡面交给列表层给的
     圣遗物一览图标（wiki.js 里的 base.icon），散件行就只放 5 张散件。 */
  return out;
}

/**
 * 把三个游戏各自解析器的产物**归一**成同一份视图字段。
 * 各解析器历史字段名不一致（遗器叫 origin、驱动盘叫 desc、圣遗物叫 intro），
 * 模板只认下面这一套。
 */
export function buildRelicView({ game, name, base = {}, art = {}, storyTitle = '', unreleased = false }) {
  const story = base.origin || base.desc || base.story || base.intro || '';
  const badges = [];
  const push = (label, value) => {
    if (!value) return;
    badges.push({ label, value: String(value).trim() });
  };
  push('星级', base.ji || base.rarity || '');
  push('版本', base.version || '');
  push('获取途径', base.obtain || '');
  push('TAG', base.tags || base.tag || '');
  return {
    game,
    name: name || base.name || '',
    icon: art.setIcon || base.icon || '',
    pieceIcons: art.pieceIcons || [],
    /* 角标不显示：遗器类道具**没有命途/属性**这类自身属性，
       页面上的 `毁灭-白.png`（命途）、`元素火.png`（属性）、`图标-强攻.png`（强攻类型）
       都是维基页面的公共装饰/导航图（同一页会同时出现 9 个命途图 + 7 个属性图），
       把它们当道具属性画到卡面右上角是错的。
       要看命途/属性请看角色卡或光锥卡。 */
    cornerIcons: [],
    /* 测试服标记：右上角 TEST 角标。遗器类三个游戏共用这一个视图，
       由调用方（数据层判定的 isUnreleased）注入。 */
    unreleased: !!unreleased || !!art.unreleased,
    set2: base.set2 || '',
    set4: base.set4 || '',
    story,
    storyTitle: storyTitle || (game === 'gs' ? '圣遗物故事' : game === 'sr' ? '遗器来历' : '驱动盘描述'),
    agents: art.agents || [],
    /* 官方未推荐：显示提示而不是空白，也不拿主观列表凑 */
    noRecommend: !!art.noRecommend,
    /* 推荐理由，三家各有来源，缺一就走下一档，全都没有就明确写一句「官方未填写」，
       免得看起来像我们漏抓：
       绝区零/原神 —— 米游社词条页的「推荐角色/推荐理由」「角色推荐/推荐原因」
       星铁       —— Bwiki 遗器页的「遗器说明」小节（成套说明，推荐角色小节只有头像） */
    hasAgentReason: (art.agents || []).some(a => a.reason),
    agentReason: (art.agents || []).map(a => a.reason).filter(Boolean).join('\n')
      || art.reason || ''
      || (art.agents?.length ? '（官方未填写推荐理由，仅列出推荐角色）' : ''),
    badges,
    /* 页面上没能归类成「套装效果/故事」的表格（例如原神四星圣遗物的
       单件属性表、突破材料表）原样带出去，模板里有个「详细数据」区兜着。
       数据在就用，没有就不渲染 —— 不用为每个游戏各写一套。 */
    tables: base.tables || [],
    bgFile: base.bgFile || '',
  };
}