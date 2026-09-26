import yaml from './system/yaml.js'
import { getGroupNameMap, refreshGroupNames } from './system/group_name.js'

const _path = './plugins/xhh/config/'

function getCfg() {
  return yaml.get(_path + 'config.yaml') || {}
}

function getOther() {
  return yaml.get(_path + 'other.yaml') || {}
}

function getSign() {
  return yaml.get(_path + 'sign.yaml') || {}
}

function getBh3Remind() {
  return yaml.get(_path + 'bh3_remind.yaml') || {}
}

function getActivityRemind() {
  return yaml.get(_path + 'activity_remind.yaml') || {}
}

const defaultBh3GuideSources = {
  abyss: [
    '寂灭|11956740|0,1,3,4,5,6,7,8,9,10,11,12,13,14,15|残月',
    '红莲|11956740|0,1,3,4,5,6,7,8,9,10,11,12,13,14,15|残月',
    '红莲|15491760|0,1,3,4,5,6,7,8,9,10,11,12,13,14,15|墨之羽',
    '红莲|30269990|0,1,3,4,5,6,7,8,9,10,11,12,13,14,15|朔守',
  ].join('\n'),
  battlefield: [
    '记忆战场|11956740|0,1,2,3,4,5,6,7,8,9|残月',
    '战场作业|15491760|0,1,2,3,4,5,6,7,8,9|墨之羽',
    '终极区战场|30269990|0,1,2,3,4,5,6,7,8,9|朔守',
  ].join('\n'),
  godwar: [
    '往世乐土|11956740|0,1,2,3,4,5,6,7,8,9|残月',
    '乐土攻略|15491760|0,1,2,3,4,5,6,7,8,9|墨之羽',
    '乐土因子|30269990|0,1,2,3,4,5,6,7,8,9|朔守',
  ].join('\n'),
  zzzDefense: [
    '式舆防卫战|4068738|0,1,2,3,4,5,6,7,8,9|洗礼酱',
    '防卫战攻略|285802042|0,1,2,3,4,5|HoYo青枫',
  ].join('\n'),
  zzzDeadly: [
    '危局强袭战|4068738|0,1,2,3,4,5,6,7,8,9|洗礼酱',
    '危局攻略|285802042|0,1,2,3,4,5|HoYo青枫',
  ].join('\n'),
}

const priorityInput = (field, label, defaultValue) => ({
  field,
  label,
  helpMessage: `默认 ${defaultValue}；Yunzai 数字越小优先级越高，修改后需重启`,
  component: 'InputNumber',
  componentProps: { min: -9999999999, max: 9999999999, step: 1 },
})

