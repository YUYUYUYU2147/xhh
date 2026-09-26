import fs from 'fs';
import {
    yyjson,
    yaml,
    render,
    mys,
    config,
    getSource,
    pluginPriority
} from '#xhh';
import {
    execSync
} from 'child_process';

const path = process.cwd();

export class voice extends plugin {
    constructor() {
        super({
            name: '[小花火]角色语音',
            dsc: '',
            event: 'message',
            priority: pluginPriority('voice', 15),
            rule: [{
                    reg: '^#*(小花火)?清(空|除)语音(图片(列表)?)?缓存$',
                    fnc: 'qc',
                    permission: 'master',
                },
                {
                    reg: '^(#|\\*)?(小花火|xhh)?(崩三|崩坏3|崩坏三|BH3)(.*?)语音(列表)?$',
                    fnc: 'yylb',
                },
                {
                    reg: '^(#|\\*)?(小花火|xhh)(.+?)语音(列表)?$',
                    fnc: 'yylb',
                },
                {
                    reg: '^(#|\\*)?(星铁|原神)(.+?)语音(列表)?$',
                    fnc: 'yylb',
                },
                {
                    reg: '^((\\d+)(.*))|((.*)(\\d+))$',
                    fnc: 'fsyy',
                },
            ],
        });
        this.task = {
            cron: '0 20 4 * * *', //Cron表达式，(秒 分 时 日 月 星期)
            name: '[小花火]清空语音列表图片缓存',
            fnc: () => this.qc(),
        };
    }

    async tu(e, table, name, background) {
        let data = {
            name,
            table,
            background,
        };
        let img = await render('yytable/table', data, {
            e
        });
        if (img) return img;
        return false;
    }

