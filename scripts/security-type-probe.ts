import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

type Security = {
  exchange: string;
  symbol: string;
  kisObservedAt: string;
  identifiers: Record<string, string>;
  kisFields: Record<string, string>;
};

function object(value: unknown, code = 'INPUT_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown) {
  const parts =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
          value,
        )
      : null;
  if (
    !parts ||
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    Number(parts[1]) < 1970 ||
    Number(parts[2]) < 1 ||
    Number(parts[2]) > 12 ||
    Number(parts[3]) < 1 ||
    Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 23 ||
    Number(parts[9] ?? 0) > 59
  )
    throw new Error('INPUT_INVALID');
  return value;
}

function inputs(paths: string[]) {
  if (!paths.length) throw new Error('USAGE');
  if (paths.length > limits.maxInputFiles) throw new Error('INPUT_LIMIT');
  const securities: Security[] = [];
  const knownIdentifiers = new Map<string, string>();
  for (const path of paths) {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error('INPUT_INVALID');
    if (info.size > limits.maxInputFileBytes) throw new Error('INPUT_LIMIT');
    const record = object(JSON.parse(readFileSync(path, 'utf8')));
    const receivedAt = timestamp(record.receivedAt);
    const isMaster =
      record.request === undefined && record.columns === 24 && record.encoding === 'cp949';
    if (!isMaster && Date.parse(timestamp(record.requestedAt)) > Date.parse(receivedAt))
      throw new Error('INPUT_INVALID');
    const request = isMaster ? {} : object(record.request);
    const params = isMaster ? {} : object(request.params);
    const isInfo = request.path === '/uapi/overseas-price/v1/quotations/search-info';
    if (
      !isMaster &&
      !isInfo &&
      ![
        '/uapi/overseas-stock/v1/ranking/trade-vol',
        '/uapi/overseas-stock/v1/ranking/trade-pbmn',
      ].includes(String(request.path))
    )
      throw new Error('INPUT_INVALID');
    const exchange = isInfo
      ? ({ '512': 'NAS', '513': 'NYS', '529': 'AMS' } as Record<string, string>)[
          String(params.PRDT_TYPE_CD)
        ]
      : params.EXCD;
    if (!isMaster && (typeof exchange !== 'string' || !['NAS', 'NYS', 'AMS'].includes(exchange)))
      throw new Error('INPUT_INVALID');
    if (!Array.isArray(record.rows) || !record.rows.length || (isInfo && record.rows.length !== 1))
      throw new Error('INPUT_INVALID');
    if (record.rows.length > limits.maxSecurities) throw new Error('INPUT_LIMIT');
    for (const value of record.rows) {
      const row = object(value);
      const rowExchange = isMaster ? row.exchangeCode : exchange;
      const symbol = isMaster ? row.symbol : isInfo ? params.PDNO : row.symb;
      if (
        typeof rowExchange !== 'string' ||
        !['NAS', 'NYS', 'AMS'].includes(rowExchange) ||
        typeof symbol !== 'string' ||
        !/^[A-Z0-9./^-]{1,20}$/.test(symbol) ||
        (row.excd !== undefined && row.excd !== exchange)
      )
        throw new Error('INPUT_INVALID');
      const identifiers: Record<string, string> = {};
      for (const key of ['std_pdno', 'istt_usge_isin_cd', 'sedol_no']) {
        const value = row[key];
        if (value === undefined || value === '') continue;
        if (typeof value !== 'string' || !/^[A-Z0-9]{1,20}$/.test(value))
          throw new Error('INPUT_INVALID');
        identifiers[key] = value;
      }
      for (const [key, value] of Object.entries(identifiers)) {
        const semanticKey =
          key === 'istt_usge_isin_cd' ||
          (key === 'std_pdno' && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value))
            ? 'ISIN'
            : key;
        for (const comparisonKey of new Set([key, semanticKey])) {
          const identity = JSON.stringify([rowExchange, symbol, comparisonKey]);
          const previous = knownIdentifiers.get(identity);
          if (previous && previous !== value) throw new Error('IDENTITY_AMBIGUOUS');
          knownIdentifiers.set(identity, value);
        }
      }
      const kisFields: Record<string, string> = {};
      for (const key of ['ovrs_stck_dvsn_cd', 'securityType', 'dr', 'etpType']) {
        const value = row[key];
        if (value === undefined) continue;
        if (
          typeof value !== 'string' ||
          !(key === 'dr' ? /^[NY]$/ : key === 'etpType' ? /^(?:\d{3}| {0,3})$/ : /^\d{1,2}$/).test(
            value,
          )
        )
          throw new Error('INPUT_INVALID');
        kisFields[key] = value;
      }
      if (securities.length >= limits.maxSecurities) throw new Error('INPUT_LIMIT');
      securities.push({
        exchange: rowExchange,
        symbol,
        kisObservedAt: receivedAt,
        identifiers,
        kisFields,
      });
    }
  }
  return securities;
}

