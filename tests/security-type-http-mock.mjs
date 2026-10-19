import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

const tickerRows = [
  [1000, 'Example', 'AAPL', 'Nasdaq'],
  [1001, 'Example foreign issuer', 'BBD', 'NYSE'],
  [1001, 'Example foreign issuer', 'BBDO', 'NYSE'],
  [1002, 'Another issuer', 'GOOG', 'Nasdaq'],
  [1002, 'Another issuer', 'GOOGL', 'Nasdaq'],
  [1003, 'Underlying title counterexample', 'TSM', 'NYSE'],
  [1004, 'Unseen issuer', 'ZZGENERIC', 'Nasdaq'],
  [1005, 'Punctuation counterexample', 'BAC-B', 'NYSE'],
  [1006, 'Exchange counterexample', 'SPY', 'NYSE'],
];

function instance(cik) {
  const rows =
    cik === 1001
      ? [
          ['BBD', 'American Depositary Shares', 'NYSE', 'PreferenceSharesMember'],
          ['BBDO', 'American Depositary Shares', 'NYSE', 'OrdinarySharesMember'],
        ]
      : cik === 1003
        ? [['TSM', 'Common Shares', 'NYSE']]
        : cik === 1002
          ? [
              ['GOOG', 'Class C Capital Stock', 'NASDAQ'],
              ['GOOGL', 'Class A Common Stock', 'NASDAQ'],
            ]
          : cik === 1004
            ? [['ZZGENERIC', 'Class A Common Stock', 'NASDAQ']]
            : [['AAPL', 'Common Stock, $0.001 par value', 'NASDAQ']];
  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
 xmlns:dei="http://xbrl.sec.gov/dei/2025" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
 xmlns:rights="https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full">
 ${rows
   .map(
     ([symbol, title, exchange, member], index) => `
 <xbrli:context id="security${index}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">${cik}</xbrli:identifier>${member ? `<xbrli:segment><xbrldi:explicitMember dimension="rights:ClassesOfShareCapitalAxis">rights:${member}</xbrldi:explicitMember></xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context>
 <dei:TradingSymbol contextRef="security${index}">${symbol}</dei:TradingSymbol>
 <dei:SecurityExchangeName contextRef="security${index}">${exchange}</dei:SecurityExchangeName>
 <dei:Security12bTitle contextRef="security${index}">${title}</dei:Security12bTitle>`,
   )
   .join('')}
</xbrli:xbrl>`;
}

globalThis.fetch = async (url, options) => {
  const request = new URL(url);
  appendFileSync(process.env.TEST_TRACE, `${request.href}\n`);
  assert.ok(['https://www.sec.gov', 'https://data.sec.gov'].includes(request.origin));
  assert.equal(options.redirect, 'error');
  assert.equal(
    options.headers['User-Agent'],
    'StockScout/0.1 (+https://github.com/mochafreddo/stock-scout)',
  );
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(options.headers), ['User-Agent', 'Accept']);
  const scenario = process.env.SCENARIO;
  if (scenario === 'deadline-during-interval')
    setTimeout(() => {
      Date.now = () => 9_000_000_000_000;
    }, 20);
  if (scenario === 'deadline') Date.now = () => 9_000_000_000_000;
  if (scenario === 'transport') throw new Error('remote-secret');
  if (process.env.SCENARIO === 'http') return new Response('remote-secret', { status: 403 });
  if (scenario === 'rate-limit') return new Response('remote-secret', { status: 429 });
  if (process.env.SCENARIO === 'redirect') return new Response('', { status: 302 });
  if (scenario === 'bad-json') return new Response('remote-secret not JSON');
  if (scenario === 'declared-oversize')
    return new Response('', { headers: { 'Content-Length': '32000001' } });
  if (scenario === 'actual-oversize') return new Response(new Uint8Array(32_000_001));
  if (scenario === 'truncated') return new Response('{}', { headers: { 'Content-Length': '8' } });
  const rowsForDirectory =
    scenario === 'request-limit'
      ? Array.from({ length: 20 }, (_, i) => [5000 + i, 'Bulk', `GEN${i}`, 'Nasdaq'])
      : tickerRows;
  if (request.pathname === '/files/company_tickers_exchange.json') {
    const data =
      scenario === 'ambiguous-issuer'
        ? [...tickerRows, [2000, 'Other', 'AAPL', 'Nasdaq']]
        : rowsForDirectory;
    return Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data });
  }
  if (/^\/submissions\/CIK\d{10}\.json$/.test(request.pathname)) {
    const cik = Number(request.pathname.match(/CIK(\d+)/)[1]);
    const rows = rowsForDirectory.filter((row) => row[0] === cik);
    return Response.json({
      cik: String(cik),
      tickers: rows.map((row) => row[2]),
      exchanges: [...new Set(rows.map((row) => row[3]))],
      filings: {
        recent: {
          accessionNumber: ['0000001000-26-000001'],
          filingDate: ['2026-02-01'],
          reportDate: ['2025-12-31'],
          form: [scenario === 'amendment' ? '10-K/A' : '10-K'],
          primaryDocument: [scenario === 'unsafe-filing-path' ? '../private.htm' : 'example.htm'],
        },
        files: [],
      },
    });
  }
  if (request.pathname.endsWith('/index.json')) {
    const malformedItems = {
      'missing-index-name': {},
      'numeric-index-name': { name: 7 },
      'empty-index-name': { name: '' },
      'whitespace-index-name': { name: '   ' },
    };
    if (Object.hasOwn(malformedItems, scenario))
      return Response.json({
        directory: { item: [malformedItems[scenario]] },
      });
    const item = [
      { name: 'example.htm', type: 'text/html' },
      { name: 'example_htm.xml', type: 'text/xml' },
      { name: 'example_cal.xml', type: 'text/xml' },
    ];
    return Response.json({
      directory: {
        item:
          scenario === 'no-instance'
            ? item.filter((item) => !item.name.endsWith('_htm.xml'))
            : item,
      },
    });
  }
  if (request.pathname.endsWith('/example_htm.xml')) {
    let xml = instance(Number(request.pathname.split('/')[4]));
    const instant = '<xbrli:instant>2025-12-31</xbrli:instant>';
    if (scenario === 'duplicate-instant')
      xml = xml.replace(instant, `${instant}<xbrli:instant>2025-12-30</xbrli:instant>`);
    if (scenario === 'mixed-period')
      xml = xml.replace(
        instant,
        `${instant}<xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate>`,
      );
    if (scenario === 'reversed-period')
      xml = xml.replace(
        instant,
        '<xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate>',
      );
    if (scenario === 'valid-duration')
      xml = xml.replace(
        instant,
        '<xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate>',
      );
    if (scenario === 'cached-context-error')
      xml = xml.replace(
        /(<xbrli:context id="security1">[\s\S]*?)<xbrli:instant>2025-12-31<\/xbrli:instant>/,
        '$1<xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate>',
      );
    const titles = {
      'type-warrant': 'Warrants to purchase Common Stock',
      'type-preferred': '6.000% Non-Cumulative Preferred Stock, Series G',
      'type-etf': 'Exchange Traded Fund Shares',
      'type-etn': 'Exchange-Traded Notes due 2040',
      'unsupported-ads': 'American Depositary Shares',
      'purchase-warrant': 'Common Stock Purchase Warrants',
      'mixed-unit': 'Common Stock and Warrants',
    };
    if (titles[scenario]) xml = xml.replace('Common Stock, $0.001 par value', titles[scenario]);
    if (scenario === 'spoof-dei')
      xml = xml.replaceAll('http://xbrl.sec.gov/dei/2025', 'http://xbrl.sec.gov/dei/2025-evil');
    if (scenario === 'spoof-rights')
      xml = xml.replaceAll(
        'https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full',
        'https://example.invalid/ifrs-full',
      );
    if (scenario === 'missing-title')
      xml = xml.replace(/<dei:Security12bTitle[^>]*>.*?<\/dei:Security12bTitle>/g, '');
    if (scenario === 'wrong-context')
      xml = xml.replaceAll(
        'Security12bTitle contextRef="security0"',
        'Security12bTitle contextRef="unrelated"',
      );
    if (scenario === 'malformed-xml') xml = xml.replace('</xbrli:xbrl>', '');
    if (scenario === 'doctype')
      xml = xml.replace(
        '<xbrli:xbrl',
        '<!DOCTYPE xbrli:xbrl [<!ENTITY leak SYSTEM "file:///private/secret">]><xbrli:xbrl',
      );
    if (scenario === 'unsafe-context') xml = xml.replaceAll('security0', 'unsafe&apos;context');
    if (scenario === 'ambiguous-context')
      xml = xml.replace(
        '</xbrli:xbrl>',
        '<dei:TradingSymbol contextRef="security0">GOOG</dei:TradingSymbol></xbrli:xbrl>',
      );
    if (scenario === 'title-conflict')
      xml = xml.replace(
        '</xbrli:xbrl>',
        '<dei:Security12bTitle contextRef="security0">Preferred Stock</dei:Security12bTitle></xbrli:xbrl>',
      );
    return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
  }
  throw new Error('remote-secret unexpected request');
};
