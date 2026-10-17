import assert from 'node:assert/strict';

globalThis.fetch = async (url, options) => {
  const request = new URL(url);
  assert.equal(request.origin, 'https://openapi.koreainvestment.com:9443');
  assert.equal(
    options.headers.tr_id,
    {
      '/uapi/overseas-stock/v1/ranking/trade-vol': 'HHDFS76310010',
      '/uapi/overseas-stock/v1/ranking/trade-pbmn': 'HHDFS76320010',
      '/uapi/overseas-price/v1/quotations/dailyprice': 'HHDFS76240000',
      '/uapi/overseas-price/v1/quotations/search-info': 'CTPF1702R',
    }[request.pathname],
  );
  assert.equal(options.headers.authorization, 'Bearer test-token');
  assert.equal(options.redirect, 'error');
  const scenario = process.env.SCENARIO;
  if (scenario === 'transport-error') throw new Error('test-token test-secret');
  if (scenario === 'http-error') return new Response('test-token', { status: 500 });
  if (scenario === 'malformed') return new Response('test-secret');
  if (scenario === 'api-error')
    return Response.json({
      rt_cd: '1',
      msg1: 'test-token',
      output1: { nrec: '1' },
      output2: [{ symb: 'AAPL', rank: '1', tvol: '123' }],
    });
  if (scenario === 'bad-rows') return Response.json({ rt_cd: '0', output2: {} });
  const body = { rt_cd: '0', msg_cd: 'MCA00000', output1: { nrec: '1' } };
  if (request.pathname.endsWith('search-info')) {
    assert.equal(
      request.searchParams.get('PRDT_TYPE_CD'),
      { NAS: '512', NYS: '513', AMS: '529' }[process.argv[3]],
    );
    body.output = { std_pdno: 'US0378331005', ovrs_stck_dvsn_cd: '01', account: 'account-secret' };
  } else if (request.pathname.endsWith('dailyprice')) {
    assert.equal(request.searchParams.get('GUBN'), '0');
    assert.equal(request.searchParams.get('MODP'), '0');
    body.output2 = [{ xymd: '20261016', clos: '250.00', tvol: '123', account: 'account-secret' }];
  } else {
    body.output2 =
      scenario === 'empty'
        ? []
        : [
            {
              symb: 'AAPL',
              excd: 'NAS',
              rank: '1',
              tvol: '123',
              tamt: '456',
              account: 'account-secret',
            },
          ];
  }
  return Response.json(body, { headers: { tr_cont: scenario === 'continued' ? 'M' : 'D' } });
};
