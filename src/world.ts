/**
 * 共享日历 World：让她和你共用一份日历。
 *
 * 这个 World 只做三件事：
 * 1. 给她增删查改日程的工具；
 * 2. 定时扫描，快到期时提醒、到期当晚让她问你一句；
 * 3. 把自己那份「已提醒」状态写回文件（不写回就会被反复轰炸）。
 *
 * 它不负责显示——桌面窗口是 web/ 下那个独立的 Edge 应用，
 * 两边通过 calendar.json 这个文件对齐。谁也不拥有数据，文件是唯一真源。
 *
 * 有意不做的事：
 * - 不擅自改期。到期没完成是「没完成」，不是「挪到明天」，改不改期他说了算。
 * - 不做真正的并发锁。个人使用频率下，读-改-写 + 版本号够用；
 *   真要强一致得上数据库，那不是这个插件该背的重量。
 */
import type {
  Logger,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  ToolSpec,
  TriggerMode,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { fileURLToPath } from 'node:url';
import {
  CALENDAR_CONFIG_GROUP,
  type CalendarConfigSection,
} from './config.ts';
import {
  EVENT_TYPES,
  TYPE_ICON,
  TYPE_LABEL,
  daysUntil,
  effectiveDate,
  load,
  mutate,
  newEvent,
  normalize,
  parseYmd,
  todayStr,
  ymd,
  type CalEvent,
  type CalendarFile,
  type EventType,
} from './store.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 默认数据文件：包内 web/calendar.json。不暴露给模型，也不做成配置项。 */
const DEFAULT_DATA_FILE = fileURLToPath(new URL('../web/calendar.json', import.meta.url));

/** 列表默认最多列多少条，剩下的报个数。超了会吃掉上下文。 */
const LIST_CAP = 40;

// ——— 工具静态声明 ———

const LIST_DECL: ToolSpec = {
  name: 'calendar_list',
  description:
    'List calendar events. By default returns title, date, type icon and done state only — WITHOUT the feeling text, to keep it cheap. Pass withFeeling:true only when you actually need to read how he felt.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      from: { type: 'string', description: '起始日期 YYYY-MM-DD，含当天。省略则不限。' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD，含当天。省略则不限。' },
      type: {
        type: 'string',
        enum: ['deadline', 'normal', 'birthday', 'anniversary', 'festival'],
        description: '只列某一类。省略则全列。',
      },
      onlyUndone: { type: 'boolean', description: '只列未完成的。默认 false。' },
      withFeeling: { type: 'boolean', description: '默认 false。true 才会带上感受正文。' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: `最多列几条，默认 ${LIST_CAP}。` },
    },
  },
};

const GET_DECL: ToolSpec = {
  name: 'calendar_get',
  description:
    'Read one event in full, including its note and feeling. Use this when you want to pick up where he left off emotionally, not for routine listing.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '日程 id。' },
    },
    required: ['id'],
  },
};

const ADD_DECL: ToolSpec = {
  name: 'calendar_add',
  description:
    'Add an event to the shared calendar. Use recur:"yearly" for birthdays, anniversaries and festivals so it comes back every year.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: '标题，要短——格子里只放得下几十个字。' },
      date: { type: 'string', description: '日期 YYYY-MM-DD。' },
      type: {
        type: 'string',
        enum: ['deadline', 'normal', 'birthday', 'anniversary', 'festival'],
        description: 'deadline 紧急截止；normal 普通；birthday 生日；anniversary 纪念日；festival 节日。默认 normal。',
      },
      recur: {
        type: 'string',
        enum: ['yearly'],
        description: '生日/纪念日/节日填 yearly。省略则不重复。',
      },
      note: { type: 'string', description: '备注，一两句话。' },
    },
    required: ['title', 'date'],
  },
};

const UPDATE_DECL: ToolSpec = {
  name: 'calendar_update',
  description:
    'Update an existing event. Only pass the fields you want to change. Use feeling to write down what HE said he felt — never invent feelings he did not express.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '日程 id。' },
      title: { type: 'string', description: '新标题。' },
      date: { type: 'string', description: '新日期 YYYY-MM-DD。' },
      type: {
        type: 'string',
        enum: ['deadline', 'normal', 'birthday', 'anniversary', 'festival'],
        description: '新类型。',
      },
      done: { type: 'boolean', description: '标记完成 / 取消完成。' },
      note: { type: 'string', description: '新备注。' },
      feeling: { type: 'string', description: '感受。只写他说过的话，不要替他编。' },
    },
    required: ['id'],
  },
};

