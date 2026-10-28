import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assessCalendarNotices, type CalendarNotice } from './calendar-notice-assessment.ts';

type Session = { date: string; open: string; close: string };
type Calendar = {
  years: number[];
  holidays: Set<string>;
  early: Map<string, number>;
  open: number;
  close: number;
  hours: Map<string, { open?: number; close?: number }>;
};
type Exchange = 'NAS' | 'NYS' | 'AMS';
type Notice = CalendarNotice;
const nyseUrl = 'https://www.nyse.com/trade/hours-calendars';
const nasdaqUrl = 'https://www.nasdaqtrader.com/Trader.aspx?id=Calendar';
const nasdaqHoursUrl =
  'https://www.nasdaqtrader.com/content/productsservices/trading/oe_refguide.pdf';
const rssUrl = 'https://www.nasdaqtrader.com/rss.aspx?categorylist=2%2C6%2C7&feed=currentheadlines';
const sources: { url: string; receivedAt: string; sha256: string; bytes: number }[] = [];
const startedAt = performance.now();
let totalBytes = 0;
let activeSource: string | undefined;
let activeNotice: string | undefined;
type NoticeCollection = {
  channel: string;
  url: string;
  query: Record<string, string>;
  parentCount: number;
  childCount: number;
  linkedBodyCount: number;
  totalAvailable: number | null;
  observedPublishedRange: { first: string; last: string } | null;
  continuousCoverage: 'unverified';
};
const noticeCollections: NoticeCollection[] = [];
const notices: Notice[] = [];
const scheduleChanges: {
  id: string;
  exchanges: Exchange[];
  date: string;
  kind: 'closed' | 'session_hours';
  open: string | null;
  close: string | null;
}[] = [];
const deferredNotices: {
  id: string;
  url: string;
  effectiveDate: string;
  reason: 'regular_session_scope_unresolved';
}[] = [];

