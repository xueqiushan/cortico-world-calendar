import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { CALENDAR_DEFAULTS, type CalendarConfigSection } from './config.ts';
import { CALENDAR_TOOL_DECLS, CalendarWorld } from './world.ts';

/**
 * 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。
 */
export const CALENDAR: WorldDefinition<CalendarConfigSection> = {
  id: 'calendar',
  label: '共享日历',
  defaults: () => ({ ...CALENDAR_DEFAULTS }),

  /**
   * 激活前检查环境。这里只做一件实事：确认数据文件那个目录能建、能读。
   * 读不出来要趁早说，而不是等她在对话里问起日程才发现。
   */
  preflight: async () => {
    try {
      const { access, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const file = fileURLToPath(new URL('../web/calendar.json', import.meta.url));
      await mkdir(dirname(file), { recursive: true });
      await access(dirname(file));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`日历数据目录没法用（${reason}）。检查一下 Coopanion 有没有这个目录的写入权限。`);
    }
  },

  create: (ctx) => new CalendarWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),

  describe: {
    tools: describeTools(CALENDAR_TOOL_DECLS, {
      calendar_list: {
        zh: '看日历上有什么（默认不列感受，需要时用 calendar_get 单读）。',
        en: 'Lists events without the feeling text; use calendar_get to read one in full.',
      },
      calendar_get: {
        zh: '看某一条的完整内容，包括备注和感受。',
        en: 'Reads one event in full, including its note and feeling.',
      },
      calendar_add: {
        zh: '往共享日历上加一条；生日/纪念日/节日填 yearly 就会每年都来。',
        en: 'Adds an event; recur:"yearly" makes birthdays and festivals come back every year.',
      },
      calendar_update: {
        zh: '改一条日程：标题、日期、类型、完成状态、备注、感受。',
        en: 'Updates title, date, type, done state, note or feeling of an event.',
      },
      calendar_remove: {
        zh: '删掉一条日程。',
        en: 'Deletes an event.',
      },
    }),
    events: [
      {
        type: 'calendar.due',
        description: {
          zh: '到点了：某条日程还剩几天到期，或今天就是它。她该用自己的话提醒他。',
          en: 'An event is N days away, or today is the day; she should remind him in her own words.',
        },
      },
      {
        type: 'calendar.askDone',
        description: {
          zh: '截止日当天（或已过）：该问问他完成得怎么样。',
          en: 'The due day has arrived or passed: time to ask how it went.',
        },
      },
    ],
  },
};