const REMOVE_DECL: ToolSpec = {
  name: 'calendar_remove',
  description: 'Delete an event from the shared calendar.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '要删除的日程 id。' },
    },
    required: ['id'],
  },
};

export const CALENDAR_TOOL_DECLS: readonly ToolSpec[] = [
  LIST_DECL,
  GET_DECL,
  ADD_DECL,
  UPDATE_DECL,
  REMOVE_DECL,
];

export interface CalendarWorldOptions {
  cfg: CalendarConfigSection;
  timezone: string;
  /** 数据文件路径。测试用；缺省指向包内 web/calendar.json。 */
  file?: string;
}

export class CalendarWorld implements World {
  readonly id = 'calendar';

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastError = '';
  private running = false;
  private readonly file: string;

  constructor(private readonly opts: CalendarWorldOptions) {
    this.file = opts.file ?? DEFAULT_DATA_FILE;
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [
      { ...LIST_DECL, handler: (args) => this.list(args) },
      { ...GET_DECL, handler: (args) => this.get(args) },
      { ...ADD_DECL, handler: (args) => this.add(args) },
      { ...UPDATE_DECL, handler: (args) => this.update(args) },
      { ...REMOVE_DECL, handler: (args) => this.remove(args) },
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [this.lamp()],
      badges: [
        { label: '数据文件', value: shortPath(this.file), tone: 'plain' as const },
        { label: '提前提醒', value: this.opts.cfg.remindDays || '（关）', tone: 'plain' as const },
      ],
      config: [CALENDAR_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.calendar.envPrompt',
          title: '共享日历 · 环境提示词',
          description: '日历这一段进 system 前缀的说明；留空则该 World 不进入前缀。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const log = host.log.child(this.id);
    this.running = true;
    this.lastError = '';
    try {
      await load(this.file); // 先摸一下，读不出来早点说
      log.info('共享日历已启动', { file: this.file });
    } catch (err) {
      this.lastError = describe(err);
      log.error('读日历数据失败', err);
    }
    // 启动时先扫一遍：错过的提醒要补，不能等到下一个周期才发现。
    await this.scanSafely(log);
    this.armTimer(log);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  // ——— 定时扫描 ———

  private armTimer(log: Logger): void {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(60_000, Math.round(this.opts.cfg.scanIntervalMin) * 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scanSafely(log).then(() => {
        if (this.running) this.armTimer(log);
      });
    }, ms);
  }

  private async scanSafely(log: Logger): Promise<void> {
    try {
      await this.scan();
      this.lastError = '';
    } catch (err) {
      this.lastError = describe(err);
      log.error('扫描日历出错', err);
    }
  }

  /**
   * 扫一遍该提醒的。
   *
   * 提醒标记走 mutate（重新读一遍再写），而不是用扫描开始时那份旧数据直接覆盖——
   * 否则可能把网页那头刚写的改动盖掉。
   */
  private async scan(): Promise<void> {
    const cfg = this.opts.cfg;
    const now = new Date();
    const year = now.getFullYear();
    const dayMarks = parseRemindDays(cfg.remindDays);
    const data = await load(this.file);
    const marks: Array<{ id: string; key: string }> = [];

    for (const ev of data.events) {
      if (ev.done) continue;
      const isRecur = ev.recur === 'yearly';
      const dateStr = effectiveDate(ev, year);
      if (!dateStr) continue;
      const d = daysUntil(dateStr, now);
      if (d === null) continue;

      // 提前提醒：重复类（生日/纪念日/节日）默认只在当天响。
      if (!isRecur || cfg.remindRecurring) {
        for (const n of dayMarks) {
          if (d === n && !ev.reminded[`d${n}`]) {
            marks.push({ id: ev.id, key: `d${n}` });
            await this.emit(
              'calendar.due',
              `日程「${ev.title}」还有 ${n} 天到期（${dateStr}）。`,
              'flush',
            );
          }
        }
      }

      // 当天：所有类型都报一句。
      if (d === 0 && !ev.reminded.d0) {
        marks.push({ id: ev.id, key: 'd0' });
        await this.emit('calendar.due', `今天就是「${ev.title}」的日子（${dateStr}）。`, 'flush');
      }

      // 到期当晚（或已过期）问一句。只问一次。
      if (cfg.askOnDue && d <= 0 && now.getHours() >= clampHour(cfg.askAtHour) && !ev.reminded.askedDone) {
        marks.push({ id: ev.id, key: 'askedDone' });
        const lead = d === 0 ? '今天就是截止日' : `已经过了 ${-d} 天`;
        await this.emit(
          'calendar.askDone',
          `「${ev.title}」（${dateStr}）${lead}。问问他完成得怎么样——用你自己的话问，别念字段。`,
          'flush',
        );
      }
    }

    if (marks.length > 0) {
      await mutate(this.file, (fresh) => {
        for (const m of marks) {
          const target = fresh.events.find((e) => e.id === m.id);
          if (target) target.reminded[m.key] = true;
        }
        return fresh;
      });
    }
  }

  private lamp(): WorldLamp {
    if (this.lastError) {
      return { label: '日历', state: 'error', hint: this.lastError };
    }
    return { label: '日历', state: 'online', hint: `每 ${Math.round(this.opts.cfg.scanIntervalMin)} 分钟查一次` };
  }

  // ——— 工具实现 ———

  private async list(args: Record<string, unknown>): Promise<ToolOutcome> {
    const from = typeof args.from === 'string' ? args.from : null;
    const to = typeof args.to === 'string' ? args.to : null;
    if (from && !parseYmd(from)) return fail('from 要是 YYYY-MM-DD。');
    if (to && !parseYmd(to)) return fail('to 要是 YYYY-MM-DD。');
    const type = typeof args.type === 'string' ? (args.type as EventType) : null;
    if (type && !EVENT_TYPES.includes(type)) return fail(`type 只能是 ${EVENT_TYPES.join(' / ')}。`);
    const withFeeling = args.withFeeling === true;
    const onlyUndone = args.onlyUndone === true;
    const limit = typeof args.limit === 'number' && args.limit >= 1 && args.limit <= 100 ? args.limit : LIST_CAP;

    const data = await load(this.file);
    const year = new Date().getFullYear();
    let items = data.events.map((ev) => ({ ev, eff: effectiveDate(ev, year) ?? ev.date }));
    if (from) items = items.filter((x) => x.eff >= from);
    if (to) items = items.filter((x) => x.eff <= to);
    if (type) items = items.filter((x) => x.ev.type === type);
    if (onlyUndone) items = items.filter((x) => !x.ev.done);
    items.sort((a, b) => (a.eff === b.eff ? 0 : a.eff < b.eff ? -1 : 1));

    const total = items.length;
    const page = items.slice(0, limit);
    if (total === 0) return { text: '这段时间里日历上没有日程。' };

    const lines = [`日历共 ${total} 条${total > limit ? `，先列前 ${limit} 条` : ''}：`];
    for (const { ev, eff } of page) {
      const icon = ev.done ? '✅' : TYPE_ICON[ev.type];
      const recur = ev.recur === 'yearly' ? '（每年）' : '';
      const done = ev.done ? '已完成' : '';
      const note = ev.note ? ` — ${oneLine(ev.note)}` : '';
      lines.push(`- ${icon} ${eff}${recur} ${ev.title}${done ? ` [${done}]` : ''}${note}  (id=${ev.id})`);
      // 感受默认不列——那是主要的花销来源，需要时用 calendar_get 单读。
      if (withFeeling && ev.feeling) lines.push(`    感受：${oneLine(ev.feeling)}`);
    }
    if (total > limit) lines.push(`（还有 ${total - limit} 条没列，可以加 limit 或缩小日期范围。）`);
    lines.push('（id 用于 calendar_get / update / remove。想读某条的感受，用 calendar_get。）');
    return { text: lines.join('\n') };
  }

  private async get(args: Record<string, unknown>): Promise<ToolOutcome> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return fail('要给我 id。');
    const data = await load(this.file);
    const ev = data.events.find((e) => e.id === id);
    if (!ev) return fail(`没有 id 为 ${id} 的日程。用 calendar_list 看有哪些。`);
    const year = new Date().getFullYear();
    const eff = effectiveDate(ev, year) ?? ev.date;
    const by = ev.updatedBy === 'her' ? '你（她）' : '他';
    const lines = [
      `${ev.done ? '✅' : TYPE_ICON[ev.type]} ${ev.title}`,
      `日期：${eff}${ev.recur === 'yearly' ? `（每年重复，原始 ${ev.date}）` : ''}`,
      `类型：${TYPE_LABEL[ev.type]}　状态：${ev.done ? '已完成' : '未完成'}`,
      `备注：${ev.note || '（没写）'}`,
      `感受：${ev.feeling || '（没写）'}`,
      `最后修改：${by}`,
    ];
    return { text: lines.join('\n') };
  }

  private async add(args: Record<string, unknown>): Promise<ToolOutcome> {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) return fail('title 不能为空。');
    const date = typeof args.date === 'string' ? args.date.trim() : '';
    if (!parseYmd(date)) return fail('date 要是 YYYY-MM-DD，比如 2026-11-05。');
    let type: EventType = 'normal';
    if (typeof args.type === 'string') {
      if (!EVENT_TYPES.includes(args.type as EventType)) return fail(`type 只能是 ${EVENT_TYPES.join(' / ')}。`);
      type = args.type as EventType;
    }
    const recur = args.recur === 'yearly' ? 'yearly' : null;
    const note = typeof args.note === 'string' ? args.note : '';

    const created = newEvent({ title, date, type, recur, note, updatedBy: 'her' });
    await mutate(this.file, (data) => ({
      version: data.version,
      events: [...data.events, created],
    }));
    return {
      text: `已记下：${TYPE_ICON[type]} ${date} ${title}${recur === 'yearly' ? '（每年）' : ''}。id=${created.id}。他桌面上那个日历也会显示这一条。`,
    };
  }