const limits = {
  maxInputFiles: 20,
  maxInputFileBytes: 2_000_000,
  maxSecurities: 1000,
  maxRequests: 40,
  maxResponseBytes: 32_000_000,
  maxTotalBytes: 64_000_000,
  maxRunMs: 120_000,
  requestTimeoutMs: 15_000,
  requestIntervalMs: 150,
};
const sources: { url: string; receivedAt: string; sha256: string; bytes: number }[] = [];
const cache = new Map<string, string>();
const deadline = Date.now() + limits.maxRunMs;
let totalBytes = 0;
let failedSource: { url: string; status?: number } | undefined;
let activeSource: { url: string; status?: number } | undefined;

async function collect(url: string) {
  const saved = cache.get(url);
  activeSource = { url, status: saved === undefined ? undefined : 200 };
  if (saved !== undefined) return saved;
  if (sources.length >= limits.maxRequests || Date.now() >= deadline)
    throw new Error('COLLECTION_LIMIT');
  if (sources.length) await setTimeout(limits.requestIntervalMs);
  if (Date.now() >= deadline) throw new Error('COLLECTION_LIMIT');
  try {
    failedSource = { url };
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'StockScout/0.1 (+https://github.com/mochafreddo/stock-scout)',
        Accept: 'application/json, application/xml;q=0.9',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(limits.requestTimeoutMs, deadline - Date.now())),
      ),
    });
    activeSource = { url, status: response.status };
    failedSource = activeSource;
    if (response.status !== 200) throw new Error('SOURCE_HTTP_FAILURE');
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limits.maxResponseBytes)
    )
      throw new Error('COLLECTION_LIMIT');
    if (!response.body) throw new Error('SOURCE_SHAPE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        totalBytes += part.value.byteLength;
        if (
          bytes > limits.maxResponseBytes ||
          totalBytes > limits.maxTotalBytes ||
          Date.now() >= deadline
        ) {
          await reader.cancel();
          throw new Error('COLLECTION_LIMIT');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (
      declared !== null &&
      !response.headers.has('content-encoding') &&
      Number(declared) !== bytes
    )
      throw new Error('SOURCE_SHAPE');
    const buffer = Buffer.concat(chunks);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    sources.push({
      url,
      receivedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes,
    });
    cache.set(url, text);
    failedSource = undefined;
    return text;
  } catch (error) {
    if (
      error instanceof Error &&
      ['COLLECTION_LIMIT', 'SOURCE_HTTP_FAILURE', 'SOURCE_SHAPE'].includes(error.message)
    )
      throw error;
    throw new Error('SOURCE_REQUEST_FAILED');
  }
}

async function json(url: string) {
  const text = await collect(url);
  try {
    return object(JSON.parse(text), 'SOURCE_SHAPE');
  } catch {
    throw new Error('SOURCE_SHAPE');
  }
}

function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error('SOURCE_SHAPE');
  return value;
}

