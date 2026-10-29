/**
 * calendar.json 的读写。
 *
 * 唯一真源是一个文件，两边（World 插件 / 桌面网页服务）都读写它。
 * 所以这里的每条约定都是为了「两边不互相弄坏数据」：
 *
 * 1. 原子替换：先写 .tmp 再 rename，绝不让对端读到半截文件。
 * 2. 版本号：每次成功写入递增，对端能发现自己读到的是不是旧的。
 * 3. 读-改-写要趁新鲜：修改前重新读一遍，避免覆盖对方刚写的内容。
 *
 * 这是建议锁，不是真锁。个人使用频率下够用；真要强一致得上数据库，
 * 那不属于这个插件该背的重量。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type EventType = 'deadline' | 'normal' | 'birthday' | 'anniversary' | 'festival';

export const EVENT_TYPES: readonly EventType[] = [
  'deadline',
  'normal',
  'birthday',
  'anniversary',
  'festival',
];

export const TYPE_ICON: Record<EventType, string> = {
  deadline: '🔴',
  normal: '🔵',
  birthday: '🎂',
  anniversary: '💕',
  festival: '🎉',
};

export const TYPE_LABEL: Record<EventType, string> = {
  deadline: '紧急截止',
  normal: '普通日程',
  birthday: '生日',
  anniversary: '纪念日',
  festival: '节日',
};

export interface CalEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD。生日/纪念日/节日存原始年份，靠 recur 展开到当年。 */
  date: string;
  type: EventType;
  /** 'yearly' = 每年重复（生日/纪念日/节日）。 */
  recur: 'yearly' | null;
  done: boolean;
  note: string;
  /** 感受。他写的她能读，她写的他能读。但只有他说过的才能记。 */
  feeling: string;
  updatedAt: string;
  updatedBy: 'me' | 'her';
  /**
   * 已提醒记录，必须持久化。放内存的话 Coopanion 一重启就全忘，
   * 会被「还剩 3 天」反复轰炸。
   * key 形如 "d7" / "d3" / "d1" / "askedDone"。
   */
  reminded: Record<string, boolean>;
}

export interface CalendarFile {
  version: number;
  events: CalEvent[];
}

const MAX_TITLE = 60;
const MAX_NOTE = 500;
/** 感受给足空间，但要有上限兜底——这里是日历，不是日记本。 */
const MAX_FEELING = 2000;

export function emptyCalendar(): CalendarFile {
  return { version: 0, events: [] };
}

function nowIsoLocal(): string {
  return new Date().toISOString();
}

/** 本地时区的 YYYY-MM-DD。不用 UTC —— 否则晚上八点会算成第二天。 */
export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return ymd(new Date());
}

/** 把日期字符串解析成本地零点。非法返回 null。 */
export function parseYmd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * 某条日程在「今年」实际落在哪天。
 * 生日这类每年重复的，存的可能是 1998-11-12，今年要展开成 2026-11-12。
 */
export function effectiveDate(ev: CalEvent, year: number): string | null {
  if (ev.recur !== 'yearly') return ev.date;
  const dt = parseYmd(ev.date);
  if (!dt) return null;
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** 相差天数。正 = 还有几天，0 = 就是今天，负 = 已过期。 */
export function daysUntil(dateStr: string, from: Date = new Date()): number | null {
  const target = parseYmd(dateStr);
  if (!target) return null;
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);
  return Math.round((target.getTime() - base.getTime()) / 86_400_000);
}

export async function load(file: string): Promise<CalendarFile> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return normalize(parsed);
  } catch {
    // 文件不存在或坏了：给一份空的，不要拒绝启动。
    return emptyCalendar();
  }
}

/** 兜住各种脏数据：字段缺失、类型不对、type 值非法。 */
export function normalize(input: unknown): CalendarFile {
  if (typeof input !== 'object' || input === null) return emptyCalendar();
  const obj = input as Record<string, unknown>;
  const version = typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : 0;
  const rawEvents = Array.isArray(obj.events) ? obj.events : [];
  const events: CalEvent[] = [];
  for (const item of rawEvents) {
    const ev = normalizeEvent(item);
    if (ev) events.push(ev);
  }
  return { version, events };
}

function normalizeEvent(input: unknown): CalEvent | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null;
  const date = typeof o.date === 'string' ? o.date : '';
  if (!parseYmd(date)) return null;
  const type = EVENT_TYPES.includes(o.type as EventType) ? (o.type as EventType) : 'normal';
  const reminded: Record<string, boolean> = {};
  if (typeof o.reminded === 'object' && o.reminded !== null) {
    for (const [k, v] of Object.entries(o.reminded as Record<string, unknown>)) {
      if (v === true) reminded[k] = true;
    }
  }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `evt-${randomUUID().slice(0, 8)}`,
    title: title.slice(0, MAX_TITLE),
    date,
    type,
    recur: o.recur === 'yearly' ? 'yearly' : null,
    done: o.done === true,
    note: typeof o.note === 'string' ? o.note.slice(0, MAX_NOTE) : '',
    feeling: typeof o.feeling === 'string' ? o.feeling.slice(0, MAX_FEELING) : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : nowIsoLocal(),
    updatedBy: o.updatedBy === 'her' ? 'her' : 'me',
    reminded,
  };
}

/**
 * 原子写入：写临时文件 → rename。
 * 临时文件必须和目标同目录（跨卷 rename 不是原子的）。
 */
export async function save(file: string, data: CalendarFile): Promise<CalendarFile> {
  const next: CalendarFile = { version: data.version + 1, events: data.events };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 6)}`;
  const payload = JSON.stringify(next, null, 2);
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return next;
}

/**
 * 读-改-写的统一入口：先读最新的，交给 mutate 改，再原子写回。
 * 这样把「趁新鲜」这件事收在一处，调用方不会忘记。
 */
export async function mutate(
  file: string,
  mutateFn: (data: CalendarFile) => CalendarFile | null,
): Promise<CalendarFile> {
  const current = await load(file);
  const nextBody = mutateFn(current);
  if (!nextBody) return current;
  return save(file, { version: current.version, events: nextBody.events });
}

export function newEvent(partial: Partial<CalEvent> & { title: string; date: string }): CalEvent {
  return {
    id: `evt-${randomUUID().slice(0, 8)}`,
    title: partial.title.trim().slice(0, MAX_TITLE),
    date: partial.date,
    type: EVENT_TYPES.includes(partial.type as EventType) ? (partial.type as EventType) : 'normal',
    recur: partial.recur === 'yearly' ? 'yearly' : null,
    done: partial.done === true,
    note: (partial.note ?? '').slice(0, MAX_NOTE),
    feeling: (partial.feeling ?? '').slice(0, MAX_FEELING),
    updatedAt: nowIsoLocal(),
    updatedBy: partial.updatedBy === 'her' ? 'her' : 'me',
    reminded: partial.reminded ?? {},
  };
}

export const LIMITS = { MAX_TITLE, MAX_NOTE, MAX_FEELING };