  private async update(args: Record<string, unknown>): Promise<ToolOutcome> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return fail('要给我 id。');
    if (typeof args.date === 'string' && !parseYmd(args.date)) return fail('date 要是 YYYY-MM-DD。');
    if (typeof args.type === 'string' && !EVENT_TYPES.includes(args.type as EventType)) {
      return fail(`type 只能是 ${EVENT_TYPES.join(' / ')}。`);
    }

    let found = false;
    const changed: string[] = [];
    const after = await mutate(this.file, (data) => {
      const ev = data.events.find((e) => e.id === id);
      if (!ev) return null;
      found = true;
      if (typeof args.title === 'string' && args.title.trim()) {
        ev.title = args.title.trim();
        changed.push('标题');
      }
      if (typeof args.date === 'string') {
        ev.date = args.date;
        changed.push('日期');
      }
      if (typeof args.type === 'string') {
        ev.type = args.type as EventType;
        changed.push('类型');
      }
      if (typeof args.done === 'boolean') {
        ev.done = args.done;
        changed.push(args.done ? '标记完成' : '取消完成');
        // 完成/取消完成都算新的周期，旧的提醒标记清掉，免得状态错乱。
        if (args.done === false) ev.reminded = {};
      }
      if (typeof args.note === 'string') {
        ev.note = args.note;
        changed.push('备注');
      }
      if (typeof args.feeling === 'string') {
        ev.feeling = args.feeling;
        changed.push('感受');
      }
      if (changed.length === 0) return null;
      ev.updatedAt = new Date().toISOString();
      ev.updatedBy = 'her';
      return data;
    });

