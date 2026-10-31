const prices = new Map([
  ['gpt-6-astra', { input: 25, output: 50 }],
  ['gpt-6.1-sol', { input: 5, output: 10 }],
  ['gpt-6-luna', { input: 0.25, output: 0.5 }],
]);
const maxInputTokens = 32_000;
const maxOutputTokens = 8192;

export class PaidBudget {
  private reserved = 0;
  private requests = 0;
  private enabled = false;

  enable() {
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('PAID_CREDENTIALS_MISSING');
    this.enabled = true;
  }
  snapshot() {
    return {
      switched: this.enabled,
      limitUsd: 1,
      reservedUsd: this.reserved / 1_000_000,
      requests: this.requests,
    };
  }
  async prepare(serialized: string, signal: AbortSignal, remainingRequests: number) {
    const body = JSON.parse(serialized);
    const price = prices.get(body.model);
    if (!this.enabled || !price) throw new Error('PAID_BUDGET_UNPROVABLE');
    if (
      body.tools?.some(
        (item: { type: string; tools?: { type: string }[] }) =>
          item.type !== 'namespace' || !item.tools?.every((tool) => tool.type === 'function'),
      )
    )
      throw new Error('PAID_BUDGET_UNPROVABLE');
    body.max_output_tokens = maxOutputTokens;
    body.service_tier = 'default';
    body.store = false;
    body.stream = true;
    const headers = {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    };
    const countBody = Object.fromEntries(
      [
        'model',
        'input',
        'instructions',
        'tools',
        'tool_choice',
        'parallel_tool_calls',
        'reasoning',
        'text',
        'truncation',
        'personality',
      ]
        .filter((key) => body[key] !== undefined)
        .map((key) => [key, body[key]]),
    );
    let tokens: number;
    try {
      const response = await fetch('https://api.openai.com/v1/responses/input_tokens', {
        method: 'POST',
        headers,
        body: JSON.stringify(countBody),
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new Error('PAID_BUDGET_UNPROVABLE');
      tokens = (await response.json()).input_tokens;
    } catch {
      throw new Error('PAID_BUDGET_UNPROVABLE');
    }
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > maxInputTokens)
      throw new Error('PAID_BUDGET_UNPROVABLE');
    const cost = Math.ceil(tokens * price.input + maxOutputTokens * price.output);
    const future = Math.ceil(maxInputTokens * price.input + maxOutputTokens * price.output);
    if (this.reserved + cost + future * (remainingRequests - 1) > 1_000_000)
      throw new Error('PAID_BUDGET_EXCEEDED');
    signal.throwIfAborted();
    this.reserved += cost;
    this.requests++;
    return { headers, body: JSON.stringify(body) };
  }
}