function fail(code: string): never {
  throw new Error(code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_SHAPE');
  return value as Record<string, unknown>;
}
async function collectBytes(url: string) {
  activeSource = url;
  if (sources.length >= 100 || performance.now() - startedAt >= 120_000) fail('COLLECTION_LIMIT');
  const response = await fetch(url, {
    redirect: 'error',
    headers: { 'User-Agent': 'StockScout/0.1 (+https://github.com/mochafreddo/stock-scout)' },
    signal: AbortSignal.timeout(
      Math.max(1, Math.floor(Math.min(15_000, startedAt + 120_000 - performance.now()))),
    ),
  });
  if (response.status !== 200 || !response.body) fail('SOURCE_HTTP_FAILURE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      totalBytes += part.value.byteLength;
      if (bytes > 2_000_000 || totalBytes > 16_000_000 || performance.now() - startedAt >= 120_000)
        fail('COLLECTION_LIMIT');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const buffer = Buffer.concat(chunks);
  sources.push({
    url,
    receivedAt: new Date(Date.now()).toISOString(),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes,
  });
  return buffer;
}
async function collect(url: string) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await collectBytes(url));
}
function nasdaqHours(source: Buffer) {
  const result = spawnSync('pdftotext', ['-', '-'], {
    input: source,
    timeout: 3000,
    maxBuffer: 1_000_000,
  });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT')
    fail('PDF_PARSER_UNAVAILABLE');
  if (result.error || result.status !== 0) fail('SOURCE_SHAPE');
  const value = result.stdout.toString('utf8');
  if (!value.includes('Nasdaq Trading Hours of Operation')) fail('SOURCE_SHAPE');
  const open = /Market Open:\s*(\d{1,2}:\d{2} [ap]\.m\.), ET/.exec(value);
  const close = /Market Close:\s*(\d{1,2}:\d{2} [ap]\.m\.), ET/.exec(value);
  if (!open || !close) fail('SOURCE_SHAPE');
  return { open: minutes(open[1]), close: minutes(close[1]) };
}
function xml(source: string, expression: string, html = false) {
  if (performance.now() - startedAt >= 120_000) fail('COLLECTION_LIMIT');
  if (/<!ENTITY/i.test(source) || (!html && /<!DOCTYPE/i.test(source))) fail('SOURCE_SHAPE');
  const result = spawnSync(
    '/usr/bin/xmllint',
    [
      ...(html ? ['--html', '--recover'] : []),
      '--nonet',
      '--nocatalogs',
      '--xpath',
      expression,
      '-',
    ],
    {
      input: html ? `<meta charset="UTF-8">${source}` : source,
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(Math.min(3000, startedAt + 120_000 - performance.now()))),
      maxBuffer: 2_000_000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    },
  );
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT')
    fail('XML_PARSER_UNAVAILABLE');
  if (result.error || result.status !== 0) fail('SOURCE_SHAPE');
  return result.stdout.trim();
}
function text(source: string) {
  return xml(`<html><body>${source}</body></html>`, 'normalize-space(//body)', true);
}
function cells(row: string) {
  return [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => text(m[1]));
}
function rows(source: string) {
  return [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => cells(m[1]));
}
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function dateIn(textValue: string, year?: number) {
  const match =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:, (\d{4}))?\b/.exec(
      textValue,
    );
  if (!match) fail('SOURCE_SHAPE');
  const y = year ?? Number(match[3]);
  const month = months.indexOf(match[1]) + 1;
  const day = Number(match[2]);
  const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (
    !Number.isInteger(y) ||
    y < 1970 ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    fail('SOURCE_SHAPE');
  const statedDay = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s*$/.exec(
    textValue.slice(0, match.index),
  );
  if (
    (match[3] && year !== undefined && Number(match[3]) !== year) ||
    (statedDay &&
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
        new Date(date).getUTCDay()
      ] !== statedDay[1])
  )
    fail('SOURCE_SHAPE');
  return date;
}
function minutes(value: string) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])\.m\.$/i.exec(value.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) fail('SOURCE_SHAPE');
  return (Number(m[1]) % 12) * 60 + Number(m[2]) + (m[3].toLowerCase() === 'p' ? 720 : 0);
}
function nyseCalendar(source: string): Calendar {
  const table = xml(source, '//table[.//th[normalize-space(.)="Holiday"]]', true);
  const parsed = rows(table);
  const years = parsed[0]?.slice(1).map(Number);
  if (!years?.length || years.some((y) => !Number.isInteger(y) || y < 1970) || parsed.length !== 11)
    fail('SOURCE_SHAPE');
  const holidays = new Set<string>();
  for (const row of parsed.slice(1)) {
    if (row.length !== years.length + 1) fail('SOURCE_SHAPE');
    row.slice(1).forEach((cell, index) => {
      if (/^[—–-]\*$/.test(cell)) {
        if (
          !xml(
            source,
            'normalize-space(//p[starts-with(normalize-space(.),"* Because")])',
            true,
          ).includes(`January 1, ${years[index]}`)
        )
          fail('SOURCE_SHAPE');
      } else holidays.add(dateIn(cell, years[index]));
    });
  }
  const early = new Map<string, number>();
  const notes = xml(source, '//p[starts-with(normalize-space(.),"**")]', true);
  for (const paragraph of notes.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const note = text(paragraph[1]);
    const time = /Each market will close early at (\d{1,2}:\d{2}\s*[ap]\.m\.)/.exec(note);
    if (!time || !note.includes('All times are Eastern Time')) fail('SOURCE_SHAPE');
    const dates = note.match(
      /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), )?(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/g,
    );
    if (!dates?.length) fail('SOURCE_SHAPE');
    for (const date of dates) early.set(dateIn(date), minutes(time[1]));
  }
  const hours = ['NYSE', 'NYSE American'].map((market) => {
    const selector = `//button[normalize-space(.)="${market}"]/following-sibling::div[1]`;
    if (xml(source, `count(${selector})`, true) !== '1') fail('SOURCE_SHAPE');
    const section = xml(source, `normalize-space(${selector})`, true);
    const matches = [
      ...section.matchAll(
        /Core Trading Session: (\d{1,2}:\d{2} [ap]\.m\.) to (\d{1,2}:\d{2} [ap]\.m\.) ET/g,
      ),
    ];
    if (!matches.length) fail('SOURCE_SHAPE');
    const times = matches.map((match) => [minutes(match[1]), minutes(match[2])]);
    if (times.some((time) => JSON.stringify(time) !== JSON.stringify(times[0])))
      fail('SOURCE_SHAPE');
    return times[0];
  });
  if (JSON.stringify(hours[0]) !== JSON.stringify(hours[1])) fail('EXCHANGE_MISMATCH');
  return { years, holidays, early, open: hours[0][0], close: hours[0][1], hours: new Map() };
}
function nasdaqCalendar(source: string, hours: { open: number; close: number }): Calendar {
  const heading = xml(source, 'normalize-space(//h1)', true);
  const year = Number(
    /U\.S\. Equity and Options Markets Holiday Schedule (\d{4})/.exec(heading)?.[1],
  );
  const parsed = rows(xml(source, '//table[.//th[normalize-space(.)="Status"]]', true));
  if (!Number.isInteger(year) || parsed.length < 2 || parsed[0]?.[0] !== String(year))
    fail('SOURCE_SHAPE');
  const holidays = new Set<string>();
  const early = new Map<string, number>();
  for (const row of parsed.slice(1)) {
    if (row.length !== 3) fail('SOURCE_SHAPE');
    const date = dateIn(row[0]);
    if (!date.startsWith(`${year}-`)) fail('SOURCE_SHAPE');
    if (row[2] === 'Closed') holidays.add(date);
    else if (/^Early Close/.test(row[1])) early.set(date, minutes(row[2]));
    else fail('SOURCE_SHAPE');
  }
  return { years: [year], holidays, early, ...hours, hours: new Map() };
}
function published(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isFinite(new Date(value).getTime())
  )
    fail('SOURCE_SHAPE');
  return new Date(value).toISOString();
}
function observedRange(dates: string[]) {
  dates.sort();
  return dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null;
}
function nyseNotices(source: string, channel: number, url: string) {
  const page = object(JSON.parse(source));
  if (
    !Array.isArray(page.data) ||
    !Number.isInteger(page.totalCount) ||
    Number(page.totalCount) < 0 ||
    page.data.length !== Math.min(100, Number(page.totalCount))
  )
    fail('SOURCE_SHAPE');
  const dates: string[] = [];
  let childCount = 0;
  for (const raw of page.data) {
    const notice = object(raw);
    if (
      !Number.isSafeInteger(notice.id) ||
      !Array.isArray(notice.marketLinks) ||
      !notice.marketLinks.length ||
      notice.marketLinks.some((v) => typeof v !== 'string' || !v.trim()) ||
      !Array.isArray(notice.childNotifications)
    )
      fail('SOURCE_SHAPE');
    activeNotice = String(notice.id);
    const entries: CalendarNotice['entries'] = [];
    for (const rawEntry of [notice, ...notice.childNotifications]) {
      const entry = object(rawEntry);
      dates.push(published(entry.publishedDate));
      if (
        typeof entry.subject !== 'string' ||
        typeof entry.body !== 'string' ||
        !entry.subject.trim() ||
        !entry.body.trim()
      )
        fail('SOURCE_SHAPE');
      const body = text(entry.body);
      if (!body) fail('SOURCE_SHAPE');
      entries.push({
        id: `nyse:${channel}:${notice.id}:${entries.length}`,
        publishedAt: published(entry.publishedDate),
        subject: entry.subject,
        body,
      });
    }
    childCount += notice.childNotifications.length;
    const markets = (notice.marketLinks as string[]).map((market) => market.trim());
    const exchanges: Exchange[] = [];
    if (markets.includes('NYSE')) exchanges.push('NYS');
    if (markets.includes('NYSE AMERICAN EQUITIES')) exchanges.push('AMS');
    const outside = [
      'NYSE ARCA OPTIONS',
      'NYSE AMERICAN OPTIONS',
      'NYSE ARCA EQUITIES',
      'NYSE NATIONAL',
      'NYSE TEXAS',
      'NYSE CHICAGO',
      'NYSE BONDS',
      'NYSE BQT',
      'FINRA/NYSE TRF',
      'NYSE REGULATORY HALTS',
    ];
    if (
      !markets.every((m) => outside.includes(m) || m === 'NYSE' || m === 'NYSE AMERICAN EQUITIES')
    )
      fail('NOTICE_UNRESOLVED');
    if (exchanges.length)
      notices.push({ id: `nyse:${channel}:${notice.id}`, url, exchanges, entries });
  }
  activeNotice = undefined;
  noticeCollections.push({
    channel: channel === 2 ? 'NYSE Market Status' : 'NYSE Trader Updates',
    url,
    query: Object.fromEntries(new URL(url).searchParams),
    parentCount: page.data.length,
    childCount,
    linkedBodyCount: 0,
    totalAvailable: Number(page.totalCount),
    observedPublishedRange: observedRange(dates),
    continuousCoverage: 'unverified',
  });
}
async function nasdaqNotices(source: string) {
  if (
    xml(source, 'count(/rss/channel)') !== '1' ||
    !xml(source, 'normalize-space(/rss/channel/title)')
  )
    fail('SOURCE_SHAPE');
  const count = Number(xml(source, 'count(/rss/channel/item)'));
  if (!Number.isInteger(count) || count < 0 || count > 90) fail('COLLECTION_LIMIT');
  const declared = xml(source, 'normalize-space(/rss/channel/*[local-name()="numItems"])');
  if (declared && Number(declared) !== count) fail('SOURCE_SHAPE');
  const dates: string[] = [];
  const items = count ? xml(source, '/rss/channel/item') : '';
  const parsed = [...items.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  if (parsed.length !== count) fail('SOURCE_SHAPE');
  for (const item of parsed) {
    const field = (name: string) => {
      const matches = [
        ...item[1].matchAll(
          new RegExp(
            `<(?:(?:[\\w-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${name}>`,
            'g',
          ),
        ),
      ];
      if (matches.length !== 1) fail('SOURCE_SHAPE');
      return text(matches[0][1]);
    };
    const link = field('link').replace(/^http:/, 'https:');
    if (!/^https:\/\/www\.nasdaqtrader\.com\/TraderNews\.aspx\?id=ET[AU]\d{4}-\d+$/.test(link))
      fail('SOURCE_SHAPE');
    activeNotice = link.split('=')[1];
    dates.push(published(Date.parse(field('pubDate'))));
    const article = await collect(link);
    const root =
      '//div[@id="MainContainer"]//div[contains(concat(" ",normalize-space(@class)," ")," genTableNews ")]';
    if (xml(article, `count(${root})`, true) !== '1') fail('SOURCE_SHAPE');
    const contents = `${root}/table//td[not(ancestor::td)]`;
    const contentCount = Number(xml(article, `count(${contents})`, true));
    if (!Number.isInteger(contentCount) || contentCount < 1 || contentCount > 3)
      fail('SOURCE_SHAPE');
    for (let index = 2; index <= contentCount; index++)
      if (xml(article, `normalize-space((${contents})[${index}])`, true).trim())
        fail('SOURCE_SHAPE');
    const body = xml(article, `normalize-space((${contents})[1])`, true);
    if (!body) fail('SOURCE_SHAPE');
    notices.push({
      id: `nasdaq:${activeNotice}`,
      url: link,
      exchanges: ['NAS'],
      entries: [
        {
          id: `nasdaq:${activeNotice}:0`,
          publishedAt: published(Date.parse(field('pubDate'))),
          subject: field('title'),
          body,
        },
      ],
    });
  }
  activeNotice = undefined;
  noticeCollections.push({
    channel: 'Nasdaq Equity RSS',
    url: rssUrl,
    query: Object.fromEntries(new URL(rssUrl).searchParams),
    parentCount: count,
    childCount: 0,
    linkedBodyCount: count,
    totalAvailable: null,
    observedPublishedRange: observedRange(dates),
    continuousCoverage: 'unverified',
  });
}
function applyNotices(
  calendars: Record<Exchange, Calendar>,
  assessments: import('./calendar-notice-assessment.ts').NoticeAssessment[],
) {
  if (assessments.some((record) => record.status === 'unresolved')) fail('NOTICE_UNRESOLVED');
  const superseded = new Set(assessments.flatMap((record) => record.supersedes));
  const applied = new Map<string, { closed: boolean; open?: number; close?: number }>();
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  for (const record of assessments) {
    if (superseded.has(record.id)) continue;
    const notice = notices.find((notice) => notice.id === record.id) as Notice;
    activeSource = notice.url;
    activeNotice = notice.id;
    if (record.status === 'future_effective')
      deferredNotices.push({
        id: record.id,
        url: notice.url,
        effectiveDate: record.effectiveDate as string,
        reason: 'regular_session_scope_unresolved',
      });
    for (const change of record.changes) {
      for (const exchange of change.exchanges) {
        const key = `${exchange}:${change.date}`;
        const previous = applied.get(key);
        const closed = change.kind === 'closed';
        const open = change.open === null ? undefined : minute(change.open);
        const close = change.close === null ? undefined : minute(change.close);
        if (
          previous &&
          (previous.closed !== closed ||
            (open !== undefined && previous.open !== undefined && open !== previous.open) ||
            (close !== undefined && previous.close !== undefined && close !== previous.close))
        )
          fail('NOTICE_UNRESOLVED');
        const calendar = calendars[exchange];
        if (closed) calendar.holidays.add(change.date);
        else {
          if (
            [0, 6].includes(new Date(change.date).getUTCDay()) ||
            calendar.holidays.has(change.date)
          )
            fail('NOTICE_UNRESOLVED');
          const hours = {
            ...calendar.hours.get(change.date),
            ...(open === undefined ? {} : { open }),
            ...(close === undefined ? {} : { close }),
          };
          if (
            (hours.open ?? calendar.open) >=
            (hours.close ?? calendar.early.get(change.date) ?? calendar.close)
          )
            fail('NOTICE_UNRESOLVED');
          calendar.hours.set(change.date, hours);
        }
        applied.set(key, {
          ...previous,
          closed,
          ...(open === undefined ? {} : { open }),
          ...(close === undefined ? {} : { close }),
        });
      }
      scheduleChanges.push({ id: record.id, ...change });
    }
  }
  activeNotice = undefined;
}
function checkDeferred(target: Session) {
  for (const notice of deferredNotices)
    if (notice.effectiveDate <= target.date) {
      activeSource = notice.url;
      activeNotice = notice.id;
      fail('NOTICE_UNRESOLVED');
    }
}
function checkAgreement(calendars: Record<Exchange, Calendar>) {
  const reference = calendars.NYS;
  for (const exchange of ['NAS', 'AMS'] as const) {
    const other = calendars[exchange];
    if (reference.open !== other.open || reference.close !== other.close) fail('EXCHANGE_MISMATCH');
    const years = reference.years.filter((year) => other.years.includes(year));
    const holidays = (calendar: Calendar) =>
      [...calendar.holidays].filter((date) => years.includes(Number(date.slice(0, 4)))).sort();
    if (JSON.stringify(holidays(reference)) !== JSON.stringify(holidays(other)))
      fail('EXCHANGE_MISMATCH');
    const dates = new Set([
      ...reference.early.keys(),
      ...other.early.keys(),
      ...reference.hours.keys(),
      ...other.hours.keys(),
    ]);
    for (const date of dates) {
      if (!years.includes(Number(date.slice(0, 4))) || reference.holidays.has(date)) continue;
      const hours = (calendar: Calendar) => [
        calendar.hours.get(date)?.open ?? calendar.open,
        calendar.hours.get(date)?.close ?? calendar.early.get(date) ?? calendar.close,
      ];
      if (JSON.stringify(hours(reference)) !== JSON.stringify(hours(other)))
        fail('EXCHANGE_MISMATCH');
    }
  }
}
const newYork = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function parts(at: number) {
  return Object.fromEntries(newYork.formatToParts(at).map((p) => [p.type, p.value]));
}
function localDate(at: number) {
  const p = parts(at);
  return `${p.year}-${p.month}-${p.day}`;
}
function instant(date: string, minute: number) {
  const utc = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  const p = parts(utc);
  const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  const result = utc + (utc - represented);
  if (
    localDate(result) !== date ||
    Number(parts(result).hour) * 60 + Number(parts(result).minute) !== minute
  )
    fail('SOURCE_SHAPE');
  return new Date(result).toISOString();
}
function sessions(calendar: Calendar, at: number) {
  let data: Session | undefined;
  let target: Session | undefined;
  let active = false;
  const day = Date.parse(`${localDate(at)}T00:00:00Z`);
  for (let offset = -1; offset <= 1; offset += 2) {
    for (let i = 0; i < 370; i++) {
      const current = new Date(day + i * offset * 86_400_000);
      const date = current.toISOString().slice(0, 10);
      if (!calendar.years.includes(current.getUTCFullYear())) fail('CALENDAR_RANGE');
      if ([0, 6].includes(current.getUTCDay()) || calendar.holidays.has(date)) continue;
      const session = {
        date,
        open: instant(date, calendar.hours.get(date)?.open ?? calendar.open),
        close: instant(
          date,
          calendar.hours.get(date)?.close ?? calendar.early.get(date) ?? calendar.close,
        ),
      };
      if (Date.parse(session.open) >= Date.parse(session.close)) fail('SOURCE_SHAPE');
      if (at >= Date.parse(session.open) && at < Date.parse(session.close)) active = true;
      if (offset === -1 && Date.parse(session.close) <= at) {
        data = session;
        break;
      }
      if (offset === 1 && Date.parse(session.open) > at) {
        target = session;
        break;
      }
    }
  }
  if (!data || !target) fail('CALENDAR_RANGE');
  return { dataSession: data, targetSession: target, analysisEligible: !active };
}
function commonSchedule(calendars: Record<Exchange, Calendar>, at: number) {
  const schedule = sessions(calendars.NYS, at);
  for (const exchange of ['NAS', 'AMS'] as const)
    if (JSON.stringify(schedule) !== JSON.stringify(sessions(calendars[exchange], at)))
      fail('EXCHANGE_MISMATCH');
  checkDeferred(schedule.targetSession);
  return schedule;
}
try {
  const rawArgs = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 2) {
    if (
      !['--at', '--auth-dir', '--model'].includes(rawArgs[index]) ||
      !rawArgs[index + 1] ||
      options.has(rawArgs[index])
    )
      fail('USAGE');
    options.set(rawArgs[index], rawArgs[index + 1]);
  }
  const directory = options.get('--auth-dir');
  const model = options.get('--model');
  if (!directory?.startsWith('/') || !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? '')) fail('USAGE');
  const args = options.has('--at') ? ['--at', options.get('--at') as string] : [];
  if (
    args.length &&
    (args.length !== 2 ||
      args[0] !== '--at' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(args[1]) ||
      !Number.isFinite(Date.parse(args[1])))
  )
    fail('USAGE');
  if (
    args.length &&
    (Number(args[1].slice(11, 13)) > 23 ||
      Number(args[1].slice(14, 16)) > 59 ||
      Number(args[1].slice(17, 19)) > 59 ||
      new Date(`${args[1].slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
        args[1].slice(0, 10))
  )
    fail('USAGE');
  const fixed = args.length ? Date.parse(args[1]) : undefined;
  const nyse = nyseCalendar(await collect(nyseUrl));
  const nasdaq = nasdaqCalendar(
    await collect(nasdaqUrl),
    nasdaqHours(await collectBytes(nasdaqHoursUrl)),
  );
  for (const channel of [2, 1]) {
    const url = `https://www.nyse.com/api/notifications/public/system/${channel}/summaries/filter?pageSize=100&pageNumber=0&sortKey=publishedDate&sortOrder=desc`;
    nyseNotices(await collect(url), channel, url);
  }
  const rss = await collect(rssUrl);
  await nasdaqNotices(rss);
  const calendars = {
    NAS: nasdaq,
    NYS: nyse,
    AMS: {
      ...nyse,
      holidays: new Set(nyse.holidays),
      early: new Map(nyse.early),
      hours: new Map(),
    },
  };
  activeSource = undefined;
  activeNotice = undefined;
  const assessment = await assessCalendarNotices(
    notices,
    directory,
    model as string,
    300_000 - (performance.now() - startedAt),
  );
  if (assessment.assessments.length !== notices.length) fail('MODEL_OUTPUT');
  applyNotices(calendars, assessment.assessments);
  checkAgreement(calendars);
  let at = fixed ?? Date.now();
  let schedule = commonSchedule(calendars, at);
  const outputAt = fixed ?? Date.now();
  if (outputAt !== at) {
    at = outputAt;
    schedule = commonSchedule(calendars, at);
  }
  if (performance.now() - startedAt >= 300_000) fail('EXECUTION_LIMIT');
  console.log(
    assessment.safe({
      evaluatedAt: new Date(at).toISOString(),
      timeZone: 'America/New_York',
      calendarCoverage: {
        NAS: { years: nasdaq.years, calendarUrl: nasdaqUrl, hoursUrl: nasdaqHoursUrl },
        NYS: { years: nyse.years, calendarUrl: nyseUrl },
        AMS: { years: nyse.years, calendarUrl: nyseUrl },
      },
      ...schedule,
      noticeCompleteness: 'unverified',
      noticeCollections,
      scheduleChanges,
      deferredNotices,
      noticeAssessment: assessment.provenance,
      noticeAssessments: assessment.assessments.map((record) => ({
        ...record,
        url: notices.find((notice) => notice.id === record.id)?.url,
      })),
      sources,
    }),
  );
} catch (error) {
  const safe = [
    'USAGE',
    'SOURCE_SHAPE',
    'SOURCE_HTTP_FAILURE',
    'CALENDAR_RANGE',
    'EXCHANGE_MISMATCH',
    'NOTICE_UNRESOLVED',
    'COLLECTION_LIMIT',
    'XML_PARSER_UNAVAILABLE',
    'PDF_PARSER_UNAVAILABLE',
    'MODEL_OUTPUT',
    'MODEL_INCOMPLETE',
    'MODEL_LIMIT',
    'MODEL_INPUT_LIMIT',
    'MODEL_FAILED',
    'MODEL_UNAVAILABLE',
    'AUTH_FAILED',
    'SUBSCRIPTION_LIMIT',
    'SENSITIVE_OUTPUT',
    'EXECUTION_LIMIT',
  ];
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && safe.includes(error.message) ? error.message : 'REQUEST_FAILED',
      source: activeSource,
      notice: activeNotice,
    }),
  );
  process.exitCode = 1;
}