export const supportGuoba = () => {
  const cfg = getCfg()
  const bh3Remind = getBh3Remind()
  const sign = getSign()
  const activityRemind = getActivityRemind()
  const toGroupArray = (groups) => {
    if (!groups) return []
    if (typeof groups.values === 'function') return Array.from(groups.values())
    if (Array.isArray(groups)) return groups
    if (typeof groups === 'object') return Object.values(groups)
    return []
  }
  const bot = globalThis.Bot || {}
  const botGroupList = [
    ...toGroupArray(bot.gl),
    ...Object.values(bot.bots || {}).flatMap(item => toGroupArray(item?.gl)),
  ]
  const pickGroupId = (item = {}) =>
    item.group_id ?? item.groupId ?? item.id ?? item.gid ?? item.group ?? ''
  const pickGroupName = (item = {}) =>
    item.group_name ?? item.groupName ?? item.name ?? item.group_name_ ?? ''
  const groupOptions = botGroupList
    .map(item => {
      const value = String(pickGroupId(item) ?? '')
      const name = String(pickGroupName(item) ?? '').trim()
      return { label: name ? `${name} - ${value}` : value, value }
    })
    .filter(item => item.value && item.value !== 'undefined')
  const configuredGroups = [
    ...(bh3Remind.groups || []),
    ...(bh3Remind.all_note_groups || []),
    ...(sign.sign_group || []),
    ...(sign.bbs_sign_group || []),
    ...Object.values(activityRemind.groups || {}).flat(),
    ...(Array.isArray(cfg.groups) ? cfg.groups : []),
  ].map(v => String(v).trim()).filter(Boolean)
  const nameMap = getGroupNameMap()
  for (const id of new Set(configuredGroups)) {
    if (!nameMap.get(String(id))) refreshGroupNames([id])
  }
  const cachedOptions = [...getGroupNameMap().entries()].map(([id, name]) => ({ label: `${name} - ${id}`, value: id }))
  const groupList = [...new Map(
    [...groupOptions, ...cachedOptions, ...configuredGroups.map(value => {
      const name = getGroupNameMap().get(String(value))
      return { label: name ? `${name} - ${value}` : `群 ${value}（名称未知）`, value }
    })]
      .map(item => [String(item.value), { ...item, value: String(item.value) }]),
  ).values()]

  return ({
  pluginInfo: {
    name: 'xhh',
    title: '小花火(xhh)',
    description: '多功能辅助插件，支持米游社签到、B站解析、攻略查询等',
    author: '@dknyxhh',
    authorLink: 'https://github.com/dknyxhh',
    link: 'https://github.com/dknyxhh/xhh',
    isV3: true,
    isV2: false,
    showInMenu: 'auto',
    icon: 'mdi:fire',
    iconColor: '#ff6b35',
    // 显示成图片：使用插件自带的花火立绘（绝对路径，锅巴优先展示 iconPath）
    iconPath: process.cwd() + '/plugins/xhh/resources/Tl/imgs/小花火.png',
  },
  configInfo: {
    schemas: [
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '基本设置',
      },
      {
        field: 'update',
        label: '凌晨自动更新',
        helpMessage: '凌晨3:30强制更新（会覆盖文件）',
        component: 'Switch',
      },
      {
        field: 'img_quality',
        label: '图片渲染精度',
        helpMessage: '数字，单位%',
        component: 'InputNumber',
        componentProps: { min: 1, max: 100, step: 1 },
      },
      {
        field: 'wiki',
        label: '小花火图鉴启用',
        component: 'Switch',
      },
      {
        field: 'bdsb',
        label: '使用xhh绑定设备',
        helpMessage: '作用于genshin/StarRail/ZZZ-Plugin',
        component: 'Switch',
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '塔罗牌',
      },
      {
        field: 'tlp',
        label: '塔罗牌开关',
        component: 'Switch',
      },
      {
        field: 'tlpcs',
        label: '塔罗牌每天上限次数',
        component: 'InputNumber',
        componentProps: { min: 1, max: 99, step: 1 },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '游戏攻略',
      },
      {
        field: 'gs_logs',
        label: '原神历史卡池',
        component: 'Switch',
      },
      {
        field: 'sr_logs',
        label: '星铁历史卡池',
        component: 'Switch',
      },
      {
        field: 'zzz_logs',
        label: '绝区零历史卡池',
        component: 'Switch',
      },
      {
        field: 'bh3_logs',
        label: '崩坏3历史卡池',
        component: 'Switch',
      },
      {
        field: 'all_voice',
        label: '角色语音总开关',
        helpMessage: '关闭后四个游戏语音全部停用',
        component: 'Switch',
      },
      {
        field: 'gs_voice',
        label: '原神语音',
        component: 'Switch',
      },
      {
        field: 'sr_voice',
        label: '星铁语音',
        component: 'Switch',
      },
      {
        field: 'zzz_voice',
        label: '绝区零语音',
        helpMessage: '开关已预留；当前仓库暂无绝区零角色语音数据源',
        component: 'Switch',
      },
      {
        field: 'bh3_voice',
        label: '崩坏3语音',
        helpMessage: '开关已预留；当前仓库暂无崩坏3角色语音数据源',
        component: 'Switch',
      },
      {
        field: 'huobi_num',
        label: '星铁战绩显示数量',
        helpMessage: '取1-3，避免图太长',
        component: 'Select',
        componentProps: {
          options: [
            { label: '1', value: 1 },
            { label: '2', value: 2 },
            { label: '3', value: 3 },
          ],
        },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '签到设置',
      },
      {
        field: 'sign',
        label: '签到功能',
        helpMessage: '自动签到在sign.yaml配置',
        component: 'Switch',
      },
      {
        field: 'zd_sign',
        label: '自动签到',
        helpMessage: '0关闭 1开启',
        component: 'RadioGroup',
        componentProps: {
          options: [
            { label: '关闭', value: 0 },
            { label: '开启', value: 1 },
          ],
        },
      },
      {
        field: 'sign_hour',
        label: '自动签到时',
        helpMessage: '0~23，保存后无需重启，下一次到点执行',
        component: 'InputNumber',
        componentProps: { min: 0, max: 23, step: 1 },
      },
      {
        field: 'sign_minute',
        label: '自动签到分',
        helpMessage: '0~59，保存后无需重启，下一次到点执行',
        component: 'InputNumber',
        componentProps: { min: 0, max: 59, step: 1 },
      },
      {
        field: 'bbs_zd_sign',
        label: '社区自动签到',
        helpMessage: '开启后按下方时间，使用 sign.yaml 中登记的群成员执行米游社社区签到',
        component: 'RadioGroup',
        componentProps: {
          options: [
            { label: '关闭', value: 0 },
            { label: '开启', value: 1 },
          ],
        },
      },
      {
        field: 'bbs_sign_hour',
        label: '社区签到时',
        helpMessage: '0~23，保存后无需重启，下一次到点执行',
        component: 'InputNumber',
        componentProps: { min: 0, max: 23, step: 1 },
      },
      {
        field: 'bbs_sign_minute',
        label: '社区签到分',
        helpMessage: '0~59，保存后无需重启，下一次到点执行',
        component: 'InputNumber',
        componentProps: { min: 0, max: 59, step: 1 },
      },
      {
        field: 'sbai',
        label: '签到失败@提醒',
        helpMessage: '自动签到结束后@失败用户',
        component: 'Switch',
      },
      {
        field: 'sign_group',
        label: '游戏签到白名单群',
        helpMessage: '直接选择群，留空则不限制',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'bbs_sign_group',
        label: '社区签到白名单群',
        helpMessage: '直接选择群，留空则不限制',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'sign_users',
        label: '游戏自动签到用户白名单',
        helpMessage: '格式：群号:QQ1,QQ2；多个群用换行或分号分隔',
        component: 'InputTextArea',
      },
      {
        field: 'bbs_sign_users',
        label: '社区自动签到用户白名单',
        helpMessage: '格式：群号:QQ1,QQ2；和游戏自动签到用户分开配置',
        component: 'InputTextArea',
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '米游社',
      },
      {
        field: 'groups',
        label: '米游社视频播报群',
        helpMessage: '直接选择播报群；也可用“添加播报群”命令维护',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'forwardMsg',
        label: '播报合并转发',
        helpMessage: '米游社视频播报是否用合并转发发送',
        component: 'Switch',
      },
      {
        field: 'bh3',
        label: '播报崩坏3',
        helpMessage: '米游社视频播报是否包含崩坏3',
        component: 'Switch',
      },
      {
        field: 'by',
        label: '播报崩坏因缘精灵',
        helpMessage: '米游社视频播报是否包含崩坏因缘精灵',
        component: 'Switch',
      },
      {
        field: 'xbgd',
        label: '播报星布谷地',
        helpMessage: '米游社视频播报是否包含星布谷地',
        component: 'Switch',
      },
      {
        field: 'cover',
        label: '播报封面原图',
        helpMessage: '开启后米游社视频播报封面尽量使用原图下载',
        component: 'Switch',
      },
      {
        field: 'group_config',
        label: '群播报屏蔽配置',
        helpMessage: '每行一个群：群号=gs,sr,zzz,bh3,by,xbgd；表示该群屏蔽这些游戏播报',
        component: 'InputTextArea',
      },
      {
        field: 'sm',
        label: '米游社扫码绑定',
        component: 'Switch',
      },
      {
        field: 'sm_cd',
        label: '扫码绑定CD',
        helpMessage: '单位：秒',
        component: 'InputNumber',
        componentProps: { min: 0, max: 3600, step: 10 },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: 'B站设置',
      },
      {
        field: 'bilibili',
        label: 'B站功能开关',
        component: 'Switch',
      },
      {
        field: 'list_num',
        label: '评论区显示条数',
        helpMessage: '1-20条',
        component: 'InputNumber',
        componentProps: { min: 1, max: 20, step: 1 },
      },
      {
        field: 'qn',
        label: '视频下载清晰度',
        component: 'Select',
        componentProps: {
          options: [
            { label: '360P', value: 0 },
            { label: '480P', value: 1 },
            { label: '720P', value: 2 },
            { label: '1080P', value: 3 },
            { label: '1080P+高码率', value: 4 },
            { label: '4K超清', value: 5 },
          ],
        },
      },
      {
        field: 'dow_size',
        label: '自动下载大小阈值',
        helpMessage: '小于此MB数自动下载，0代表不自动下载；超过99MB会作为群文件发送',
        component: 'InputNumber',
        componentProps: { min: 0, max: 2048, step: 1 },
      },
      {
        field: 'b_lj',
        label: '解析时弹出原链接',
        component: 'Switch',
      },
      {
        field: 'b_cd',
        label: '同视频/动态3分钟CD',
        component: 'Switch',
      },
      {
        field: 'b_img_num',
        label: '图片合并阈值',
        helpMessage: '小于几张图片时不合并消息，0表示始终合并',
        component: 'InputNumber',
        componentProps: { min: 0, max: 20, step: 1 },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: 'B站直播解析',
      },
      {
        field: 'bili_live',
        label: '自动解析直播间',
        helpMessage: '消息里出现直播间链接/b23短链时自动解析，默认开启；关闭后仍可用「#直播解析 房间号」手动解析',
        component: 'Switch',
      },
      {
        field: 'bili_live_only_live',
        label: '仅回复开播中的',
        helpMessage: '开启后，未开播的直播间自动解析时不回复',
        component: 'Switch',
      },
      {
        field: 'bili_live_cd',
        label: '同一直播间CD',
        helpMessage: '单位秒，0表示不限制；手动解析不受限制',
        component: 'InputNumber',
        componentProps: { min: 0, max: 3600, step: 10 },
      },
      {
        field: 'bili_live_video',
        label: '手动解析后录制视频',
        helpMessage: '手动「#直播解析」时，解析完再录一段直播直接发出去',
        component: 'Switch',
      },
      {
        field: 'bili_live_video_auto',
        label: '自动解析也录制视频',
        helpMessage: '群里每条直播链接都录一段会很吃带宽，默认关；想全自动就开',
        component: 'Switch',
      },
      {
        field: 'bili_live_video_time',
        label: '录制时长',
        helpMessage: '单位秒，默认60（1分钟）；录满就发',
        component: 'InputNumber',
        componentProps: { min: 5, max: 600, step: 5 },
      },
      {
        field: 'bili_live_video_size',
        label: '录制大小上限',
        helpMessage: '单位MB，录到这个大小就停（默认99）；0表示只按时长停',
        component: 'InputNumber',
        componentProps: { min: 0, max: 2048, step: 1 },
      },
      {
        field: 'bili_live_dm',
        label: '直播间发弹幕',
        helpMessage: '开启后可用「#弹幕 内容」往直播间发弹幕，需要先「小花火b站登录」',
        component: 'Switch',
      },
      {
        field: 'bili_live_dm_perm',
        label: '发弹幕权限',
        helpMessage: '默认「群管理」；私聊不受限制',
        component: 'Select',
        componentProps: {
          options: [
            { label: '所有人', value: 'all' },
            { label: '群管理(含主人)', value: 'admin' },
            { label: '仅主人', value: 'master' },
          ],
        },
      },
      {
        field: 'bili_live_dm_cd',
        label: '弹幕冷却',
        helpMessage: '单位秒，默认5；0表示不限制。主人不受限制',
        component: 'InputNumber',
        componentProps: { min: 0, max: 600, step: 1 },
      },
      {
        field: 'bili_live_qn',
        label: '录制清晰度',
        helpMessage: '房间没开该档会自动降级到可用档位',
        component: 'Select',
        componentProps: {
          options: [
            { label: '原画', value: 10000 },
            { label: '蓝光', value: 400 },
            { label: '超清', value: 250 },
            { label: '高清', value: 150 },
            { label: '流畅', value: 80 },
          ],
        },
      },
      {
        field: 'emoji',
        label: 'Emoji CDN渲染',
        helpMessage: '浏览器不支持emoji时用CDN渲染',
        component: 'Switch',
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '卡池/图鉴外观',
      },
      {
        field: 'gacha_header_art_source',
        label: '右上角立绘来源',
        helpMessage: '自定义=优先 fixed_splash/custom_splash/本地随机图；官方=优先游戏官方角色立绘',
        component: 'Select',
        componentProps: {
          options: [
            { label: '自定义立绘', value: 'custom' },
            { label: '官方立绘', value: 'official' },
          ],
        },
      },
      {
        field: 'gacha_up_icon_source',
        label: 'UP小图来源',
        helpMessage: '自定义=优先本地/面板图；官方=优先游戏官方头像/图标',
        component: 'Select',
        componentProps: {
          options: [
            { label: '自定义小图', value: 'custom' },
            { label: '官方小图', value: 'official' },
          ],
        },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '崩坏3扩展',
      },
      {
        field: 'bh3_all_note_enable',
        label: '启用四游戏体力聚合',
        helpMessage: '控制 #体力/#小花火体力 等四游戏总览；关闭后仍可使用 #原神体力/#星铁体力 等单游戏查询',
        component: 'Switch',
      },
      {
        field: 'bh3_all_note_groups',
        label: '四游戏体力推送群',
        helpMessage: '直接选择推送群，留空则不推送',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'stamina_push_enable',
        label: '启用体力自动推送',
        helpMessage: '按群成员的绑定账号检查原神/星铁/绝区零/崩坏3体力，达到阈值后推送一次',
        component: 'Switch',
      },
      {
        field: 'stamina_push_interval',
        label: '体力检查间隔（分钟）',
        helpMessage: '插件每分钟轮询一次，按这里的间隔实际请求；建议 5 分钟以上',
        component: 'InputNumber',
        componentProps: { min: 1, max: 60, step: 1 },
      },
      {
        field: 'stamina_push_at_user',
        label: '体力推送艾特用户',
        helpMessage: '推送某位群成员的体力时，是否在消息开头艾特该成员',
        component: 'Switch',
      },
      {
        field: 'stamina_push_gs_threshold',
        label: '原神体力推送阈值',
        helpMessage: '原粹树脂达到该数值后推送；默认 200',
        component: 'InputNumber',
        componentProps: { min: 1, max: 300, step: 1 },
      },
      {
        field: 'stamina_push_sr_threshold',
        label: '星铁体力推送阈值',
        helpMessage: '开拓力达到该数值后推送；默认 240',
        component: 'InputNumber',
        componentProps: { min: 1, max: 500, step: 1 },
      },
      {
        field: 'stamina_push_zzz_threshold',
        label: '绝区零体力推送阈值',
        helpMessage: '电量达到该数值后推送；默认 240',
        component: 'InputNumber',
        componentProps: { min: 1, max: 500, step: 1 },
      },
      {
        field: 'stamina_push_bh3_threshold',
        label: '崩坏3体力推送阈值',
        helpMessage: '体力达到该数值后推送；默认 240',
        component: 'InputNumber',
        componentProps: { min: 1, max: 500, step: 1 },
      },
      {
        field: 'bh3_remind_enable',
        label: '崩三周期提醒',
        helpMessage: '深渊/战场/乐土开始和结算提醒',
        component: 'Switch',
      },
      {
        field: 'bh3_remind_groups',
        label: '崩三提醒群',
        helpMessage: '直接选择提醒群，也可群内发送 #小花火开启崩三提醒',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'bh3_remind_at_mode',
        label: '崩三提醒艾特',
        helpMessage: '控制深渊/战场/乐土提醒是否艾特全体或指定成员',
        component: 'Select',
        componentProps: {
          options: [
            { label: '不艾特', value: 'none' },
            { label: '艾特全体', value: 'all' },
            { label: '艾特指定QQ', value: 'users' },
          ],
        },
      },
      {
        field: 'bh3_remind_at_users',
        label: '崩三提醒指定QQ',
        helpMessage: '艾特指定QQ时生效，多个QQ用英文逗号/换行分隔',
        component: 'InputTextArea',
      },
      {
        field: 'bh3_remind_image',
        label: '崩三提醒附图',
        helpMessage: '支持网络图片URL或本地图片路径，留空则不发送图片',
        component: 'InputTextArea',
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '活动到期提醒',
      },
      {
        field: 'activity_remind_enable',
        label: '活动到期提醒总开关',
        helpMessage: '原神/星铁/绝区零/崩三活动到期推送',
        component: 'Switch',
      },
      {
        field: 'activity_remind_hours_before',
        label: '提前提醒小时数',
        helpMessage: '默认24；活动结束前多少小时内推送一次',
        component: 'InputNumber',
        componentProps: { min: 1, max: 168, step: 1 },
      },
      {
        field: 'activity_remind_push_image',
        label: '推送公告图片',
        component: 'Switch',
      },
      {
        field: 'activity_remind_at_mode',
        label: '活动提醒艾特',
        component: 'Select',
        componentProps: {
          options: [
            { label: '不艾特', value: 'none' },
            { label: '艾特全体', value: 'all' },
            { label: '艾特指定QQ', value: 'users' },
          ],
        },
      },
      {
        field: 'activity_remind_at_users',
        label: '活动提醒指定QQ',
        helpMessage: '艾特指定QQ时生效，多个QQ用英文逗号/换行分隔',
        component: 'InputTextArea',
      },
      {
        field: 'activity_remind_ban_words',
        label: '活动提醒屏蔽关键词',
        helpMessage: '正则写法，使用 | 分隔；标题包含则不推送',
        component: 'InputTextArea',
      },
      {
        field: 'activity_remind_gs_groups',
        label: '原神活动到期提醒群',
        helpMessage: '直接选择提醒群，留空则不推送；也可群内发送 #原神开启活动到期推送',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'activity_remind_sr_groups',
        label: '星铁活动到期提醒群',
        helpMessage: '直接选择提醒群，留空则不推送；也可群内发送 #星铁开启活动到期推送',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'activity_remind_zzz_groups',
        label: '绝区零活动到期提醒群',
        helpMessage: '直接选择提醒群，留空则不推送；也可群内发送 #绝区零开启活动到期推送',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        field: 'activity_remind_bh3_groups',
        label: '崩三活动到期提醒群',
        helpMessage: '直接选择提醒群，留空则不推送；也可群内发送 #崩三开启活动到期推送',
        component: 'Select',
        componentProps: {
          mode: 'multiple',
          allowAdd: true,
          allowDel: true,
          options: groupList,
        },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '攻略源',
      },
      {
        field: 'mys_global_guide_search',
        label: '攻略全站搜索兜底',
        helpMessage: '开启后攻略源作者搜不到时，会使用米游社全站搜索关键词兜底（类似 genshin 的 #米游社搜索）',
        component: 'Switch',
      },
      {
        field: 'bh3_guide_abyss_sources',
        label: '深渊攻略源',
        helpMessage: '每行：关键词|米游社UID|图片序号|作者名；如 红莲|11956740|0,1,3|残月',
        component: 'InputTextArea',
      },
      {
        field: 'bh3_guide_battlefield_sources',
        label: '战场攻略源',
        helpMessage: '每行：关键词|米游社UID|图片序号|作者名；按顺序搜索，搜不到会回退通用源',
        component: 'InputTextArea',
      },
      {
        field: 'bh3_guide_godwar_sources',
        label: '乐土攻略源',
        helpMessage: '每行：关键词|米游社UID|图片序号|作者名；支持定向搜索角色/装甲名',
        component: 'InputTextArea',
      },
      {
        field: 'zzz_guide_defense_sources',
        label: '防卫战攻略源',
        helpMessage: '每行：关键词|米游社UID|图片序号|作者名；如 式舆防卫战|4068738|0,1,2|洗礼酱',
        component: 'InputTextArea',
      },
      {
        field: 'zzz_guide_deadly_sources',
        label: '危局强袭战攻略源',
        helpMessage: '每行：关键词|米游社UID|图片序号|作者名；危局会优先识别当前Boss',
        component: 'InputTextArea',
      },
      {
        field: 'custom_guide_enable',
        label: '自定义攻略源开关',
        helpMessage: '开启后可用 #角色名攻略 触发（也支持 xhh/小花火 前缀）；角色名即关键词，自动用别名表归一成正式名，无需手填角色列表',
        component: 'Switch',
      },
      {
        field: 'custom_guide_forward',
        label: '合并转发模式',
        helpMessage: '开启=合并转发发送（带标题）；关闭=逐条拼接消息发送（不带标题文字，直接发 作者/标题/发布时间/原帖+图片）',
        component: 'Select',
        componentProps: {
          options: [
            { label: '开启合并转发', value: 'on' },
            { label: '关闭合并转发(拼接消息)', value: 'off' },
          ],
        },
      },
      {
        field: 'custom_guide_uid',
        label: '全局兜底源(作者UID)',
        helpMessage: '仅当对应游戏没填下面的默认源、或角色不在别名表时才用它；代码内置默认 74019947',
        component: 'Input',
      },
      {
        field: 'custom_guide_gs_uid',
        label: '原神默认源(作者UID)',
        helpMessage: '原神角色的默认攻略作者；发 #原神角色名攻略 时自动以角色正式名搜索该UID',
        component: 'Input',
      },
      {
        field: 'custom_guide_gs_index',
        label: '原神默认图片序号',
        helpMessage: '留空取该帖全部图片；填序号取指定张，如 0(第一张) 或 0,2,3（从0开始，英文逗号分隔）',
        component: 'Input',
      },
      {
        field: 'custom_guide_sr_uid',
        label: '星铁默认源(作者UID)',
        helpMessage: '星铁角色的默认攻略作者；发 #星铁角色名攻略 时自动以角色正式名搜索该UID',
        component: 'Input',
      },
      {
        field: 'custom_guide_sr_index',
        label: '星铁默认图片序号',
        helpMessage: '留空取该帖全部图片；填序号取指定张，如 0(第一张) 或 0,2（英文逗号分隔）',
        component: 'Input',
      },
      {
        field: 'custom_guide_zzz_uid',
        label: '绝区零默认源(作者UID)',
        helpMessage: '绝区零角色的默认攻略作者；发 #绝区零角色名攻略 时自动以角色正式名搜索该UID',
        component: 'Input',
      },
      {
        field: 'custom_guide_zzz_index',
        label: '绝区零默认图片序号',
        helpMessage: '留空取该帖全部图片；填序号取指定张，如 0(第一张) 或 0,2（英文逗号分隔）',
        component: 'Input',
      },
      {
        field: 'custom_guide_priority',
        label: '自定义攻略源优先级',
        helpMessage: '默认 -9999999999（极高优先级，确保优先于其它攻略插件抢到指令）；数字越小越优先，修改后需重启',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'abyss_report_repos',
        label: '深渊速报图片仓库',
        helpMessage: '每行一个raw仓库地址；用于原神深渊/剧诗/幽境与星铁混沌/虚构/末日图片',
        component: 'InputTextArea',
      },
      {
        field: 'abyss_report_gs_version',
        label: '原神默认速报版本',
        helpMessage: '留空自动读取Nanoka live版本，如 6.7',
        component: 'Input',
      },
      {
        field: 'abyss_report_sr_version',
        label: '星铁默认速报版本',
        helpMessage: '留空自动读取Nanoka live版本，如 4.3',
        component: 'Input',
      },
      {
        field: 'abyss_report_sr_fiction_levels',
        label: '星铁虚构叙事关卡筛选',
        helpMessage: '留空显示全部；用数字1-5指定要显示的关卡序号，如 3,4 只显示其三、其四',
        component: 'Input',
      },
      {
        field: 'abyss_report_sr_maze_levels',
        label: '星铁混沌回忆难度筛选',
        helpMessage: '留空显示全部；用数字1-12指定要显示的难度，如 11,12 只显示第十一、十二层',
        component: 'Input',
      },
      {
        field: 'abyss_report_sr_doom_levels',
        label: '星铁末日幻影难度筛选',
        helpMessage: '留空显示全部；用数字1-5指定要显示的难度，如 3,4 只显示难度三、四',
        component: 'Input',
      },
      {
        field: 'abyss_report_zzz_shiyu_stages',
        label: '绝区零式舆防卫战关卡筛选',
        helpMessage: '留空显示全部；按 stage_num 筛选，如 4,5 只显示第四防线和节点5',
        component: 'Input',
      },
      {
        field: 'abyss_report_sr_invasion',
        label: '星铁深渊星启模式',
        helpMessage: '显示混沌回忆/虚构叙事/末日幻影最高难度的星启模式（污染入侵）区块',
        component: 'Switch',
      },
      {
        field: 'abyss_report_zzz_shiyu_periods',
        label: '式舆防卫战返回期数',
        helpMessage: '默认"末期"只显示当前期（每版本最后一期）；选"全部期"会返回该版本全部期（如 3.1 的 3 期），多期时自动逐条发送',
        component: 'Select',
        componentProps: {
          options: [
            { label: '末期（默认）', value: 'last' },
            { label: '全部期', value: 'all' },
          ],
        },
      },
      {
        field: 'abyss_report_zzz_deadly_periods',
        label: '危局强袭战返回期数',
        helpMessage: '默认"末期"只显示当前期（每版本最后一期）；选"全部期"会返回该版本全部期（如 3.1 的 3 期），多期时自动逐条发送',
        component: 'Select',
        componentProps: {
          options: [
            { label: '末期（默认）', value: 'last' },
            { label: '全部期', value: 'all' },
          ],
        },
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '插件优先级',
      },
      {
        field: 'tl_priority',
        label: '体力小组件(TL)',
        helpMessage: '默认 -99',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'sign_priority',
        label: '签到(sign)',
        helpMessage: '默认 -26',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'user_priority',
        label: '扫码绑定(user)',
        helpMessage: '默认 -9999999999',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'wiki_priority',
        label: '图鉴(wiki)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_remind_priority',
        label: '崩三提醒(bh3_remind)',
        helpMessage: '默认 -1000001（提醒拦截）',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'activity_remind_priority',
        label: '活动到期提醒(activity_remind)',
        helpMessage: '默认 -1000002，建议低于genshin以优先抢到活动到期指令',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_note_priority',
        label: '崩三体力(bh3_note)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_abyss_priority',
        label: '崩三深渊(bh3_abyss)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_battlefield_priority',
        label: '崩三战场(bh3_battlefield)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_godwar_priority',
        label: '崩三乐土(bh3_godwar)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_profile_priority',
        label: '崩三主页(bh3_profile)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_all_note_priority',
        label: '四体力聚合(bh3_all_note)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_gacha_priority',
        label: '崩三抽卡(bh3_gacha)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'bh3_ledger_priority',
        label: '崩三水晶(bh3_ledger)',
        helpMessage: '默认 100',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      {
        field: 'abyss_report_priority',
        label: '原神/星铁深渊速报(abyss_report)',
        helpMessage: '默认 100，修改后需重启',
        component: 'InputNumber',
        componentProps: { min: -9999999999, max: 9999999999, step: 1 },
      },
      priorityInput('bilibili_priority', 'B站解析卡片(bilibili)', -120),
      priorityInput('bilibili_push_priority', 'B站推送(bilibili_push)', -119),
      priorityInput('bili_live_priority', 'B站直播解析(bili_live)', -115),
      priorityInput('gacha_pool_priority', '全游戏当前卡池(gacha_pool)', -1000000000),
      priorityInput('gs_logs_priority', '原神历史卡池(gs_logs)', -99),
      priorityInput('sr_logs_priority', '星铁历史卡池(sr_logs)', -88),
      priorityInput('mhy_estimate_priority', '预估/攻略搜索(mhy_estimate)', -9999999999),
      priorityInput('video_priority', '米哈游最新视频(video)', 1),
      priorityInput('voice_priority', '角色语音(voice)', 15),
      priorityInput('update_priority', '插件更新(update)', 10),
      priorityInput('config_priority', '插件配置(config)', 15),
      priorityInput('tlp_priority', '塔罗牌(tlp)', 15),
      priorityInput('help_priority', '帮助菜单(help)', 100),
      priorityInput('picture_priority', '图片处理(picture)', 1234),
      priorityInput('npc_wt_priority', 'NPC委托成就(npc_wt)', 1234),
      priorityInput('huobi_priority', '货币战争(huobi)', 123),
      priorityInput('role_combat_priority', '剧诗可用角色(role_combat)', 100),
      priorityInput('zzz_md_priority', '绝区零母带(zzz_md)', 100),
      priorityInput('currency_balance_priority', '货币统计(currency_balance)', 100),
      {
        component: 'SOFT_GROUP_BEGIN',
        label: 'Meme表情包',
      },
      priorityInput('meme_priority', 'Meme表情(meme)', 50),
      {
        field: 'meme',
        label: 'Meme表情包总开关',
        helpMessage: '开启后可制作/查询 meme 表情包',
        component: 'Switch',
      },
      {
        field: 'meme_baseUrl',
        label: 'Meme服务地址',
        helpMessage: 'yunzai-meme 服务地址，一般无需修改',
        component: 'Input',
      },
      {
        field: 'meme_reply',
        label: '制作时引用回复',
        helpMessage: '发送制作结果时是否引用原消息',
        component: 'Switch',
      },
      {
        field: 'meme_forceSharp',
        label: '必须带#前缀',
        helpMessage: '开启后不带 # 前缀不触发 meme 制作',
        component: 'Switch',
      },
      {
        field: 'meme_CD',
        label: '制作冷却CD',
        helpMessage: '单位：秒，0 表示无冷却',
        component: 'InputNumber',
        componentProps: { min: 0, max: 3600, step: 1 },
      },
      {
        field: 'meme_maxFileSize',
        label: '图片大小限制',
        helpMessage: '制作时单张图片最大 MB 数',
        component: 'InputNumber',
        componentProps: { min: 1, max: 100, step: 1 },
      },
      {
        field: 'meme_masterProtectDo',
        label: '主人保护',
        helpMessage: '制作对象是主人时改用发送者本人头像',
        component: 'Switch',
      },
      {
        component: 'SOFT_GROUP_BEGIN',
        label: '其他',
      },
      {
        field: 'wt',
        label: '查委托必须带#前缀',
        component: 'Switch',
      },
      {
        field: 'Tl',
        label: '启用小花火体力组件',
        helpMessage: '开启后由小花火处理体力指令；#体力/小花火体力等为四游戏总览，#原神体力等为单游戏查询',
        component: 'Switch',
      },
      {
        field: 'hbxx',
        label: '修复合并消息报错',
        helpMessage: '解决某些适配器的合并消息内嵌报错',
        component: 'Switch',
      },
      {
        field: 'debug',
        label: '调试模式',
        helpMessage: '输出水晶查询/扫码绑定的详细日志',
        component: 'Switch',
      },
    ],
    getConfigData() {
      const cfg = getCfg()
      const other = getOther()
      const sign = getSign()
      const bh3Remind = getBh3Remind()
      const activityRemind = getActivityRemind()
      const activityGroups = activityRemind.groups || {}
      return {
        update: !!cfg.update,
        img_quality: cfg.img_quality ?? 80,
        wiki: !!cfg.wiki,
        bdsb: !!cfg.bdsb,
        tlp: !!cfg.tlp,
        tlpcs: cfg.tlpcs ?? 3,
        gs_logs: !!cfg.gs_logs,
        sr_logs: !!cfg.sr_logs,
        zzz_logs: !!cfg.zzz_logs,
        bh3_logs: !!cfg.bh3_logs,
        all_voice: !!cfg.all_voice,
        gs_voice: cfg.gs_voice !== false,
        sr_voice: cfg.sr_voice !== false,
        zzz_voice: cfg.zzz_voice !== false,
        bh3_voice: cfg.bh3_voice !== false,
        huobi_num: cfg.huobi_num ?? 2,
        sign: !!cfg.sign,
        zd_sign: sign.zd_sign ?? 0,
        sign_hour: sign.sign_hour ?? 0,
        sign_minute: sign.sign_minute ?? 0,
        bbs_zd_sign: sign.bbs_zd_sign ?? 0,
        bbs_sign_hour: sign.bbs_sign_hour ?? 3,
        bbs_sign_minute: sign.bbs_sign_minute ?? 30,
        sbai: !!sign.sbai,
        sign_group: (sign.sign_group || []).map(String),
        bbs_sign_group: (sign.bbs_sign_group || []).map(String),
        sign_users: formatSignUsers(sign.sign || {}),
        bbs_sign_users: formatSignUsers(sign.bbs_sign || {}),
        bh3_remind_groups: parseMultiList(bh3Remind.groups),
        bh3_all_note_groups: parseMultiList(bh3Remind.all_note_groups),
        groups: parseMultiList(cfg.groups),
        forwardMsg: other.forwardMsg !== false,
        bh3: !!other.bh3,
        by: !!other.by,
        xbgd: !!other.xbgd,
        cover: !!other.cover,
        group_config: formatGroupConfig(other.group_config),
        sm: !!cfg.sm,
        sm_cd: cfg.sm_cd ?? 60,
        bilibili: !!cfg.bilibili,
        list_num: cfg.list_num ?? 12,
        qn: cfg.qn ?? 3,
        dow_size: cfg.dow_size ?? 0,
        b_lj: !!cfg.b_lj,
        b_cd: !!cfg.b_cd,
        b_img_num: cfg.b_img_num ?? 0,
        bili_live: cfg.bili_live !== false,
        bili_live_only_live: !!cfg.bili_live_only_live,
        bili_live_cd: cfg.bili_live_cd ?? 60,
        bili_live_video: cfg.bili_live_video !== false,
        bili_live_video_auto: !!cfg.bili_live_video_auto,
        bili_live_video_time: cfg.bili_live_video_time ?? 60,
        bili_live_video_size: cfg.bili_live_video_size ?? 99,
        bili_live_qn: cfg.bili_live_qn ?? 250,
        bili_live_dm: cfg.bili_live_dm !== false,
        bili_live_dm_perm: cfg.bili_live_dm_perm || 'admin',
        bili_live_dm_cd: cfg.bili_live_dm_cd ?? 5,
        emoji: !!cfg.emoji,
        wt: !!cfg.wt,
        Tl: !!cfg.Tl,
        hbxx: !!cfg.hbxx,
        debug: !!cfg.debug,
        gacha_art_source: cfg.gacha_art_source || 'custom',
        gacha_header_art_source: cfg.gacha_header_art_source || cfg.gacha_art_source || 'custom',
        gacha_up_icon_source: cfg.gacha_up_icon_source || cfg.gacha_art_source || 'custom',
        tl_priority: cfg.tl_priority ?? -99,
        sign_priority: cfg.sign_priority ?? -26,
        user_priority: cfg.user_priority ?? -9999999999,
        wiki_priority: other.wiki ?? 100,
        bh3_remind_priority: cfg.bh3_remind_priority ?? -1000001,
        activity_remind_priority: cfg.activity_remind_priority ?? -1000002,
        bh3_note_priority: cfg.bh3_note_priority ?? 100,
        bh3_abyss_priority: cfg.bh3_abyss_priority ?? 100,
        bh3_battlefield_priority: cfg.bh3_battlefield_priority ?? 100,
        bh3_godwar_priority: cfg.bh3_godwar_priority ?? 100,
        bh3_profile_priority: cfg.bh3_profile_priority ?? 100,
        bh3_all_note_priority: cfg.bh3_all_note_priority ?? 100,
        bh3_gacha_priority: cfg.bh3_gacha_priority ?? 100,
        bh3_ledger_priority: cfg.bh3_ledger_priority ?? 100,
        bilibili_priority: cfg.bilibili_priority ?? -120,
        bilibili_push_priority: cfg.bilibili_push_priority ?? -119,
        bili_live_priority: cfg.bili_live_priority ?? -115,
        gacha_pool_priority: cfg.gacha_pool_priority ?? -1000000000,
        gs_logs_priority: cfg.gs_logs_priority ?? -99,
        sr_logs_priority: cfg.sr_logs_priority ?? -88,
        mhy_estimate_priority: Number.isFinite(Number(cfg.mhy_estimate_priority)) ? Number(cfg.mhy_estimate_priority) : -9999999999,
        video_priority: cfg.video_priority ?? 1,
        voice_priority: cfg.voice_priority ?? 15,
        update_priority: cfg.update_priority ?? 10,
        config_priority: cfg.config_priority ?? 15,
        tlp_priority: cfg.tlp_priority ?? 15,
        help_priority: cfg.help_priority ?? 100,
        picture_priority: cfg.picture_priority ?? 1234,
        npc_wt_priority: cfg.npc_wt_priority ?? 1234,
        huobi_priority: cfg.huobi_priority ?? 123,
        role_combat_priority: cfg.role_combat_priority ?? 100,
        zzz_md_priority: cfg.zzz_md_priority ?? 100,
        currency_balance_priority: cfg.currency_balance_priority ?? 100,
        bh3_remind_enable: !!bh3Remind.enable,
        bh3_all_note_enable: !!cfg.bh3_all_note_enable,
        bh3_all_note_groups: (bh3Remind.all_note_groups || []).map(String),
        stamina_push_enable: !!bh3Remind.stamina_push_enable,
        stamina_push_interval: Number(bh3Remind.stamina_push_interval || 5),
        stamina_push_at_user: !!bh3Remind.stamina_push_at_user,
        stamina_push_gs_threshold: Number(bh3Remind.stamina_push_gs_threshold || 200),
        stamina_push_sr_threshold: Number(bh3Remind.stamina_push_sr_threshold || 240),
        stamina_push_zzz_threshold: Number(bh3Remind.stamina_push_zzz_threshold || 240),
        stamina_push_bh3_threshold: Number(bh3Remind.stamina_push_bh3_threshold || 240),
        bh3_remind_groups: parseMultiList(bh3Remind.groups),
        bh3_remind_at_mode: bh3Remind.at_mode || 'none',
        bh3_remind_at_users: (bh3Remind.at_users || []).join(','),
        bh3_remind_image: bh3Remind.image || '',
        activity_remind_enable: !!activityRemind.enable,
        activity_remind_hours_before: activityRemind.hours_before ?? 24,
        activity_remind_push_image: activityRemind.push_image !== false,
        activity_remind_at_mode: activityRemind.at_mode || 'none',
        activity_remind_at_users: (activityRemind.at_users || []).join(','),
        activity_remind_ban_words: activityRemind.ban_words || '',
        activity_remind_gs_groups: parseMultiList(activityGroups.gs),
        activity_remind_sr_groups: parseMultiList(activityGroups.sr),
        activity_remind_zzz_groups: parseMultiList(activityGroups.zzz),
        activity_remind_bh3_groups: parseMultiList(activityGroups.bh3),
        mys_global_guide_search: cfg.mys_global_guide_search !== false,
        bh3_guide_abyss_sources: cfg.bh3_guide_abyss_sources || defaultBh3GuideSources.abyss,
        bh3_guide_battlefield_sources: cfg.bh3_guide_battlefield_sources || defaultBh3GuideSources.battlefield,
        bh3_guide_godwar_sources: cfg.bh3_guide_godwar_sources || defaultBh3GuideSources.godwar,
        zzz_guide_defense_sources: cfg.zzz_guide_defense_sources || defaultBh3GuideSources.zzzDefense,
        zzz_guide_deadly_sources: cfg.zzz_guide_deadly_sources || defaultBh3GuideSources.zzzDeadly,
        custom_guide_enable: cfg.custom_guide_enable !== false,
        custom_guide_forward: cfg.custom_guide_forward || 'on',
        custom_guide_uid: cfg.custom_guide_uid || '74019947',
        custom_guide_gs_uid: cfg.custom_guide_gs_uid || '',
        custom_guide_gs_index: cfg.custom_guide_gs_index || '',
        custom_guide_sr_uid: cfg.custom_guide_sr_uid || '',
        custom_guide_sr_index: cfg.custom_guide_sr_index || '',
        custom_guide_zzz_uid: cfg.custom_guide_zzz_uid || '',
        custom_guide_zzz_index: cfg.custom_guide_zzz_index || '',
        custom_guide_priority: cfg.custom_guide_priority ?? -9999999999,
        abyss_report_repos: cfg.abyss_report_repos || 'https://cnb.cool/JIUXJIU/Abyss/-/git/raw/main\nhttps://cnb.cool/JIUXJIU/AbyssBeta/-/git/raw/main',
        abyss_report_gs_version: cfg.abyss_report_gs_version || '',
        abyss_report_sr_version: cfg.abyss_report_sr_version || '',
        abyss_report_sr_fiction_levels: cfg.abyss_report_sr_fiction_levels || '3,4',
        abyss_report_sr_maze_levels: cfg.abyss_report_sr_maze_levels || '11,12',
        abyss_report_sr_doom_levels: cfg.abyss_report_sr_doom_levels || '3,4',
        abyss_report_zzz_shiyu_stages: cfg.abyss_report_zzz_shiyu_stages || '4,5',
        abyss_report_sr_invasion: cfg.abyss_report_sr_invasion !== false,
        abyss_report_zzz_shiyu_periods: cfg.abyss_report_zzz_shiyu_periods || 'last',
        abyss_report_zzz_deadly_periods: cfg.abyss_report_zzz_deadly_periods || 'last',
        abyss_report_priority: cfg.abyss_report_priority ?? 100,
        meme: cfg.meme !== false,
        meme_baseUrl: cfg.meme_baseUrl || 'http://113.31.103.19:50835',
        meme_reply: cfg.meme_reply !== false,
        meme_forceSharp: cfg.meme_forceSharp !== false,
        meme_CD: cfg.meme_CD ?? 0,
        meme_maxFileSize: cfg.meme_maxFileSize ?? 10,
        meme_masterProtectDo: cfg.meme_masterProtectDo !== false,
        meme_priority: cfg.meme_priority ?? 50,
      }
    },
    setConfigData(data, { Result }) {
      const boolMap = {
        update: data.update,
        wiki: data.wiki,
        bdsb: data.bdsb,
        tlp: data.tlp,
        gs_logs: data.gs_logs,
        sr_logs: data.sr_logs,
        zzz_logs: data.zzz_logs,
        bh3_logs: data.bh3_logs,
        all_voice: data.all_voice,
        gs_voice: data.gs_voice,
        sr_voice: data.sr_voice,
        zzz_voice: data.zzz_voice,
        bh3_voice: data.bh3_voice,
        sign: data.sign,
        sm: data.sm,
        bilibili: data.bilibili,
        b_lj: data.b_lj,
        b_cd: data.b_cd,
        bili_live: data.bili_live,
        bili_live_only_live: data.bili_live_only_live,
        bili_live_video: data.bili_live_video,
        bili_live_video_auto: data.bili_live_video_auto,
        bili_live_dm: data.bili_live_dm,
        emoji: data.emoji,
        wt: data.wt,
        Tl: data.Tl,
        hbxx: data.hbxx,
        debug: data.debug,
        bh3_all_note_enable: data.bh3_all_note_enable,
        forwardMsg: data.forwardMsg,
        bh3: data.bh3,
        by: data.by,
        xbgd: data.xbgd,
        cover: data.cover,
        meme: data.meme,
        meme_reply: data.meme_reply,
        meme_forceSharp: data.meme_forceSharp,
        meme_masterProtectDo: data.meme_masterProtectDo,
        abyss_report_sr_invasion: data.abyss_report_sr_invasion,
      }
      for (const [k, v] of Object.entries(boolMap)) {
        const target = ['forwardMsg', 'bh3', 'by', 'xbgd', 'cover'].includes(k) ? 'other.yaml' : 'config.yaml'
        yaml.set(_path + target, k, !!v)
      }

      const numMap = {
        img_quality: data.img_quality,
        tlpcs: data.tlpcs,
        huobi_num: data.huobi_num,
        sm_cd: data.sm_cd,
        list_num: data.list_num,
        qn: data.qn,
        dow_size: data.dow_size,
        b_img_num: data.b_img_num,
        meme_CD: data.meme_CD,
        meme_maxFileSize: data.meme_maxFileSize,
        bili_live_cd: data.bili_live_cd,
        bili_live_video_time: data.bili_live_video_time,
        bili_live_video_size: data.bili_live_video_size,
        bili_live_qn: data.bili_live_qn,
        bili_live_dm_perm: data.bili_live_dm_perm,
        bili_live_dm_cd: data.bili_live_dm_cd,
      }
      for (const [k, v] of Object.entries(numMap)) {
        if (v != null) yaml.set(_path + 'config.yaml', k, Number(v))
      }

      if (data.gacha_art_source) yaml.set(_path + 'config.yaml', 'gacha_art_source', data.gacha_art_source === 'official' ? 'official' : 'custom')
      if (data.gacha_header_art_source) yaml.set(_path + 'config.yaml', 'gacha_header_art_source', data.gacha_header_art_source === 'official' ? 'official' : 'custom')
      if (data.gacha_up_icon_source) yaml.set(_path + 'config.yaml', 'gacha_up_icon_source', data.gacha_up_icon_source === 'official' ? 'official' : 'custom')
      const memeBaseUrl = String(data.meme_baseUrl || '').trim()
      if (memeBaseUrl) yaml.set(_path + 'config.yaml', 'meme_baseUrl', memeBaseUrl)

      yaml.set(_path + 'sign.yaml', 'zd_sign', Number(data.zd_sign) ?? 0)
      const signHour = Number.isFinite(Number(data.sign_hour))
        ? Math.max(0, Math.min(23, Math.trunc(Number(data.sign_hour))))
        : 0
      const signMinute = Number.isFinite(Number(data.sign_minute))
        ? Math.max(0, Math.min(59, Math.trunc(Number(data.sign_minute))))
        : 0
      yaml.set(_path + 'sign.yaml', 'sign_hour', signHour)
      yaml.set(_path + 'sign.yaml', 'sign_minute', signMinute)
      yaml.set(_path + 'sign.yaml', 'bbs_zd_sign', Number(data.bbs_zd_sign) ? 1 : 0)
      const bbsSignHour = Number.isFinite(Number(data.bbs_sign_hour))
        ? Math.max(0, Math.min(23, Math.trunc(Number(data.bbs_sign_hour))))
        : 3
      const bbsSignMinute = Number.isFinite(Number(data.bbs_sign_minute))
        ? Math.max(0, Math.min(59, Math.trunc(Number(data.bbs_sign_minute))))
        : 30
      yaml.set(_path + 'sign.yaml', 'bbs_sign_hour', bbsSignHour)
      yaml.set(_path + 'sign.yaml', 'bbs_sign_minute', bbsSignMinute)
      yaml.set(_path + 'sign.yaml', 'sbai', !!data.sbai)
      const signGroups = parseMultiList(data.sign_group)
      yaml.set(_path + 'sign.yaml', 'sign_group', signGroups)
      const bbsSignGroups = parseMultiList(data.bbs_sign_group)
      yaml.set(_path + 'sign.yaml', 'bbs_sign_group', bbsSignGroups)
      yaml.set(_path + 'sign.yaml', 'sign', parseSignUsers(data.sign_users))
      yaml.set(_path + 'sign.yaml', 'bbs_sign', parseSignUsers(data.bbs_sign_users))
      const broadcastGroups = parseMultiList(data.groups)
        .map(v => Number(v))
        .filter(v => Number.isSafeInteger(v) && v > 0)
      yaml.set(_path + 'config.yaml', 'groups', broadcastGroups)
      yaml.set(_path + 'other.yaml', 'group_config', parseGroupConfig(data.group_config))

      const currentBh3Remind = getBh3Remind()
      const valueOrCurrent = (key, fallback) => data[key] !== undefined ? data[key] : (currentBh3Remind[key] ?? fallback)
      const toBool = (value, fallback = false) => {
        if (value === undefined || value === null || value === '') return fallback
        if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase())
        return !!value
      }
      yaml.set(_path + 'bh3_remind.yaml', 'enable', toBool(valueOrCurrent('bh3_remind_enable', false)))
      const currentCfg = getCfg()
      yaml.set(_path + 'config.yaml', 'bh3_all_note_enable', data.bh3_all_note_enable !== undefined
        ? !!data.bh3_all_note_enable
        : !!currentCfg.bh3_all_note_enable)
      const groups = parseMultiList(valueOrCurrent('bh3_remind_groups', currentBh3Remind.groups || []))
      yaml.set(_path + 'bh3_remind.yaml', 'groups', groups)
      const allNoteGroups = parseMultiList(valueOrCurrent('bh3_all_note_groups', currentBh3Remind.all_note_groups || []))
      yaml.set(_path + 'bh3_remind.yaml', 'all_note_groups', allNoteGroups)
      const pushEnable = toBool(valueOrCurrent('stamina_push_enable', false))
      const pushInterval = Number(valueOrCurrent('stamina_push_interval', 5))
      const pushAtUser = toBool(valueOrCurrent('stamina_push_at_user', false))
      const numberSetting = (key, fallback, max = 9999) => {
        const value = Number(valueOrCurrent(key, fallback))
        return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.trunc(value))) : fallback
      }
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_enable', pushEnable)
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_interval', Number.isFinite(pushInterval) ? Math.max(1, Math.min(60, Math.trunc(pushInterval))) : 5)
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_at_user', pushAtUser)
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_gs_threshold', numberSetting('stamina_push_gs_threshold', 200, 300))
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_sr_threshold', numberSetting('stamina_push_sr_threshold', 240, 500))
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_zzz_threshold', numberSetting('stamina_push_zzz_threshold', 240, 500))
      yaml.set(_path + 'bh3_remind.yaml', 'stamina_push_bh3_threshold', numberSetting('stamina_push_bh3_threshold', 240, 500))
      const atMode = valueOrCurrent('bh3_remind_at_mode', 'none')
      yaml.set(_path + 'bh3_remind.yaml', 'at_mode', ['all', 'users', 'none'].includes(atMode) ? atMode : 'none')
      const remindAtUsers = String(valueOrCurrent('bh3_remind_at_users', currentBh3Remind.at_users || '') || '').split(/[,，\s]+/).map(v => v.trim()).filter(Boolean)
      yaml.set(_path + 'bh3_remind.yaml', 'at_users', remindAtUsers)
      yaml.set(_path + 'bh3_remind.yaml', 'image', String(valueOrCurrent('bh3_remind_image', currentBh3Remind.image || '') || '').trim())

      yaml.set(_path + 'activity_remind.yaml', 'enable', !!data.activity_remind_enable)
      yaml.set(_path + 'activity_remind.yaml', 'hours_before', Number(data.activity_remind_hours_before || 24))
      yaml.set(_path + 'activity_remind.yaml', 'push_image', data.activity_remind_push_image !== false)
      yaml.set(_path + 'activity_remind.yaml', 'at_mode', ['all', 'users', 'none'].includes(data.activity_remind_at_mode) ? data.activity_remind_at_mode : 'none')
      const activityAtUsers = String(data.activity_remind_at_users || '').split(/[,，\s]+/).map(v => v.trim()).filter(Boolean)
      yaml.set(_path + 'activity_remind.yaml', 'at_users', activityAtUsers)
      yaml.set(_path + 'activity_remind.yaml', 'ban_words', String(data.activity_remind_ban_words || '').trim())
      yaml.set(_path + 'activity_remind.yaml', 'groups', {
        gs: parseMultiList(data.activity_remind_gs_groups),
        sr: parseMultiList(data.activity_remind_sr_groups),
        zzz: parseMultiList(data.activity_remind_zzz_groups),
        bh3: parseMultiList(data.activity_remind_bh3_groups),
      })
      yaml.set(_path + 'config.yaml', 'bh3_guide_abyss_sources', String(data.bh3_guide_abyss_sources || '').trim())
      yaml.set(_path + 'config.yaml', 'mys_global_guide_search', data.mys_global_guide_search !== false)
      yaml.set(_path + 'config.yaml', 'bh3_guide_battlefield_sources', String(data.bh3_guide_battlefield_sources || '').trim())
      yaml.set(_path + 'config.yaml', 'bh3_guide_godwar_sources', String(data.bh3_guide_godwar_sources || '').trim())
      yaml.set(_path + 'config.yaml', 'zzz_guide_defense_sources', String(data.zzz_guide_defense_sources || '').trim())
      yaml.set(_path + 'config.yaml', 'zzz_guide_deadly_sources', String(data.zzz_guide_deadly_sources || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_enable', !!data.custom_guide_enable)
      yaml.set(_path + 'config.yaml', 'custom_guide_forward', data.custom_guide_forward === 'off' ? 'off' : 'on')
      yaml.set(_path + 'config.yaml', 'custom_guide_uid', String(data.custom_guide_uid || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_gs_uid', String(data.custom_guide_gs_uid || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_gs_index', String(data.custom_guide_gs_index || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_sr_uid', String(data.custom_guide_sr_uid || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_sr_index', String(data.custom_guide_sr_index || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_zzz_uid', String(data.custom_guide_zzz_uid || '').trim())
      yaml.set(_path + 'config.yaml', 'custom_guide_zzz_index', String(data.custom_guide_zzz_index || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_repos', String(data.abyss_report_repos || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_gs_version', String(data.abyss_report_gs_version || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_sr_version', String(data.abyss_report_sr_version || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_sr_fiction_levels', String(data.abyss_report_sr_fiction_levels || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_sr_maze_levels', String(data.abyss_report_sr_maze_levels || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_sr_doom_levels', String(data.abyss_report_sr_doom_levels || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_zzz_shiyu_stages', String(data.abyss_report_zzz_shiyu_stages || '').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_zzz_shiyu_periods', String(data.abyss_report_zzz_shiyu_periods || 'last').trim())
      yaml.set(_path + 'config.yaml', 'abyss_report_zzz_deadly_periods', String(data.abyss_report_zzz_deadly_periods || 'last').trim())

      const priorityFields = [
        'tl_priority', 'sign_priority', 'user_priority', 'wiki_priority',
        'bh3_remind_priority', 'activity_remind_priority', 'bh3_note_priority', 'bh3_abyss_priority',
        'bh3_battlefield_priority', 'bh3_godwar_priority', 'bh3_profile_priority',
        'bh3_all_note_priority', 'bh3_gacha_priority', 'bh3_ledger_priority', 'abyss_report_priority',
        'bilibili_priority', 'bilibili_push_priority', 'bili_live_priority', 'gacha_pool_priority',
        'gs_logs_priority', 'sr_logs_priority', 'mhy_estimate_priority',
        'video_priority', 'voice_priority', 'update_priority', 'config_priority', 'tlp_priority',
        'help_priority', 'picture_priority', 'npc_wt_priority', 'huobi_priority',
        'role_combat_priority', 'zzz_md_priority', 'currency_balance_priority',
        'custom_guide_priority',
        'meme_priority',
      ]
      for (const f of priorityFields) {
        if (data[f] != null) yaml.set(_path + 'config.yaml', f, Number(data[f]))
      }
      // wiki优先级在other.yaml
      if (data.wiki_priority != null) yaml.set(_path + 'other.yaml', 'wiki', Number(data.wiki_priority))

      return Result.ok({}, '保存成功，部分配置需重启生效')
    },
  },
  })
}

function parseList(value) {
  return String(value || '').split(/[,，\s]+/).map(v => v.trim()).filter(Boolean)
}

function parseMultiList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean)
  return parseList(value)
}

function formatSignUsers(users = {}) {
  if (!users || typeof users !== 'object') return ''
  return Object.entries(users)
    .filter(([, qqs]) => Array.isArray(qqs) && qqs.length)
    .map(([group, qqs]) => `${group}:${qqs.join(',')}`)
    .join('\n')
}

function parseSignUsers(value = '') {
  const result = {}
  for (const line of String(value || '').split(/[\n;]+/)) {
    const text = line.trim()
    if (!text) continue
    const [group, usersText = ''] = text.split(/[=：:]/)
    const gid = String(group || '').trim()
    if (!/^\d+$/.test(gid)) continue
    const users = usersText.split(/[,，\s]+/)
      .map(v => v.trim())
      .filter(v => /^\d+$/.test(v))
    if (users.length) result[gid] = [...new Set(users)]
  }
  return result
}

function formatGroupConfig(groupConfig = {}) {
  if (!groupConfig || typeof groupConfig !== 'object') return ''
  return Object.entries(groupConfig)
    .map(([group, games]) => `${group}=${Array.isArray(games) ? games.join(',') : games}`)
    .join('\n')
}

function parseGroupConfig(value = '') {
  const result = {}
  for (const line of String(value || '').split(/\n+/)) {
    const text = line.trim()
    if (!text) continue
    const [group, gamesText = ''] = text.split(/[=：:]/)
    const gid = group?.trim()
    if (!/^\d+$/.test(gid || '')) continue
    const games = parseList(gamesText).filter(v => ['gs', 'sr', 'zzz', 'bh3', 'by', 'xbgd'].includes(v))
    if (games.length) result[gid] = games
  }
  return result
}
