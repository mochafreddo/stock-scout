const sourceCommit = '2077773a69a428daf63e148182511f068cc45de3';
const kinds = {
  volume: ['overseas-stock/v1/ranking/trade-vol', 'HHDFS76310010', 'trade_vol'],
  amount: ['overseas-stock/v1/ranking/trade-pbmn', 'HHDFS76320010', 'trade_pbmn'],
  daily: ['overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', 'dailyprice'],
  info: ['overseas-price/v1/quotations/search-info', 'CTPF1702R', 'search_info'],
} as const;
const fields = {
  summary: ['zdiv', 'stat', 'crec', 'trec', 'nrec', 'rsym'],
  ranking: [
    'rsym',
    'excd',
    'symb',
    'name',
    'ename',
    'rank',
    'last',
    'tvol',
    'tamt',
    'a_tvol',
    'a_tamt',
  ],
  daily: ['xymd', 'open', 'high', 'low', 'clos', 'tvol', 'tamt'],
  info: [
    'std_pdno',
    'prdt_eng_name',
    'natn_cd',
    'tr_mket_cd',
    'ovrs_excg_cd',
    'tr_crcy_cd',
    'ovrs_stck_dvsn_cd',
    'prdt_clsf_cd',
    'prdt_clsf_name',
    'prdt_type_cd_2',
    'ovrs_item_name',
    'sedol_no',
    'istt_usge_isin_cd',
    'lstg_yn',
    'last_rcvg_dtime',
  ],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('RESPONSE_SHAPE');
  return value as Record<string, unknown>;
}
function select(value: unknown, keys: string[]) {
  const row = object(value);
  return Object.fromEntries(
    keys.filter((key) => typeof row[key] === 'string').map((key) => [key, row[key]]),
  );
}

try {
  const [kind, exchange, symbol = '', ...extra] = process.argv.slice(2);
  if (
    !kind ||
    !Object.hasOwn(kinds, kind) ||
    !exchange ||
    !['NAS', 'NYS', 'AMS'].includes(exchange) ||
    extra.length
  )
    throw new Error('USAGE');
  const needsSymbol = kind === 'daily' || kind === 'info';
  if (needsSymbol ? !symbol || !/^[A-Z0-9./^-]{1,20}$/.test(symbol) : symbol !== '')
    throw new Error('USAGE');
  const [path, trId, example] = kinds[kind as keyof typeof kinds];
  let params: Record<string, string>;
  if (kind === 'info') {
    params = {
      PRDT_TYPE_CD: exchange === 'NAS' ? '512' : exchange === 'NYS' ? '513' : '529',
      PDNO: symbol,
    };
  } else if (kind === 'daily') {
    params = { AUTH: '', EXCD: exchange, SYMB: symbol, GUBN: '0', BYMD: '', MODP: '0' };
  } else {
    params = { EXCD: exchange, NDAY: '0', VOL_RANG: '0', KEYB: '', AUTH: '', PRC1: '', PRC2: '' };
  }
  const { KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCESS_TOKEN } = process.env;
  if (!KIS_APP_KEY || !KIS_APP_SECRET || !KIS_ACCESS_TOKEN) throw new Error('CREDENTIALS_MISSING');
  const url = new URL(`https://openapi.koreainvestment.com:9443/uapi/${path}`);
  url.search = new URLSearchParams(params).toString();
  const requestedAt = new Date().toISOString();
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${KIS_ACCESS_TOKEN}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: trId,
      custtype: 'P',
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('HTTP_FAILURE');
  const body = object(await response.json());
  if (body.rt_cd !== '0') throw new Error('KIS_FAILURE');
  const rawRows = kind === 'info' ? [body.output] : body.output2;
  if (!Array.isArray(rawRows) || rawRows.length > 1000) throw new Error('RESPONSE_SHAPE');
  const keys = kind === 'info' ? fields.info : kind === 'daily' ? fields.daily : fields.ranking;
  const continuation = response.headers.get('tr_cont') ?? '';
  if (!['', 'D', 'E', 'F', 'M'].includes(continuation)) throw new Error('RESPONSE_SHAPE');
  const record = {
    requestedAt,
    receivedAt: new Date().toISOString(),
    request: { path: `/uapi/${path}`, trId, params },
    source: `https://github.com/koreainvestment/open-trading-api/blob/${sourceCommit}/examples_llm/overseas_stock/${example}/${example}.py`,
    validation: 'unverified',
    dataSession: null,
    scope: 'one-page observation; not a candidate universe or verified premarket session',
    continuation,
    rowCount: rawRows.length,
    summary: kind === 'info' ? {} : select(body.output1, fields.summary),
    rows: rawRows.map((row) => select(row, keys)),
  };
  console.log(JSON.stringify(record));
} catch (error) {
  const safeCodes = [
    'USAGE',
    'RESPONSE_SHAPE',
    'CREDENTIALS_MISSING',
    'HTTP_FAILURE',
    'KIS_FAILURE',
  ];
  const code =
    error instanceof Error && safeCodes.includes(error.message) ? error.message : 'REQUEST_FAILED';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
