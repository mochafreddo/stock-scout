import { type ExecutionContext, requestSignal } from './candidate-runtime.ts';
import { accessToken, invalidateToken } from './kis-auth.ts';

const sourceCommit = '2077773a69a428daf63e148182511f068cc45de3';
const kinds = {
  volume: ['overseas-stock/v1/ranking/trade-vol', 'HHDFS76310010', 'trade_vol'],
  amount: ['overseas-stock/v1/ranking/trade-pbmn', 'HHDFS76320010', 'trade_pbmn'],
  daily: ['overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', 'dailyprice'],
  info: ['overseas-price/v1/quotations/search-info', 'CTPF1702R', 'search_info'],
} as const;
export type KisQueryKind = keyof typeof kinds;
export type KisExchange = 'NAS' | 'NYS' | 'AMS';
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
  const result: Record<string, string> = {};
  for (const key of keys) if (typeof row[key] === 'string') result[key] = row[key];
  return result;
}
function kisFailure(body: Record<string, unknown>) {
  const error = new Error('KIS_FAILURE');
  return typeof body.msg_cd === 'string' && /^[A-Z0-9]{1,20}$/.test(body.msg_cd)
    ? Object.assign(error, { providerCode: body.msg_cd })
    : error;
}

export async function queryKis(
  kind: KisQueryKind,
  exchange: KisExchange,
  symbol = '',
  context: ExecutionContext = {},
) {
  context.runtime?.check();
  context.signal?.throwIfAborted();
  if (
    !kind ||
    !Object.hasOwn(kinds, kind) ||
    !exchange ||
    !['NAS', 'NYS', 'AMS'].includes(exchange)
  )
    throw new Error('USAGE');
  const needsSymbol = kind === 'daily' || kind === 'info';
  if (needsSymbol ? !symbol || !/^[A-Z0-9./^-]{1,20}$/.test(symbol) : symbol !== '')
    throw new Error('USAGE');
  const [path, trId, example] = kinds[kind];
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
  const { KIS_APP_KEY, KIS_APP_SECRET } = process.env;
  if (!KIS_APP_KEY || !KIS_APP_SECRET) throw new Error('CREDENTIALS_MISSING');
  let token = await accessToken(KIS_APP_KEY, KIS_APP_SECRET, undefined, context);
  context.runtime?.secrets.add(token);
  const url = new URL(`https://openapi.koreainvestment.com:9443/uapi/${path}`);
  url.search = new URLSearchParams(params).toString();
  const requestedAt = new Date().toISOString();
  const query = async () => {
    const signal = requestSignal(context, 15_000);
    context.runtime?.take('kis');
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P',
      },
      signal,
      redirect: 'error',
    });
    let body: Record<string, unknown>;
    try {
      body = object(await response.json());
      context.runtime?.check();
      context.signal?.throwIfAborted();
    } catch (error) {
      if (!response.ok) throw Object.assign(new Error('HTTP_FAILURE'), { status: response.status });
      throw error;
    }
    if (body.msg_cd === 'EGW00123') {
      if (body.rt_cd === '0') throw kisFailure(body);
      return { response, body, expired: true };
    }
    if (!response.ok) throw Object.assign(new Error('HTTP_FAILURE'), { status: response.status });
    if (body.rt_cd !== '0') throw kisFailure(body);
    return { response, body, expired: false };
  };
  let result = await query();
  if (result.expired) {
    token = await accessToken(KIS_APP_KEY, KIS_APP_SECRET, token, context);
    context.runtime?.secrets.add(token);
    result = await query();
    if (result.expired) {
      await invalidateToken(KIS_APP_KEY, KIS_APP_SECRET, token);
      throw kisFailure(result.body);
    }
  }
  const { response, body } = result;
  const rawRows = kind === 'info' ? [body.output] : body.output2;
  if (!Array.isArray(rawRows) || rawRows.length > 1000) throw new Error('RESPONSE_SHAPE');
  const keys = kind === 'info' ? fields.info : kind === 'daily' ? fields.daily : fields.ranking;
  const continuation = response.headers.get('tr_cont') ?? '';
  if (!['', 'D', 'E', 'F', 'M'].includes(continuation)) throw new Error('RESPONSE_SHAPE');
  return {
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
}