    if (!found) return fail(`没有 id 为 ${id} 的日程。`);
    if (changed.length === 0) return { text: '没有要改的字段，什么都没动。' };
    return { text: `已改「${after.events.find((e) => e.id === id)?.title ?? id}」的${changed.join('、')}。` };
  }

  private async remove(args: Record<string, unknown>): Promise<ToolOutcome> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return fail('要给我 id。');
    let title = '';
    await mutate(this.file, (data) => {
      const ev = data.events.find((e) => e.id === id);
      if (!ev) return null;
      title = ev.title;
      return { version: data.version, events: data.events.filter((e) => e.id !== id) };
    });
    if (!title) return fail(`没有 id 为 ${id} 的日程。`);
    return { text: `已删除「${title}」。` };
  }

  // ——— 事件 ———

  private async emit(type: string, text: string, trigger?: TriggerMode): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        {
          type,
          ts: nowIso(this.opts.timezone),
          source: this.id,
          // 到点提醒是机制触发的；日程内容变更才算来自他的世界。
          origin: type === 'calendar.due' || type === 'calendar.askDone' ? 'internal' : 'external',
          senderKey: this.id,
          text,
        },
        trigger ? { trigger } : undefined,
      );
    } catch {
      // 投递失败不该把 World 自己带崩
    }
  }
}

// ——— 小工具 ———

function parseRemindDays(raw: string): number[] {
  const out = new Set<number>();
  for (const part of String(raw ?? '').split(/[,，\s]+/)) {
    const n = Number(part);
    if (Number.isInteger(n) && n > 0 && n <= 365) out.add(n);
  }
  return [...out].sort((a, b) => b - a);
}

function clampHour(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? Math.round(h) : 20;
  return Math.min(23, Math.max(0, n));
}

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function shortPath(p: string, max = 28): string {
  return p.length > max ? `…${p.slice(-max)}` : p;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(text: string): ToolOutcome {
  return { text, failed: true };
}

// 这些导出是为了让 store 的类型在 definition / 测试里也能用到，
// 同时避免 tree-shaking 把未直接引用的常量误删。
export { normalize, todayStr, ymd, type CalendarFile, type CalEvent };
