import fetch from 'node-fetch';
import md5 from 'md5';
import lodash from 'lodash';
import fs from 'fs';
import YAML from 'yaml';
import { yaml, api, config } from '#xhh';
import { mhyFetch } from './mhy_fetch.js';

  // 走 mhyFetch 出口：默认直连，被米游社风控拦了才切代理。
  // 用裸 fetch 的话 IP 一被拦就直接失败，代理兜底等于没接。
  async function fetchJson(url, options = {}, label = '米游社接口') {
    const resp = await mhyFetch(url, options);
    const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    const head = String(text || '').trim().slice(0, 80);
    logger.mark(`[xhh][mhy] ${label} 返回非 JSON，status=${resp.status} body=${head}`);
    return {
      retcode: -1,
      message: head.startsWith('<') ? '米游社返回拦截页，请稍后重试' : '米游社接口返回异常',
      _html: head.startsWith('<'),
      _status: resp.status,
    };
  }
}

class mhy {
  // 服务器代码 → 中文名。getServerName() 用。
  // 分两代：老代码是崩三/原神的 cn_gf01 / os_usa，
  // 新代码是星铁和绝区零的 prod_gf_cn / prod_official_usa。
  serverNameMap = {
    // 原神 / 崩三
    cn_gf01: '国服', cn_qd01: 'B服',
    os_usa: '美服', os_asia: '亚服', os_euro: '欧服', os_cht: '港澳台服',
    android01: '安卓官服', ios01: 'iOS服',
    // 星铁 / 绝区零
    prod_gf_cn: '国服', prod_qd_cn: 'B服',
    prod_gf_us: '美服', prod_gf_eu: '欧服', prod_gf_jp: '日服', prod_gf_sg: '新加坡服',
    prod_official_usa: '国际服', prod_official_asia: '亚服',
    prod_official_eur: '欧服', prod_official_euro: '欧服', prod_official_cht: '港澳台服',
  };

  constructor() {
    this.fp_url = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
    this.mysSalt = 'rtvTthKxEyreVXQCnhluFgLXPOFKPHlA'; //k2 2.71.1
    this.mysSalt2 = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'; //6x
    this.mysSalt3 = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'; //4x
  }