    async yylb(e) {
        const isBh3 = /崩三|崩坏3|崩坏三|BH3/i.test(e.msg);
        const isSr = /星铁/.test(e.msg);
        if (isBh3) return this.bh3VoiceList(e);
        const voiceEnabled = isSr ? config().sr_voice !== false : config().gs_voice !== false;
        if (!config().all_voice || !voiceEnabled) return false;
        let name = e.msg.replace(/#|\*|小花火|xhh|星铁|原神|语音|列表/gi, '');

        if (!isSr && config().gs_voice !== false) {
            //调用小花火原神别名
            let gsnames = yaml.get('./plugins/xhh/system/default/gs_js_names.yaml');
            for (let i in gsnames) {
                if (gsnames[i].includes(name)) {
                    name = i;
                    break;
                }
            }
        }
        //先查原神
        // let gs_id = (await mys.data(name)).id;
        let background = '../../../../../plugins/xhh/resources/yytable/bg0.png';

        if (name == '空') {
            // gs_id = '505542'
            background = '../../../../../plugins/xhh/resources/yytable/bg.png';
        } else if (name == '荧') {
            // gs_id = '505527'
            background = '../../../../../plugins/xhh/resources/yytable/bg.png';
        }
        // let list
        let img
        // let isSr = false;
        let data, table = []
        data = !isSr && config().gs_voice !== false
            ? await yyjson.gs_other_download(name)
            : false;
        if (data) {
            let {
                list,
                id
            } = data
            if (list.length) {
                // if (gs_id) list = await yyjson.gs_download(gs_id);
                for (let v of list) {
                    table.push(v.title);
                }
                img = await this.tu(e, table, name, background);
            }
        } else if (config().sr_voice !== false) {
            //非原神查星铁
            let srnames = yaml.get('./plugins/xhh/system/default/sr_js_names.yaml');
            for (let i in srnames) {
                if (srnames[i].includes(name)) {
                    name = i;
                    break;
                }
            }
            data = await yyjson.sr_other_download(name);
            if (!data) return false;
            let {
                list,
                id
            } = data
            // let sr_id = (await mys.data(name, 'js', true)).id;
            if (list.length) {
                // if (sr_id) {
                //     let sr = await yyjson.sr_download(sr_id);
                //     table = sr.table;
                //     yy = sr.sr_yy;
                // }
                for (let v of list) {
                    table.push(v.title);
                }
                background = '../../../../../plugins/xhh/resources/yytable/sr.png';
                img = await this.tu(e, table, name, background);
                // isSr = true;
            }
        }

        // if (!isSr) {
        //     data = {
        //         name,
        //         isSr,
        //         list,
        //         list
        //     };
        // } else {
        //     data = {
        //         name,
        //         isSr,
        //         table,
        //         yy,
        //         list
        //     };
        // }

        if (img) {
            let f = await e.reply(img);
            await this.temp();
            if (f.data?.message_id) f.message_id = f.data.message_id;
            f.message_id = f.message_id.toString().replace(/\//g, '');
            fs.writeFileSync(
                `./plugins/xhh/temp/yy_pic/${f.message_id}.json`,
                JSON.stringify(data),
                'utf-8'
            );
            return true;
        }
        return false;
    }

    // 崩坏3语音：走官方 WIKI 的配音展示（mp3 直链）
    async bh3VoiceList(e) {
        if (!config().all_voice || config().bh3_voice === false) return false;
        let name = e.msg.replace(/#|\*|小花火|xhh|崩三|崩坏3|崩坏三|BH3|语音|列表/gi, '').trim();
        if (!name) return this.bh3VoiceIndex(e);
        const data = await yyjson.bh3_other_download(name);
        if (!data?.list?.length) return e.reply(`未找到崩坏3角色「${name}」的语音，换个名字试试~`, true);

        const table = data.list.map((v, idx) => `${idx + 1}. ${v.tab || ''}${v.title}`.trim());
        const img = await this.tu(
            e,
            table,
            name,
            '../../../../../plugins/xhh/resources/yytable/bg.png',
        );
        if (!img) return false;
        const f = await e.reply(img);
        await this.temp();
        if (f.data?.message_id) f.message_id = f.data.message_id;
        f.message_id = f.message_id.toString().replace(/\//g, '');
        fs.writeFileSync(
            `./plugins/xhh/temp/yy_pic/${f.message_id}.json`,
            JSON.stringify(data),
            'utf-8'
        );
        return true;
    }

    // 崩坏3可查语音角色名一览
    async bh3VoiceIndex(e) {
        const roles = yaml.get('./plugins/xhh/system/default/bh3_js_names.yaml') || {};
        const names = Object.keys(roles);
        if (!names.length) return e.reply('未读取到崩坏3角色数据~', true);
        const lines = [];
        for (let i = 0; i < names.length; i += 5) {
            lines.push(names.slice(i, i + 5).join('、'));
        }
        return e.reply(
            `崩坏3语音支持角色（共${names.length}名）：\n${lines.join('\n')}\n\n用法：#崩三角色名语音，例如 #崩三琪亚娜语音\n（崩坏3语音为中文单语，回复图片发数字即可发送）`,
            true,
        );
    }

    async fsyy(e) {
        if (!e.source && !e.getReply) return false;
        if (!config().all_voice || (config().gs_voice === false && config().sr_voice === false)) return false;
        let source = null
        // 多账号下图片可能由其他 bot 发出，优先用收到消息的 bot 查，避免拿不到
        for (const getter of [
            () => e.bot?.getMsg?.(e.source?.message_id),
            () => Bot.getMsg(e.source?.message_id),
            () => (e.source?.message_id ? null : e.getReply?.()),
        ]) {
            try {
                const res = await getter()
                if (res) {
                    source = res
                    break
                }
            } catch (_) {}
        }
        if (!source) source = await getSource(e)
        if (!source) return false;
        // 多账号部署下 Bot.uin 是数组/集合，直接 Number() 会得到 NaN 导致误判
        const uins = (Array.isArray(Bot.uin) || Bot.uin instanceof Set ? [...Bot.uin] : [Bot.uin])
            .map(v => Number(v))
            .filter(Boolean);
        const sender = Number(source.user_id);
        if (uins.length && sender && !uins.includes(sender)) return false;
        if (source.message?.[0]?.type != 'image') return false;

        if (e.msg && e.msg.length > 5) return false;
        let xh = /\d+/.exec(e.msg);
        let n = xh - 1;
        let lx
        if (/日语|日文/.test(e.msg)) {
            // type = '日语'
            lx = 'jp'
        } else if (/汉语|中文|华语/.test(e.msg)) {
            // type = '汉语'
            lx = 'cn'
        } else if (/外语|英语|英文/.test(e.msg)) {
            // type = '英语'
            lx = 'en'
        } else if (/韩语|韩文/.test(e.msg)) {
            // type = '韩语'
            lx = 'kr'
        } else if (/^([0-9]|[0-9][0-9]|[1-2][0-9][0-9])$/.test(e.msg)) {
            // type = '汉语'
            lx = 'cn'
        } else {
            return false;
        }

        source.message_id = source.message_id.toString().replace(/\//g, '');

        const dir = './plugins/xhh/temp/yy_pic/'
        let cachePath = `${dir}${source.message_id}.json`
        if (!fs.existsSync(cachePath)) {
            // 多账号/适配器下 message_id 可能对不上，回退到最近一次的语音列表
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []
            if (!files.length) return false
            cachePath = `${dir}${files
                .map(f => ({ f, t: fs.statSync(dir + f).mtimeMs }))
                .sort((a, b) => b.t - a.t)[0].f}`
        }
        let data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
        // let isSr = data.isSr;
        // let list = data.list;
        // let table = data.table;
        let {
            list,
            id
        } = data;
        if (!list[n]) return e.reply('喂喂喂！你这序号不对吧🤔', true);
        // let yy = data.yy;
        // let x;
        // const pattern = /[\u4e00-\u9fa5]+/g; // 匹配中文字符
        // if (isSr) {
        //     switch (type) {
        //         case '汉语': {
        //             x = 0;
        //             break;
        //         }
        //         case '英语': {
        //             x = 1;
        //             break;
        //         }
        //         case '日语': {
        //             x = 2;
        //             break;
        //         }
        //         case '韩语': {
        //             x = 3;
        //             break;
        //         }
        //         default:
        //             return false;
        //     }
        // } else {
        //     for (let v of list) {
        //         if (v.tab_name == type) {
        //             table = v.table;
        //             break;
        //         }
        //     }
        // }
        // if (table.length) {
        //     for (let i in table) {
        //         if (table[i].name.match(pattern).join('') == list[n].title.match(pattern).join('')) {
        //             yy = isSr ? yy[x][i].replace(/sourcesrc=|><\/audio><\/div>/g, '') : table[i].audio_url
        //             break;
        //         }
        //     }
        // }
        if (!ffmpeg()) return false;
        let yy = data.game === 'bh3' ? list[n].id : list[n].id + lx + '.ogg'
        logger.mark(`\x1B[36m${yy}\x1B[0m`);
        let res = await fetch(yy);
        if (!res.ok) {
            logger.mark('语音直接访问失败，尝试添加请求头下载...');
            let headers = {
                "accept": "*/*",
                "accept-encoding": "identity;q=1, *;q=0",
                "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
                "cookie": "_first_time=1;_lr_retry_request=true;",
                "priority": "i",
                "Range": "bytes=0-",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "referer": data.game === 'bh3' ? `https://baike.mihoyo.com/bh3/wiki/content/${String(id).replace('bh3-', '')}/detail` : id.includes('-character') ? `https://starrail.honeyhunterworld.com/${id}/` : `https://gensh.honeyhunterworld.com/${id}/`,
                "sec-ch-ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "video",
                "sec-fetch-mode": "no-cors",
                "sec-fetch-site": "same-origin",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
            }
            res = await fetch(yy, {
                method: 'GET',
                headers
            })
            if (!res.ok) return e.reply('获取该语音失败~', true);
            data = Buffer.from(await res.arrayBuffer())
            yy = './plugins/xhh/temp/yy_pic/temp.ogg'
            fs.writeFileSync(yy, data);
        }
        // if (!yy_ || typeof yy_ != 'string') return e.reply('获取该语音失败~', true);
        let vo = segment.record(yy);
        await e.reply(
            `[简述]:${list[n].title}\n[内容]:${list[n].dec.replace(/<br\\\/>/g, '\n').replace(/<color=#37FFFF>|<\\\/color>/g, '')}`
        );
        e.reply(vo);
        return true;
    }

    async qc(e) {
        try {
            fs.rmSync('./plugins/xhh/temp/yy_pic/', {
                recursive: true
            });
        } catch (err) {}
        if (e) return e.reply('已清空语音列表图片缓存');
    }

    async temp() {
        if (!fs.existsSync('./plugins/xhh/temp/yy_pic/')) {
            fs.mkdirSync('./plugins/xhh/temp/yy_pic/', {
                recursive: true
            });
        }
    }
}

function ffmpeg() {
    try {
        const ret = execSync('ffmpeg -version').toString();
        if (!ret.includes('version')) {
            logger.error('未安装 ffmpeg 无法发送语音');
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}
