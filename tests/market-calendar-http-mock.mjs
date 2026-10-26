import { appendFileSync, readFileSync } from 'node:fs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/market-calendar/${name}.html.txt`, import.meta.url), 'utf8');
const scenario = process.env.SCENARIO || 'ok';
const closureDate = process.env.CLOSURE_DATE || 'Monday, October 26, 2026';
function hoursPdf() {
  const stream = `BT /F1 12 Tf 40 750 Td (Nasdaq Trading Hours of Operation) Tj 0 -20 Td (Market Open: ${scenario === 'guide-hours-mismatch' ? '10:00' : '9:30'} a.m., ET) Tj 0 -20 Td (Market Close: 4:00 p.m., ET) Tj 0 -20 Td (System Hours: 4:00 a.m. to 8:00 p.m., ET) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
Date.now = () => Date.parse(process.env.TEST_NOW || '2026-10-26T06:00:00Z');
globalThis.fetch = async (url, options) => {
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url, method: options?.method || 'GET' })}\n`,
  );
  const address = new URL(url);
  if (scenario === 'transport-failure') throw new Error('PRIVATE-TRANSPORT-CONTENT');
  if (scenario === 'http-failure') return new Response('PRIVATE-HTTP-CONTENT', { status: 503 });
  if (scenario === 'oversize') return new Response('x'.repeat(2_000_001));
  if (address.pathname === '/TraderNews.aspx' && address.searchParams.get('id') === 'ETA2026-1')
    return new Response(
      `<html><body><div id="MainContainer"><div class="genTableNews"><table><tr><th>Category: Equity Alert. Contact information.</th><td><p>${process.env.NASDAQ_BODY || (['closure', 'correction', 'ambiguous-child', 'marked-closure'].includes(scenario) ? `Nasdaq U.S. equities and options markets will be closed on ${closureDate}, in observance of a National Day of Mourning.` : 'Nasdaq will begin listing and trading the following exchange-traded funds: Example ETF (TEST).')}</p></td></tr></table></div></div></body></html>`,
    );
  if (address.pathname.endsWith('/oe_refguide.pdf')) return new Response(hoursPdf());
  if (address.hostname === 'www.nyse.com' && address.pathname === '/trade/hours-calendars')
    return new Response(
      scenario === 'ams-hours'
        ? fixture('nyse').replace(
            'NYSE American</button><div><p>Core Trading Session: 9:30',
            'NYSE American</button><div><p>Core Trading Session: 9:45',
          )
        : scenario === 'footnote-weekday'
          ? fixture('nyse').replace('Friday, November 27, 2026', 'Monday, November 27, 2026')
          : fixture('nyse'),
    );
  if (address.hostname === 'www.nasdaqtrader.com' && address.searchParams.get('id') === 'Calendar')
    return new Response(
      scenario === 'mismatch'
        ? fixture('nasdaq').replace(/1:00 p.m./g, '2:00 p.m.')
        : ['correction', 'ambiguous-child'].includes(scenario)
          ? fixture('nasdaq').replace(
              '<tbody>',
              '<tbody><tr><td>October 27, 2026</td><td>Additional official holiday</td><td>Closed</td></tr>',
            )
          : fixture('nasdaq'),
    );
  if (address.hostname === 'www.nyse.com' && address.pathname.includes('/summaries/filter')) {
    const data =
      scenario === 'snapshot'
        ? [
            {
              id: 100,
              publishedDate: 1792706400000,
              subject: 'Options notice',
              body: '<p>NYSE American Options is introducing new option series.</p>',
              marketLinks: ['NYSE AMERICAN OPTIONS'],
              childNotifications: [
                {
                  publishedDate: 1792710000000,
                  subject: 'Options update',
                  body: '<p>The options series update is complete.</p>',
                },
              ],
            },
          ]
        : ['closure', 'correction', 'ambiguous-child', 'marked-closure'].includes(scenario) &&
            address.pathname.includes('/system/1/')
          ? [
              {
                id: 101,
                publishedDate: 1792706400000,
                subject:
                  scenario === 'marked-closure'
                    ? 'Correction: replacement notice'
                    : 'Mourning closure',
                body: `<p>On ${closureDate}, The New York Stock Exchange, NYSE American Equities will close in observance of the National Day of Mourning.</p>`,
                marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
                childNotifications: ['correction', 'ambiguous-child'].includes(scenario)
                  ? [
                      {
                        publishedDate: 1792710000000,
                        subject:
                          scenario === 'correction' ? 'Correction: replacement date' : 'Update',
                        body: '<p>On Tuesday, October 27, 2026, The New York Stock Exchange, NYSE American Equities will close in observance of the National Day of Mourning.</p>',
                      },
                    ]
                  : [],
              },
            ]
          : [];
    if (scenario === 'unknown-notice')
      data.push({
        id: 102,
        publishedDate: 1792706400000,
        subject: 'Notice',
        body: '<p>Important market changes. Details to follow.</p>',
        marketLinks: ['NYSE'],
        childNotifications: [],
      });
    if (process.env.NYSE_BODY && address.pathname.includes('/system/1/'))
      data.push({
        id: 103,
        publishedDate: 1792706400000,
        subject: 'Informational notice',
        body: `<p>${process.env.NYSE_BODY}</p>`,
        marketLinks:
          scenario === 'trailing-market' ? ['NYSE '] : ['NYSE', 'NYSE AMERICAN EQUITIES'],
        childNotifications: process.env.NYSE_CHILD
          ? [
              {
                publishedDate: 1792710000000,
                subject: 'Update',
                body: `<p>${process.env.NYSE_CHILD}</p>`,
              },
            ]
          : [],
      });
    return Response.json({
      data,
      totalCount: scenario === 'truncated-nyse' ? 1 : data.length,
      oldestPublishedYear: 2006,
    });
  }
  if (address.hostname === 'www.nasdaqtrader.com' && address.pathname === '/rss.aspx') {
    if (scenario === 'final-open') Date.now = () => Date.parse('2026-10-26T13:30:00Z');
    if (scenario === 'calculation-open') {
      let reads = 0;
      Date.now = () => Date.parse(++reads <= 2 ? '2026-10-26T13:29:59Z' : '2026-10-26T13:30:00Z');
    }
    if (scenario === 'final-year') Date.now = () => Date.parse('2027-01-01T05:00:00Z');
    const item = [
      'snapshot',
      'closure',
      'article',
      'correction',
      'ambiguous-child',
      'marked-closure',
      'marked-expansion',
    ].includes(scenario)
      ? `<item><title>${scenario === 'marked-expansion' ? 'Correction: expansion date' : 'Equity alert'}</title><pubDate>Fri, 23 Oct 2026 18:00:00 GMT</pubDate><link>http://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2026-1</link><Markets>The Nasdaq Stock Market</Markets></item>`
      : '';
    return new Response(
      `<rss version="2.0"><channel><title>Nasdaq News</title>${item}</channel></rss>`,
    );
  }
  throw new Error(`Unexpected external request: ${url}`);
};
