import fs from 'node:fs';
import { config, pluginPriority, bili_live, bili, getSource } from '#xhh';

// 手动解析：#直播解析 6 / #B站直播解析 https://live.bilibili.com/6 / #解析直播 6
// 除了最后的 (.*)，其余全部用非捕获组，参数固定取 m[1]
const MANUAL_RE = /^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播(?:间)?解析|解析直播(?:间)?)\s*(.*)$/i;
// 弹幕：#弹幕 内容 / #弹幕 房间号 内容 / #发送弹幕 内容
const DM_RE = /^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播间?)?(?:发送)?弹幕\s*(.*)$/i;
// 绑定/解绑/查看直播间：#直播间绑定 6 / #绑定直播间 6（必须带"直播间"三字，避免抢别人家的"查看"指令）
const BIND_RE = /^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:(?:直播间?)(绑定|解绑|取消绑定|查看)|(绑定|解绑|取消绑定|查看)直播间?)\s*(\d{1,12})?$/i;
// 实时截屏：#直播截图 / #直播间截屏 6 / #b站实时截图
const SHOT_RE = /^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播间?|直播)(?:实时)?(?:截屏|截图|抓图|画面)\s*(.*)$/i;

// 从卡片/小程序消息段里挖链接：json 取跳转地址，xml 直接正则捞 http
function segText(msgArr = []) {
  const out = [];
  for (const seg of msgArr) {
    const type = seg?.type;
    if (type === 'text') {
      out.push(String(seg?.text || ''));
      continue;
    }
    if (type !== 'json' && type !== 'xml') continue;
    const raw = String(seg?.data || seg?.content || '');
    try {
      const data = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      const url = data?.meta?.detail_1?.qqdocurl || data?.meta?.news?.jumpUrl || data?.meta?.detail_1?.jumpUrl || '';
      if (url) out.push(url);
    } catch (err) { }
    // 卡片里可能还塞着别的链接，一并捞出来
    out.push(...(raw.match(/https?:\/\/[^\s"'<>\\]+/g) || []));
  }
  return out.join(' ');
}

export class bili_live_plugin extends plugin {
  constructor(e) {
    super({
      name: '[小花火]b站直播',
      dsc: 'B站直播间解析',
      event: 'message',
      priority: pluginPriority('bili_live', -115),
      rule: [
        {
          reg: '^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播(?:间)?解析|解析直播(?:间)?)(.*)$',
          fnc: 'parse',
        },
        {
          reg: '^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播间?)?(?:发送)?弹幕(.*)$',
          fnc: 'danmaku',
        },
        {
          reg: '^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:直播间?|直播)(?:实时)?(?:截屏|截图|抓图|画面)(.*)$',
          fnc: 'shot',
        },
        {
          reg: '^#*(?:小花火)?(?:b站|B站|哔哩哔哩|bili|bilibili)?(?:(?:直播间?)(绑定|解绑|取消绑定|查看)|(绑定|解绑|取消绑定|查看)直播间?)(.*)$',
          fnc: 'bind',
          permission: 'master',
        },
        {
          // 空 reg = 兜底匹配所有消息，用于自动解析（默认开启）
          reg: '',
          fnc: 'auto',
          log: false,
        },
      ],
    });
  }

  // 默认开启：只有显式写成 false 才关闭
  Check() {
    return config().bili_live !== false;
  }

  // 手动指令：指令自带参数 > 本条消息里的卡片 > 引用的那条消息（卡片/文字都算）
  async parse(e) {
    const m = String(e.msg || '').match(MANUAL_RE);
    const arg = String(m?.[1] || '').trim();

    let roomId = '';
    if (arg) {
      const rooms = await bili_live.extractRooms(arg);
      roomId = rooms[0] || '';
      // 直接给房间号的情况
      if (!roomId && /^\d{1,12}$/.test(arg)) roomId = arg;
    }
    if (!roomId) {
      // 指令不带参数时，去本条消息和引用的消息里找直播间
      const rooms = await bili_live.extractRooms(await this.gatherText(e));
      roomId = rooms[0] || '';
    }

    if (!roomId) {
      return e.reply('没认出直播间：可以直接给房间号/链接，也可以引用B站分享卡片再发这个指令。', true, { recallMsg: 60 });
    }

    await this.send(e, roomId, true);
    return true;
  }

  // 汇总本条消息 + 引用消息的可用文本
  async gatherText(e) {
    const parts = [String(e.raw_message || e.msg || ''), segText(e.message)];
    try {
      if (e.source || e.getReply) {
        const src = await getSource(e);
        if (src) {
          parts.push(String(src.raw_message || src.msg || ''));
          parts.push(segText(src.message));
        }
      }
    } catch (err) { }
    return parts.filter(Boolean).join(' ');
  }

  // 自动解析：消息里出现直播间链接就解析（默认开启）
  async auto(e) {
    if (!e.msg || !this.Check()) return false;
    // 手动指令交给上面那条规则处理
    if (MANUAL_RE.test(String(e.msg))) return false;

    // 自己这条消息里的文字 + 卡片链接（自动解析不翻引用，避免旧卡片被反复触发）
    const text = [String(e.raw_message || e.msg || ''), segText(e.message)].filter(Boolean).join(' ');

    const rooms = await bili_live.extractRooms(text);
    if (!rooms.length) return false;

    for (const roomId of rooms) {
      await this.send(e, roomId, false);
    }
    return true;
  }

  // 绑定/解绑/查看直播间（主人）
  async bind(e) {
    const m = String(e.msg || '').match(BIND_RE);
    // 两种语序都支持：#直播间绑定 6 / #绑定直播间 6
    const act = String(m?.[1] || m?.[2] || '');
    const room = String(m?.[3] || '').trim();
    const key = this.roomKey(e);

    if (/解绑|取消绑定/.test(act)) {
      await redis.del(key);
      return e.reply('已解绑直播间', true, { recallMsg: 30 });
    }
    if (/查看/.test(act)) {
      const id = await redis.get(key);
      return e.reply(id ? `当前绑定的直播间：${id}\nhttps://live.bilibili.com/${id}` : '还没绑定直播间');
    }
    if (!room) return e.reply('用法：#直播间绑定 房间号', true, { recallMsg: 30 });
    await redis.set(key, room);
    return e.reply(`已绑定直播间 ${room}\n之后直接发「#弹幕 内容」就会发到这个房间`, true, { recallMsg: 60 });
  }

  // 群按群存，私聊按人存
  roomKey(e) {
    return e.isGroup ? `xhh_bili_live_room:${e.group_id}` : `xhh_bili_live_room:u${e.user_id}`;
  }

  // 房间号三级取数：参数开头 > 绑定的房间 > 本条消息/引用消息里的链接卡片
  async resolveRoom(e, arg) {
    let rest = String(arg || '').trim();
    let roomId = '';
    const lead = rest.match(/^(\d{1,12})\s+/);
    if (lead) {
      roomId = lead[1];
      rest = rest.slice(lead[0].length).trim();
    }
    if (!roomId) roomId = (await redis.get(this.roomKey(e))) || '';
    if (!roomId) {
      const rooms = await bili_live.extractRooms(await this.gatherText(e));
      roomId = rooms[0] || '';
    }
    return { roomId, rest };
  }

  // 直播实时截屏：抓2秒流取一帧
  async shot(e) {
    const arg = String(String(e.msg || '').match(SHOT_RE)?.[1] || '');
    const { roomId } = await this.resolveRoom(e, arg);
    if (!roomId) {
      return e.reply('没指定直播间：「#直播截图 房间号」，或先「#直播间绑定 房间号」，也可以引用B站分享卡片再发。', true, { recallMsg: 60 });
    }

    // 没开播就没画面，先问一下，省得白等
    let info = null;
    try {
      info = await bili_live.roomInfo(roomId);
    } catch (err) { }
    if (info && info.liveStatus !== 1) {
      return e.reply(`直播间 ${roomId} 现在没在直播（${info.liveStatus === 2 ? '轮播中' : '未开播'}），截不了画面。`, true, { recallMsg: 60 });
    }

    const qn = Number(config().bili_live_qn ?? 250) || 250;
    bili_live.cleanTemp();
    await e.reply(`正在截取直播间 ${roomId} 的实时画面…`, true, { recallMsg: 120 }).catch(() => { });

    try {
      const img = await bili_live.screenshot(roomId, { qn, seconds: 2 });
      logger.mark(`[xhh][bili_live] 截屏完成 ${roomId}: ${(img.size / 1024).toFixed(0)}KB`);
      await e.reply(segment.image(img.path));
      fs.rmSync(img.path, { force: true });
      return true;
    } catch (err) {
      logger.warn(`[xhh][bili_live] 截屏失败: ${err?.message || err}`);
      return e.reply(`截屏失败：${err?.message || err}`, true, { recallMsg: 60 });
    }
  }

  // 发送弹幕
  async danmaku(e) {
    const cfg = config();
    if (cfg.bili_live_dm === false) return false;

    const { roomId, rest: text } = await this.resolveRoom(e, String(String(e.msg || '').match(DM_RE)?.[1] || ''));
    if (!roomId) {
      return e.reply('还没指定直播间：先「#直播间绑定 房间号」，或用「#弹幕 房间号 内容」，也可以引用B站分享卡片再发。', true, { recallMsg: 60 });
    }
    if (!text) return e.reply('弹幕内容不能为空呀', true, { recallMsg: 30 });

    const len = [...text].length; // 中文按字算，别把 emoji 拆成两半
    if (len > 20) return e.reply(`直播间弹幕最多20个字，你这条 ${len} 个字`, true, { recallMsg: 30 });

    if (!this.dmCan(e, cfg)) return e.reply('你没有发弹幕的权限（可在锅巴面板改）', true, { recallMsg: 30 });

    // 冷却，防止一群人连点被B站限流
    const cd = Number(cfg.bili_live_dm_cd ?? 5);
    if (cd > 0 && !e.isMaster) {
      const cdKey = `xhh_bili_live_dm_cd:${e.isGroup ? e.group_id : 'u' + e.user_id}`;
      if (await redis.get(cdKey)) return e.reply(`弹幕冷却中，${cd} 秒后再试`, true, { recallMsg: 30 });
      await redis.set(cdKey, '1', { EX: cd });
    }

    const ck = await bili.getck();
    if (!ck) return e.reply('还没登录B站，先发「小花火b站登录」扫码登录后才能发弹幕', true, { recallMsg: 60 });

    try {
      await bili_live.sendDanmaku(roomId, text, ck);
      logger.mark(`[xhh][bili_live] 弹幕已发送 ${roomId}: ${text}`);
      return e.reply(`弹幕已发到直播间 ${roomId}：${text}`, true, { recallMsg: 60 });
    } catch (err) {
      logger.warn(`[xhh][bili_live] 弹幕发送失败: ${err?.message || err}`);
      return e.reply(`弹幕发送失败：${err?.message || err}`, true, { recallMsg: 60 });
    }
  }

  // 权限：all 所有人 / admin 群管理+主人 / master 仅主人
  dmCan(e, cfg) {
    const perm = cfg.bili_live_dm_perm || 'admin';
    if (perm === 'all' || e.isMaster) return true;
    if (!e.isGroup) return true;
    if (perm === 'master') return false;
    const role = e.sender?.role || e.member?.role || '';
    return role === 'owner' || role === 'admin';
  }

  async send(e, roomId, manual) {
    const cfg = config();

    // 自动解析的冷却，避免同一链接刷屏
    if (!manual) {
      const cd = Number(cfg.bili_live_cd ?? 60);
      if (cd > 0) {
        try {
          const last = await redis.get(`xhh_bili_live:${roomId}_CD`);
          if (last) return false;
          await redis.set(`xhh_bili_live:${roomId}_CD`, String(Date.now()), { EX: cd });
        } catch (err) { }
      }
    }

    let info;
    try {
      info = await bili_live.roomInfo(roomId);
    } catch (err) {
      logger.warn(`[xhh][bili_live] 直播间 ${roomId} 解析失败: ${err?.message || err}`);
      return e.reply(`直播间 ${roomId} 解析失败：${err?.message || '接口异常'}`, true, { recallMsg: 60 });
    }

    // 未开播的直播间是否静默
    if (!manual && cfg.bili_live_only_live && info.liveStatus !== 1) return false;

    const msg = await bili_live.buildMsg(info);
    await e.reply(msg);
    // 解析完再录一段直播发出去
    await this.record(e, info, manual);
    return true;
  }

  // 录制直播片段并直发视频（和 b 站视频下载一样直接 segment.video，不走群文件）
  async record(e, info, manual) {
    const cfg = config();
    const want = manual ? cfg.bili_live_video !== false : !!cfg.bili_live_video_auto;
    if (!want || info.liveStatus !== 1) return false;

    const seconds = Math.min(600, Math.max(5, Number(cfg.bili_live_video_time ?? 60)));
    const qn = Number(cfg.bili_live_qn ?? 250) || 250;
    const maxMB = Number(cfg.bili_live_video_size ?? 99);
    const maxBytes = maxMB > 0 ? maxMB * 1024 * 1024 : 0;

    bili_live.cleanTemp();
    await e.reply(`正在录制 ${seconds} 秒直播片段（${bili_live.LIVE_QN[qn] || qn}），请稍等…`, true, { recallMsg: 300 }).catch(() => { });

    let rawPath = '';
    try {
      const rec = await bili_live.recordLive(info.roomId, { seconds, qn, maxBytes });
      rawPath = rec.path;
      const file = bili_live.toMp4(rec.path);
      logger.mark(`[xhh][bili_live] 录制完成 ${Math.ceil(rec.size / 1048576)}MB -> ${file}`);
      await this.sendVideo(e, segment.video(file));
      // 发出去了就删掉，别堆在 temp 里
      fs.rmSync(rec.path, { force: true });
      if (file !== rec.path) fs.rmSync(file, { force: true });
      return true;
    } catch (err) {
      logger.warn(`[xhh][bili_live] 直播片段录制失败: ${err?.message || err}`);
      if (rawPath) fs.rmSync(rawPath, { force: true });
      return e.reply(`直播片段录制失败：${err?.message || err}`, true, { recallMsg: 60 });
    }
  }

  // 发视频比发图慢得多，临时放宽 bot 超时（抄 mhy_estimate 的做法）
  async sendVideo(e, video) {
    const bot = e.bot || Bot[Number(Bot.uin)];
    const oldTimeout = bot?.timeout;
    if (bot && typeof oldTimeout === 'number') bot.timeout = Math.max(oldTimeout, 600000);
    try {
      return await e.reply(video);
    } finally {
      if (bot && typeof oldTimeout === 'number') bot.timeout = oldTimeout;
    }
  }
}