  async shebei(e, info) {
    if (info?.device_fp && info?.device_id) return this.bd(e, info.device_id, info.device_fp);
    if (!info?.oaid) return logger.error('设备格式错误');
    let ck = this.getUser(e)?.ck;
    if (!ck) return e.reply('请先扫码绑定米游社后，在绑定设备');
    const { deviceName, deviceModel, oaid, deviceFingerprint, deviceBoard } = info;
    const device_ = deviceFingerprint.split('/')[0];
    if (!oaid || oaid.includes('error') || /^0+$/.test(oaid)) return e.reply('设备oaid获取失败，你的设备不支持获取');
    let body = {
      device_id: oaid,
      seed_id: this.randomString(16),
      seed_time: new Date().getTime() + '',
      platform: '2',
      device_fp: '38d7f0aac0ab7',
      app_name: 'bbs_cn',
      ext_fields: `{"cpuType":"arm64-v8a","romCapacity":"512","productName":"${deviceName}","romRemain":"459","manufacturer":"${device_}","appMemory":"512","hostname":"${device_}","screenSize":"1440x3022","osVersion":"13","aaid":"${this.getDeviceGuid()}","vendor":"中国电信","accelerometer":"0.061016977x0.8362915x9.826724","buildTags":"release-keys","model":"${deviceModel}","brand":"${device_}","oaid":"${oaid}","hardware":"qcom","deviceType":"${deviceName}","devId":"REL","serialNumber":"unknown","buildTime":"1690889245000","buildUser":"builder","ramCapacity":"229481","magnetometer":"80.64375x-14.1x77.90625","display":"${deviceModel} release-keys","ramRemain":"110308","deviceInfo":"${deviceFingerprint}","gyroscope":"7.9894776E-4x-1.3315796E-4x6.6578976E-4","vaid":"${this.getDeviceGuid()}","buildType":"user","sdkVersion":"33","board":"${deviceBoard}"}`,
      bbs_device_id: this.getDeviceGuid(),
    };

    let headers = this.getHeaders(e, ck, true, info);

    let res = await fetch(this.fp_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }).then(res => res.json());
    let fp;
    if (res.data?.code == 200) {
      fp = res.data.device_fp;
      headers['x-rpc-device_fp'] = fp;
    } else {
      logger.error(res);
      return e.reply('设备绑定失败,未能获取到device_fp');
    }
    const device_id = headers['x-rpc-device_id'];
    const device_name = headers['x-rpc-device_name'];
    body = this.getbody_(device_id, device_name);
    const res1 = await fetch(
      'https://bbs-api.miyoushe.com/apihub/api/deviceLogin',
      { method: 'POST', headers, body: JSON.stringify(body) }
    ).then(res => res.json());
    const res2 = await fetch(
      'https://bbs-api.miyoushe.com/apihub/api/saveDevice',
      { method: 'POST', headers, body: JSON.stringify(body) }
    ).then(res => res.json());
    if (res1.retcode == 0 && res2.retcode == 0) {
      return this.bd(e, device_id, fp, info);
    } else {
      logger.error(res1, res2);
    }
    return;
  }

  //绑定设备参数保存到文件
  async bd(e, device_id, fp, info) {
    let a_ = {
      device_id: device_id,
      fp: fp,
      device_info: info || '',
    };
    const yaml_url = `./plugins/xhh/data/fp/${e.user_id}.yaml`;
    fs.writeFileSync(yaml_url, YAML.stringify(a_), 'utf-8');
    let ltuid = this.getUser(e).ltuid;
    //作用ZZZ-plugin???
    await redis.set(`ZZZ:DEVICE_FP:${ltuid}:FP`, fp);
    await redis.set(`ZZZ:DEVICE_FP:${ltuid}:ID`, device_id);
    e.reply('常用设备信息绑定成功!');
  }

  getbody_(device_id, device_name) {
    return {
      app_version: '2.71.1',
      device_id: device_id,
      device_name: device_name,
      os_version: '29',
      platform: 'Android',
      registration_id: this.randomString(19),
    };
  }

  getUser(e) {
    return e.user.getMysUser('zzz');
  }

  getHeaders(e, ck, Ds_ = true, info) {
    let device_id, device_fp;
    if (!info) {
      const yaml_url = `./plugins/xhh/data/fp/${e.user_id}.yaml`;
      if (fs.existsSync(yaml_url)) {
        const data = YAML.parse(fs.readFileSync(yaml_url, 'utf-8'));
        device_id = data.device_id;
        device_fp = data.fp;
        info = data.device_info;
      }
    }
    return {
      Origin: 'https://app.mihoyo.com',
      'User-Agent': `Mozilla/5.0 (Linux; Android 13; ${info?.deviceModel || 'Mi 10'} Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.186 Mobile Safari/537.36 miHoYoBBS/2.71.1`,
      'Content-Type': 'application/json, text/plain, */*',
      Referer: 'https://app.mihoyo.com',
      'X-Requested-With': 'com.mihoyo.hyperion',
      "x-rpc-app_version": "2.71.1",
      'x-rpc-sys_version': '13',
      'x-rpc-client_type': '2',
      'x-rpc-device_id': device_id || this.getDeviceGuid(),
      'x-rpc-device_name': info
        ? info.deviceFingerprint.split('/')[0] + ' ' + info.deviceModel
        : this.randomString(lodash.random(1, 10)),
      'x-rpc-device_model': info?.deviceModel || 'Mi 10',
      'x-rpc-channel': 'miyousheluodi',
      'x-rpc-verify_key': 'bll8iq97cem8',
      'x-rpc-app_id': 'bll8iq97cem8',
      'x-rpc-device_fp': device_fp || '38d7f0aac0ab7',
      DS: Ds_ ? this.getDs() : this.getDs2(),
      Cookie: ck ?? '',
    };
  }

  //刷新ck
  //opts.bindGenshinCookie —— 是否额外调用 genshin 的老 CK 绑定器，默认不调用。
  //由 v2 stoken 换出的 ltoken/ltuid/cookie_token 属于老格式，米游社对它的校验
  //不一定认。genshin 内部用 reqMysUid() 校验，失败后会把「Cookie错误」推进
  //sendMsg，显示成「绑定Cookie失败」——但此刻 xhh 的 stoken 数据其实早已存好，
  //真正失败的只是这步额外的兼容动作。社区签到、角色查询、抽卡记录、水晶都只
  //依赖 stoken 那一侧，故默认不再强依赖它；确有需要时由调用方显式打开。
  async refresh_cookies(e, headers, SToken, id, opts = {}) {
    if (config().debug) logger.mark('[refresh_cookies] refreshing for id:', id);
    let urls = [
      `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${SToken}&uid=${id}`,
      'https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken',
    ];
    let res, Cookie, ltoken;
    for (let url of urls) {
      res = await fetchJson(url, { method: 'GET', headers }, '刷新 Cookie');
      if (res.data?.cookie_token) Cookie = res.data?.cookie_token;
      if (res.data?.ltoken) ltoken = res.data?.ltoken;
    }
    if (config().debug) logger.mark('[refresh_cookies] got Cookie:', !!Cookie, 'ltoken:', !!ltoken);
    if (!e.no_reply) e.no_reply = e.reply;
    let sendMsg = [];
    e.reply = msg => {
      // genshin 会把「绑定Cookie成功\n」「角色列表」「\n使用命令说明」这样
      // 一次性传过来，换行符就写在元素里，等的就是被原样拼成一条。
      // 直接摊平会让 TRSS 按数组发成三条独立消息。
      if (Array.isArray(msg)) sendMsg.push(msg.join(''));
      else sendMsg.push(msg);
    };
    if (!Cookie || !ltoken) {
      sendMsg.push(`米游社UID:${id}刷新cookie失败,请重新[扫码绑定]`);
      if (config().debug) logger.mark('[refresh_cookies] failed for id:', id);
      return { sendMsg };
    }
    e.msg = `ltoken=${ltoken};ltuid=${id};cookie_token=${Cookie}`;
    if (!opts.bindGenshinCookie) {
      if (config().debug) logger.mark('[refresh_cookies] 已跳过 genshin CK 绑定, id:', id);
      return { sendMsg, ltoken, ck: e.msg };
    }
    let bound = { ok: false, msgs: [] };
    if (opts.mid && opts.cookieTokenV2 && opts.ltokenV2) {
      const v2Ck =
        `ltuid=${id};account_mid_v2=${opts.mid};` +
        `cookie_token_v2=${opts.cookieTokenV2};ltoken_v2=${opts.ltokenV2};ltmid_v2=${opts.mid};`;
      bound = await this.tryBindGenshinCookie(e, v2Ck);
      if (config().debug) logger.mark('[refresh_cookies] v2 CK 结果:', bound.ok, 'id:', id);
    }
    if (!bound.ok) bound = await this.tryBindGenshinCookie(e, e.msg);
    if (bound.ok) sendMsg.push(...bound.msgs);
    else if (config().debug)
      logger.mark('[refresh_cookies] genshin CK 未绑定成功，不影响 xhh 自身数据, id:', id);
    if (config().hbxx) sendMsg = sendMsg.filter(m => typeof m === 'string' && m);
    return { sendMsg, ltoken, ck: e.msg };
  }

  //试一次 genshin 的 CK 绑定，并把回复收下来自己判断成败。
  //genshin 内部直接往 e.reply 抛消息，校验不过时是「Cookie错误」之类。
  //这里临时接管 e.reply 只为收集，不再让它混进 refresh_cookies 的 sendMsg——
  //此刻 xhh 的 stoken 早已落盘，genshin 绑定失败不该显示成扫码绑定失败。
  async tryBindGenshinCookie(e, ck) {
    const oldReply = e.reply;
    const msgs = [];
    e.reply = msg => {
      // 全是纯文本才拼接：混着 segment（按钮、合并转发）时 join 会把它们
      // 压成 [object Object]，这种情况保持原样交给框架处理
      if (Array.isArray(msg) && msg.every(x => typeof x === 'string')) msgs.push(msg.join(''));
      else if (Array.isArray(msg)) msgs.push(...msg);
      else msgs.push(msg);
    };
    e.msg = ck;
    e.ck = ck;
    try {
      const userck = (
        await import(`file://${process.cwd()}/plugins/genshin/model/user.js`)
      ).default;
      await new userck(e).bing();
    } catch (err) {
      msgs.push(String(err));
    } finally {
      e.reply = oldReply;
    }
    const text = msgs.map(m => String(Array.isArray(m) ? m.join('\n') : m)).join('\n');
    return { ok: !/Cookie错误|绑定Cookie失败|环境触发|数据错误/.test(text), msgs };
  }

  //通过uid获取stoken
  async getstoken(e, uid) {
    const path = `./plugins/xhh/data/Stoken/${e.user_id}.yaml`;
    const path2 = `./plugins/xiaoyao-cvs-plugin/data/yaml/${e.user_id}.yaml`;
    let data;
    if (fs.existsSync(path)) {
      data = yaml.get(path)[uid];
      if (!data) return false;
      return data.ck_stoken;
    } else if (fs.existsSync(path2)) {
      data = yaml.get(path2)[uid];
      if (!data) return false;
      return `stuid=${data.stuid};stoken=${data.stoken};mid=${data.mid};`;
    }
    return false;
  }

  //stoken(刷新ck用)
  async getSToken(e) {
    const path = `./plugins/xhh/data/Stoken/${e.user_id}.yaml`;
    const path2 = `./plugins/xiaoyao-cvs-plugin/data/yaml/${e.user_id}.yaml`;
    let data,
      data_ = {};
    if (fs.existsSync(path)) {
      data = yaml.get(path);
      for (let k in data) {
        data_[data[k].stuid] = [data[k].stoken, data[k].ck_stoken];
      }
      return data_;
    }

    if (fs.existsSync(path2)) {
      let sj = {};
      data = yaml.get(path2);
      for (let k in data) {
        data_[data[k].stuid] = [
          data[k].stoken,
          `stuid=${data[k].stuid};stoken=${data[k].stoken};mid=${data[k].mid};`,
          data[k].mid,
          data[k].ltoken,
        ];
      }
      /*
          hk4e_cn国服原神
          hkrpg_cn国服星铁
          nap_cn国服绝区零
          */
      const game_list = ['hk4e_cn', 'hkrpg_cn', 'nap_cn'];
      for (const key in data_) {
        const headers = this.getHeaders(e, data_[key][1]);
        let res = await api(e, { type: 'GameRoles', headers: headers });
        res.data.list.map(v => {
          if (game_list.includes(v.game_biz)) {
            sj[v.game_uid] = {
              uid: v.game_uid,
              stuid: key,
              stoken: data_[key][0],
              ck_stoken: data_[key][1],
              mid: data_[key][2],
              ltoken: data_[key][3],
              region_name: v.region_name,
              region: v.region,
            };
          }
        });
        data_[key].splice(2); //删除多余数据
      }
      fs.writeFileSync(path, YAML.stringify(sj), 'utf-8');
      return [data_, sj];
    }
    return false;
  }

  /**
   * 「只有逍遥侧数据」的人第一次签到时，顺手把 xhh 侧文件补出来。
   *
   * 做的事就是 getSToken 的第二条路：从逍遥文件取出 stoken，调一次 GameRoles
   * 列出各游戏 uid，写成 xhh 的 yaml。跟手动发「#刷新ck」走的是同一条路，
   * 不需要扫码（两边都没数据才会扫码，那种情况这里不碰）。
   *
   * 与手动刷新的区别：这里只补文件，不换 cookie_token（签到时 ensureCookieToken
   * 每次都会换），也不碰 e.reply —— refresh_cookies 会改写 e.reply/e.no_reply，
   * 在定时任务的假 e 上那样做会把消息吞掉。
   */
  async ensureXhhFromXiaoyao(e) {
    const qq = String(e?.user_id || '');
    if (!/^\d{5,12}$/.test(qq)) return { ok: false, reason: 'qq 无效' };
    if (!config().auto_backfill) return { ok: false, reason: '开关关闭' };
    const xhPath = `./plugins/xhh/data/Stoken/${qq}.yaml`;
    const xyPath = `./plugins/xiaoyao-cvs-plugin/data/yaml/${qq}.yaml`;
    if (fs.existsSync(xhPath)) return { ok: true, skipped: '已有 xhh 文件' };
    if (!fs.existsSync(xyPath)) return { ok: false, reason: '两个来源都没有' };
    try {
      const r = await this.getSToken(e);
      // getSToken 补齐时返回 [stokenMap, 写出的数据]，文件已落盘
      if (Array.isArray(r)) {
        const n = Object.keys(r[1] || {}).length;
        logger.mark(`[xhh][sign] 已从逍遥数据补齐 ${qq} 的 xhh 文件（${n} 条）`);
        return { ok: true, filled: n };
      }
      return { ok: false, reason: 'getSToken 未补齐' };
    } catch (err) {
      logger.error(`[xhh][sign] 补齐 ${qq} 的 xhh 文件失败: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  getDeviceGuid() {
    function S4() {
      return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    }
    return (
      S4() + S4() + '-' + S4() + '-' + S4() + '-' + S4() + '-' + S4() + S4() + S4()
    );
  }
  getDs(salt = this.mysSalt) {
    const randomStr = this.randomString(6);
    const timestamp = Math.floor(Date.now() / 1000);
    let Ds = md5(`salt=${salt}&t=${timestamp}&r=${randomStr}`);
    return `${timestamp},${randomStr},${Ds}`;
  }

  getDs2(query = '', body = '', salt = this.mysSalt2) {
    if (salt == 4) salt = this.mysSalt3
    let t = Math.round(new Date().getTime() / 1000);
    let r = Math.floor(Math.random() * 900000 + 100000);
    let DS = md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`);
    return `${t},${r},${DS}`;
  }

  /** 签到ds */
  getDsSign() {
    /** @Womsxd */
    const n = 'jEpJb9rRARU2rXDA9qYbZ3selxkuct9a';
    const t = Math.round(new Date().getTime() / 1000);
    const r = lodash
      .sampleSize('abcdefghijklmnopqrstuvwxyz0123456789', 6)
      .join('');
    const DS = md5(`salt=${n}&t=${t}&r=${r}`);
    return `${t},${r},${DS}`;
  }

  randomString(length, os = false) {
    let randomStr = '';
    for (let i = 0; i < length; i++) {
      randomStr += lodash.sample(
        os ? '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
          : 'abcdefghijklmnopqrstuvwxyz0123456789'
      );
    }
    return randomStr;
  }

  getServer(uid, game) {
    if (game === 'zzz') {
      return 'prod_gf_cn';
    }
    const isSr = game === 'sr';
    switch (String(uid)[0]) {
      case '1':
      case '2':
      case '3':
        return isSr ? 'prod_gf_cn' : 'cn_gf01'; // 官服
      case '5':
        return isSr ? 'prod_qd_cn' : 'cn_qd01'; // B服
    }
    // 崩三官服 uid 首位可能是 6/8/9，默认应返回 cn_gf01，而非原神/星铁的 prod_gf_cn
    return game === 'bh3' ? 'cn_gf01' : 'prod_gf_cn';
  }

  /**
   * 服务器代码转中文名（给界面显示用）。
   *
   * getServer() 返回的是**接口用的服务器代码**（prod_gf_cn / cn_gf01 这种），
   * 直接显示出来看到的是「服务器：prod_gf_cn」，不是「国服」。
   *
   * 代码分两代，老的是崩三/原神的 cn_gf01 / os_usa，
   * 新的星铁和绝区零换成了 prod_gf_cn / prod_official_usa 这一套，两边都要认。
   * 命名规律（实测代码里出现过的全集）：
   *   prod_gf_{cn,us,jp,sg,eu}        国服/美服/日服/新加坡服/欧服
   *   prod_qd_cn                       B服
   *   prod_official_{usa,asia,eur,euro,cht}  国际服（official =  HoYoPlay/国际账号）
   *   cn_gf01 / cn_qd01                国服 / B服（老代码）
   *   os_{usa,asia,euro,cht}          美服 / 亚服 / 欧服 / 港澳台服
   * 认不出来就原样返回，不给空字符串。
   */
  getServerName(code) {
    const key = String(code || '').trim();
    if (!key) return '';
    if (this.serverNameMap[key]) return this.serverNameMap[key];
    // 兜底：prod_official_xxx / prod_gf_xxx 后面那截基本就是地区
    const guess = key.match(/^(?:prod_(?:gf|official)_|os_)([a-z]{2,4})$/)?.[1];
    if (guess && this.serverNameMap[`os_${guess}`]) return this.serverNameMap[`os_${guess}`];
    return key;
  }

}




export default new mhy();