function structuredEvidence(source: string, symbol: string, exchange: string, cik: number) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SOURCE_XML_FAILURE');
  // TODO: #250 - Repeated XPath calls reparse the instance; parse once if measured document scale exceeds this probe's CPU budget.
  const xml = (expression: string) => {
    if (Date.now() >= deadline) throw new Error('COLLECTION_LIMIT');
    const result = spawnSync(
      '/usr/bin/xmllint',
      ['--nonet', '--nocatalogs', '--xpath', expression, '-'],
      {
        input: source,
        encoding: 'utf8',
        timeout: Math.max(1, Math.min(3000, deadline - Date.now())),
        maxBuffer: 1_000_000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT')
      throw new Error('XML_PARSER_UNAVAILABLE');
    if (result.status !== 0 || result.error || result.stderr.trim())
      throw new Error('SOURCE_XML_FAILURE');
    return result.stdout.replace(/\n$/, '');
  };
  const count = (expression: string, maximum = 50) => {
    const value = Number(xml(`count(${expression})`));
    if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error('SOURCE_SHAPE');
    return value;
  };
  const xbrl = 'http://www.xbrl.org/2003/instance';
  const root = `/*[local-name()='xbrl' and namespace-uri()='${xbrl}']`;
  if (count(root) !== 1) throw new Error('SOURCE_XML_FAILURE');
  const symbols = `${root}/*[local-name()='TradingSymbol' and (starts-with(namespace-uri(),'http://xbrl.sec.gov/dei/') or starts-with(namespace-uri(),'https://xbrl.sec.gov/dei/')) and normalize-space(.)='${symbol}']`;
  const evidence = [];
  const contexts = new Set<string>();
  for (let index = 1, length = count(symbols, 20); index <= length; index++) {
    const [namespace, contextRef] = xml(
      `concat(namespace-uri((${symbols})[${index}]),'\t',string((${symbols})[${index}]/@contextRef))`,
    ).split('\t');
    if (!namespace || !/^https?:\/\/xbrl\.sec\.gov\/dei\/\d{4}(?:-\d{2}-\d{2})?$/.test(namespace))
      continue;
    if (!contextRef || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,150}$/.test(contextRef))
      throw new Error('SOURCE_SHAPE');
    if (contexts.has(`${namespace}|${contextRef}`)) continue;
    contexts.add(`${namespace}|${contextRef}`);
    const context = `${root}/*[local-name()='context' and namespace-uri()='${xbrl}' and @id='${contextRef}']`;
    if (count(context) !== 1) throw new Error('SOURCE_SHAPE');
    const fact = (name: string) =>
      `${root}/*[local-name()='${name}' and namespace-uri()='${namespace}' and @contextRef='${contextRef}']`;
    const values = (name: string) => {
      const expression = fact(name);
      const values: string[] = [];
      for (let n = 1, length = count(expression, 10); n <= length; n++) {
        const value = xml(`normalize-space((${expression})[${n}])`);
        if (value.length > 2000) throw new Error('SOURCE_SHAPE');
        values.push(value);
      }
      return [...new Set(values)];
    };
    const contextSymbols = values('TradingSymbol');
    const exchanges = values('SecurityExchangeName');
    if (contextSymbols.length !== 1 || contextSymbols[0] !== symbol || exchanges.length > 1)
      throw new Error('IDENTITY_AMBIGUOUS');
    if (!exchanges.length || exchanges[0]?.toUpperCase() !== exchange.toUpperCase()) continue;
    const child = (name: string) => `*[local-name()='${name}' and namespace-uri()='${xbrl}']`;
    const entity = `${context}/${child('entity')}/${child('identifier')}`;
    const period = `${context}/${child('period')}`;
    if (count(entity) !== 1 || count(period) !== 1) throw new Error('SOURCE_SHAPE');
    const [instants, starts, ends] = ['instant', 'startDate', 'endDate'].map((name) =>
      count(`${period}/${child(name)}`),
    );
    const periodChildren = count(`${period}/*`);
    const instantPeriod = instants === 1 && starts === 0 && ends === 0 && periodChildren === 1;
    const durationPeriod = instants === 0 && starts === 1 && ends === 1 && periodChildren === 2;
    if (!instantPeriod && !durationPeriod) throw new Error('SOURCE_SHAPE');
    const [entityId, scheme, instant, start, end] = xml(
      `concat(normalize-space(${entity}),'\t',string(${entity}/@scheme),'\t',normalize-space(${period}/${child('instant')}),'\t',normalize-space(${period}/${child('startDate')}),'\t',normalize-space(${period}/${child('endDate')}),'\tEND')`,
    ).split('\t');
    if (
      !entityId ||
      !/^\d{1,10}$/.test(entityId) ||
      Number(entityId) !== cik ||
      scheme !== 'http://www.sec.gov/CIK'
    )
      throw new Error('IDENTITY_AMBIGUOUS');
    if (durationPeriod && date(start) > date(end)) throw new Error('SOURCE_SHAPE');
    const observedPeriod = instantPeriod
      ? { instant: date(instant) }
      : { startDate: date(start), endDate: date(end) };
    const members = `${context}//*[local-name()='explicitMember' and namespace-uri()='http://xbrl.org/2006/xbrldi']`;
    const dimensions: { axis: string; member: string }[] = [];
    const expand = (node: string, value: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*:[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
        throw new Error('SOURCE_SHAPE');
      const [prefix, local] = value.split(':');
      const uri = xml(`string(${node}/namespace::*[name()='${prefix}'])`);
      if (!uri || uri.length > 500 || /[{}\s]/.test(uri)) throw new Error('SOURCE_SHAPE');
      return `{${uri}}${local}`;
    };
    for (let n = 1, length = count(members, 8); n <= length; n++) {
      const member = `(${members})[${n}]`;
      const [axisQName, memberQName] = xml(
        `concat(string(${member}/@dimension),'\t',normalize-space(${member}))`,
      ).split('\t');
      if (!axisQName || !memberQName) throw new Error('SOURCE_SHAPE');
      dimensions.push({ axis: expand(member, axisQName), member: expand(member, memberQName) });
    }
    const typedDimensions = count(
      `${context}//*[local-name()='typedMember' and namespace-uri()='http://xbrl.org/2006/xbrldi']`,
      8,
    );
    for (const title of values('Security12bTitle')) {
      let reportedType = 'unknown';
      if (/^American Depositary (Shares|Receipts)\b/i.test(title)) {
        const classes = dimensions.filter((dimension) =>
          /^\{https?:\/\/xbrl\.ifrs\.org\/taxonomy\/\d{4}-\d{2}-\d{2}\/ifrs-full\}ClassesOfShareCapitalAxis$/.test(
            dimension.axis,
          ),
        );
        if (classes.length === 1 && !typedDimensions) {
          const dimension = classes[0];
          const uri = dimension?.axis.slice(0, dimension.axis.indexOf('}') + 1);
          if (dimension?.member === `${uri}OrdinarySharesMember`) reportedType = 'adr_common';
          if (dimension?.member === `${uri}PreferenceSharesMember`) reportedType = 'adr_preferred';
        }
      } else if (/^(?:Redeemable )?Warrants?\b|^Common Stock Purchase Warrants?\b/i.test(title))
        reportedType = 'warrant';
      else if (
        /^(?:Class [A-Za-z0-9-]+ )?(?:Common (?:Stock|Shares)|Ordinary Shares|Subordinate Voting Shares)\b/i.test(
          title,
        ) &&
        !/\b(?:Warrants?|Preferred|Preference|Depositary|Depository|Units?|Notes?)\b/i.test(title)
      )
        reportedType = 'common';
      else if (/^Class [A-Za-z0-9-]+ Capital Stock\b/i.test(title)) reportedType = 'capital_stock';
      else if (/\b(?:Preferred|Preference) (?:Stock|Shares)\b/i.test(title))
        reportedType = 'preferred';
      else if (/^Exchange[- ]Traded Notes?\b/i.test(title)) reportedType = 'etn';
      else if (/^Exchange[- ]Traded (?:Fund|Shares)\b/i.test(title)) reportedType = 'etf';
      evidence.push({
        contextRef,
        namespace,
        tradingSymbol: symbol,
        exchange: exchanges[0],
        title,
        period: observedPeriod,
        dimensions,
        reportedType,
      });
    }
  }
  return evidence;
}

async function observe(security: Security, directory: Record<string, unknown>) {
  const unknown = (reason: string) => ({
    ...security,
    reportedType: 'unknown',
    instrumentType: 'unverified',
    reason,
    currentness: 'unverified',
  });
  if (
    !Array.isArray(directory.fields) ||
    directory.fields.join(',') !== 'cik,name,ticker,exchange' ||
    !Array.isArray(directory.data) ||
    directory.data.length > 50_000
  )
    throw new Error('SOURCE_SHAPE');
  const rows = directory.data.map((row: unknown) => {
    if (
      !Array.isArray(row) ||
      row.length !== 4 ||
      !Number.isSafeInteger(row[0]) ||
      row[0] < 1 ||
      row[0] > 9_999_999_999 ||
      typeof row[2] !== 'string' ||
      (typeof row[3] !== 'string' && row[3] !== null)
    )
      throw new Error('SOURCE_SHAPE');
    return row;
  });
  const matches = rows.filter((row) => row[2] === security.symbol);
  if (!matches.length) return unknown('NO_SEC_TICKER_MATCH');
  const expectedExchange =
    security.exchange === 'NAS' ? 'Nasdaq' : security.exchange === 'NYS' ? 'NYSE' : null;
  if (!expectedExchange) return unknown('EXCHANGE_LINK_UNSUPPORTED');
  const linked = matches.filter((row) => row[3] === expectedExchange);
  if (!linked.length) return unknown('EXCHANGE_LINK_UNSUPPORTED');
  if (linked.length !== 1) throw new Error('IDENTITY_AMBIGUOUS');
  const cik = linked[0][0] as number;
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
  const submission = await json(submissionsUrl);
  if (
    Number(submission.cik) !== cik ||
    !Array.isArray(submission.tickers) ||
    !submission.tickers.includes(security.symbol) ||
    !Array.isArray(submission.exchanges) ||
    !submission.exchanges.includes(expectedExchange)
  )
    throw new Error('IDENTITY_AMBIGUOUS');
  const filings = object(submission.filings, 'SOURCE_SHAPE');
  const recent = object(filings.recent, 'SOURCE_SHAPE');
  const keys = ['accessionNumber', 'filingDate', 'reportDate', 'form', 'primaryDocument'];
  const columns = keys.map((key) => recent[key]);
  if (
    !columns.every(
      (column) => Array.isArray(column) && column.length === (columns[0] as unknown[]).length,
    ) ||
    (columns[0] as unknown[]).length > 10_000
  )
    throw new Error('SOURCE_SHAPE');
  const records = (columns[0] as unknown[]).map((_, index) => {
    const row = Object.fromEntries(keys.map((key) => [key, (recent[key] as unknown[])[index]]));
    date(row.filingDate);
    if (
      typeof row.form !== 'string' ||
      typeof row.accessionNumber !== 'string' ||
      !/^\d{10}-\d{2}-\d{6}$/.test(row.accessionNumber)
    )
      throw new Error('SOURCE_SHAPE');
    return row;
  });
  const annuals = records
    .filter((row) =>
      ['10-K', '20-F', '40-F', '10-K/A', '20-F/A', '40-F/A'].includes(String(row.form)),
    )
    .sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate)));
  const latest = annuals[0];
  if (!latest) return { ...unknown('ANNUAL_FILING_NOT_IN_RECENT_HISTORY'), issuer: { cik } };
  if (String(latest.form).endsWith('/A'))
    return { ...unknown('ANNUAL_AMENDMENT_UNSUPPORTED'), issuer: { cik } };
  if (
    typeof latest.primaryDocument !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.html?$/.test(latest.primaryDocument) ||
    latest.primaryDocument.includes('..')
  )
    throw new Error('SOURCE_SHAPE');
  date(latest.reportDate);
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${String(latest.accessionNumber).replaceAll('-', '')}`;
  const index = await json(`${base}/index.json`);
  const items = object(index.directory, 'SOURCE_SHAPE').item;
  if (!Array.isArray(items) || items.length > 10_000) throw new Error('SOURCE_SHAPE');
  const instances = items
    .map((item) => {
      const name = object(item, 'SOURCE_SHAPE').name;
      if (typeof name !== 'string' || !name.trim()) throw new Error('SOURCE_SHAPE');
      return name;
    })
    .filter(
      (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}_htm\.xml$/.test(name) && !name.includes('..'),
    );
  if (!instances.length) return { ...unknown('EXTRACTED_INSTANCE_UNSUPPORTED'), issuer: { cik } };
  if (instances.length !== 1) throw new Error('IDENTITY_AMBIGUOUS');
  const instanceUrl = `${base}/${instances[0]}`;
  const instance = await collect(instanceUrl);
  const evidence = structuredEvidence(instance, security.symbol, expectedExchange, cik);
  const types = new Set(evidence.map((entry) => entry.reportedType));
  const reportedType = types.size === 1 ? (evidence[0]?.reportedType ?? 'unknown') : 'unknown';
  const kisType = security.kisFields.ovrs_stck_dvsn_cd;
  const conflict =
    reportedType !== 'unknown' &&
    ((kisType === '02' && reportedType !== 'warrant') ||
      (kisType === '03' && reportedType !== 'etf') ||
      (kisType === '04' && !['preferred', 'adr_preferred'].includes(reportedType)));
  const reason = conflict
    ? 'KIS_TYPE_CONFLICT'
    : types.size > 1
      ? 'CONFLICTING_SEC_CONTEXT'
      : reportedType === 'common'
        ? security.kisFields.dr === 'Y'
          ? 'DEPOSITARY_LINK_UNRESOLVED'
          : 'DIRECT_OR_UNDERLYING_RIGHT_UNRESOLVED'
        : reportedType === 'unknown'
          ? 'STRUCTURED_RIGHTS_UNSUPPORTED'
          : 'HISTORICAL_SEC_CONTEXT_ONLY';
  return {
    ...unknown(reason),
    reportedType: conflict ? 'unknown' : reportedType,
    issuer: { cik },
    filing: { ...latest, instanceUrl },
    evidence,
    coverage: {
      laterRecentFilings: records.filter(
        (row) => String(row.filingDate) > String(latest.filingDate),
      ).length,
      olderHistoryInspected: false,
      subsequentRightsChangesVerified: false,
    },
  };
}

try {
  let securities: Security[];
  try {
    securities = inputs(process.argv.slice(2));
  } catch (error) {
    if (
      error instanceof Error &&
      ['USAGE', 'INPUT_LIMIT', 'IDENTITY_AMBIGUOUS'].includes(error.message)
    )
      throw error;
    throw new Error('INPUT_INVALID');
  }
  const directory = await json('https://www.sec.gov/files/company_tickers_exchange.json');
  const observations = [];
  for (const security of securities) observations.push(await observe(security, directory));
  console.error(
    JSON.stringify({
      error: 'CURRENTNESS_UNVERIFIED',
      validation: 'unverified',
      runtimeEligible: false,
      sourcePolicy: 'SEC historical observations only',
      observations,
      sources,
      limits,
    }),
  );
  process.exitCode = 1;
} catch (error) {
  const safe = [
    'USAGE',
    'INPUT_INVALID',
    'INPUT_LIMIT',
    'SOURCE_SHAPE',
    'SOURCE_XML_FAILURE',
    'XML_PARSER_UNAVAILABLE',
    'SOURCE_REQUEST_FAILED',
    'SOURCE_HTTP_FAILURE',
    'COLLECTION_LIMIT',
    'IDENTITY_AMBIGUOUS',
  ];
  if (
    !failedSource &&
    error instanceof Error &&
    ['SOURCE_SHAPE', 'SOURCE_XML_FAILURE'].includes(error.message)
  )
    failedSource = activeSource;
  console.error(
    JSON.stringify({
      error:
        error instanceof Error && safe.includes(error.message) ? error.message : 'PROBE_FAILED',
      validation: 'unverified',
      runtimeEligible: false,
      sources,
      failedSource,
      limits,
    }),
  );
  process.exitCode = 1;
}
