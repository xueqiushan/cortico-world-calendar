import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * config.json 的 worlds.calendar 段。
 *
 * 全部是扁平标量——框架的配置界面按 JSON Schema 渲染，嵌套对象/数组渲染不出来。
 * 这是硬约束，不是风格选择。
 */
export interface CalendarConfigSection {
  /** 剩余多少天时提醒。逗号分隔，如 "7,3,1"。空串 = 不提前提醒。 */
  remindDays: string;
  /** 到期当天要不要问「完成得怎么样」。 */
  askOnDue: boolean;
  /** 到期当天几点问（24 小时制）。默认 20 = 晚上八点。 */
  askAtHour: number;
  /** 扫描间隔（分钟）。默认 5。 */
  scanIntervalMin: number;
  /** 生日/纪念日/节日要不要也按 remindDays 提前提醒。默认 false = 只当天提醒。 */
  remindRecurring: boolean;
}

export const CALENDAR_DEFAULTS: CalendarConfigSection = {
  remindDays: '7,3,1',
  askOnDue: true,
  askAtHour: 20,
  scanIntervalMin: 5,
  remindRecurring: false,
};

export const CALENDAR_CONFIG_GROUP: ConfigGroup = {
  id: 'world:calendar',
  owner: 'world:calendar',
  schema: {
    type: 'object',
    title: '共享日历',
    properties: {
      'worlds.calendar.remindDays': {
        type: 'string',
        title: '提前提醒（天）',
        description: '剩几天时提醒，逗号分隔。默认 "7,3,1"；想只要 3 天和 1 天就写 "3,1"；加 14 天写 "14,7,3,1"。留空则不提前提醒。',
        'x-hot': true,
      },
      'worlds.calendar.askOnDue': {
        type: 'boolean',
        title: '到期当天询问',
        description: '到期当天问你「完成得怎么样」。默认开。',
        'x-hot': true,
      },
      'worlds.calendar.askAtHour': {
        type: 'integer',
        title: '询问时刻（点）',
        description: '到期当天几点问，24 小时制。默认 20（晚上八点）。白天问你还没做完，晚上问才有意义。',
      },
      'worlds.calendar.scanIntervalMin': {
        type: 'integer',
        title: '扫描间隔（分钟）',
        description: '多久检查一次有没有该提醒的日程。默认 5。改完要重启这个 World。',
      },
      'worlds.calendar.remindRecurring': {
        type: 'boolean',
        title: '生日/节日也提前提醒',
        description: '默认关：生日、纪念日、节日只在当天提醒一句。打开则也按「提前提醒」的天数响。',
      },
    },
  },
};
