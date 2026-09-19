import fetch from 'node-fetch';
import { makeForwardMsg, pluginPriority } from '#xhh';

const GLOBAL_SEARCH_API = 'https://bbs-api.miyoushe.com/post/wapi/searchPosts';
const POST_FULL_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';

const headers = {
  Referer: 'https://www.miyoushe.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

const GAME_CONFIG = {
  bh3: { gid: 1, name: '崩坏3', keywords: ['特别节目丨内容回顾', '特别节目', '内容回顾'] },
  gs: { gid: 2, name: '原神', keywords: ['前瞻汇总', '前瞻信息', '版本前瞻'] },
  sr: { gid: 6, name: '崩坏：星穹铁道', keywords: ['前瞻汇总', '前瞻信息', '版本前瞻'] },
  zzz: { gid: 8, name: '绝区零', keywords: ['前瞻，一站式搞定', '前瞻信息', '版本前瞻'] },
};

function pickGame(msg = '') {
  if (/崩三|崩坏三|崩坏3|bh3/i.test(msg)) return 'bh3';
  if (/原神|gs/i.test(msg)) return 'gs';
  if (/星铁|崩铁|星穹|sr/i.test(msg)) return 'sr';
  if (/绝区零|绝区|zzz/i.test(msg)) return 'zzz';
  return null;
}

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collectJsonText(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => collectJsonText(v, depth + 1));
  if (typeof value !== 'object') return [];
  const preferKeys = ['text', 'insert', 'content', 'desc', 'title'];
  const direct = preferKeys.flatMap(k => collectJsonText(value[k], depth + 1));
  if (direct.length) return direct;
  return Object.values(value).flatMap(v => collectJsonText(v, depth + 1));
}

function extractPostSummary(post = {}, maxLen = 2000) {
  let content = post.content || post.structured_content || post.summary || '';
  try {
    const json = JSON.parse(content);
    if (json?.text) content = json.text;
    else content = collectJsonText(json).join('\n');
  } catch (_) {}
  const text = decodeHtml(content)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function searchGlobalPosts(keyword, gids, size = 10) {
  const url = `${GLOBAL_SEARCH_API}?gids=${encodeURIComponent(gids)}&size=${size}&keyword=${encodeURIComponent(keyword)}&sort_type=2`;
  const res = await fetch(url, { headers }).then(r => r.json());
  return (res?.data?.posts || []).map(v => v?.post).filter(Boolean);
}

async function fetchPostFull(post = {}, gids = 1) {
  if (!post?.post_id) return post;
  try {
    const url = `${POST_FULL_API}?gids=${encodeURIComponent(gids)}&read=1&post_id=${encodeURIComponent(post.post_id)}`;
    const res = await fetch(url, { headers }).then(r => r.json());
    const full = res?.data?.post?.post || res?.data?.post || {};
    return { ...post, ...full, images: full.images?.length ? full.images : post.images };
  } catch (err) {
    logger.warn(`[xhh][前瞻] 获取帖子详情 ${post.post_id} 失败: ${err?.message || err}`);
    return post;
  }
}

function isForwardPost(post = {}) {
  const raw = [post.subject, post.content, post.structured_content, post.summary]
    .filter(Boolean).join('\n');
  return /前瞻|特别节目|内容回顾/.test(raw);
}

function formatPostInfo(post = {}, gameName) {
  const lines = [`【${gameName}前瞻】${post.subject || ''}`];
  const ts = Number(post.created_at || post.publish_at || 0);
  if (ts) lines.push(`发布时间：${new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })}`);
  const summary = extractPostSummary(post);
  if (summary) lines.push(`内容摘要：${summary}`);
  if (post.post_id) lines.push(`原帖ID：${post.post_id}`);
  return lines.filter(Boolean).join('\n');
}

export class forward_info extends plugin {
  constructor() {
    super({
      name: '[小花火]前瞻信息',
      dsc: '原神/星铁/崩坏3/绝区零版本前瞻信息汇总',
      event: 'message',
      priority: pluginPriority('forward_info', -Infinity),
      rule: [
        { reg: '^#*(小花火|xhh)(崩三|崩坏三|崩坏3|原神|星铁|绝区零)(前瞻)(信息)?$', fnc: 'forwardInfo' },
      ],
    });
  }

  async forwardInfo() {
    const key = pickGame(this.e.msg);
    if (!key) return false;
    const cfg = GAME_CONFIG[key];
    await this.e.reply(`${cfg.name}前瞻信息获取中，请稍后...`, true, { recallMsg: 60 });

    const seenPosts = new Set();
    const seenImages = new Set();
    const msg = [];

    for (const keyword of cfg.keywords) {
      try {
        const posts = await searchGlobalPosts(keyword, cfg.gid, 10);
        for (let post of posts) {
          if (!post?.post_id || seenPosts.has(post.post_id)) continue;
          // 先用标题粗筛，减少详情接口请求
          if (!/(前瞻|特别节目|内容回顾)/.test(post.subject || '')) continue;
          post = await fetchPostFull(post, cfg.gid);
          if (!isForwardPost(post)) continue;
          const imageSegments = (post?.images || [])
            .filter(url => url && !seenImages.has(url))
            .slice(0, 9)
            .map(url => {
              seenImages.add(url);
              return segment.image(url);
            });
          const postInfo = formatPostInfo(post, cfg.name);
          if (!imageSegments.length && !extractPostSummary(post)) continue;
          seenPosts.add(post.post_id);
          msg.push([postInfo, ...imageSegments]);
          if (msg.length >= 3) break;
        }
      } catch (err) {
        logger.warn(`[xhh][前瞻] 搜索 ${keyword} 失败: ${err?.message || err}`);
      }
      if (msg.length >= 3) break;
    }

    if (!msg.length) {
      return this.e.reply(`未找到${cfg.name}前瞻信息相关帖子，请稍后再试~`, true);
    }
    return this.e.reply(await makeForwardMsg(this.e, msg, `${cfg.name}前瞻信息汇总`));
  }
}
