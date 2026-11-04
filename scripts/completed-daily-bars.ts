import type { queryKis } from './kis-query.ts';

const priceFields = ['open', 'high', 'low', 'clos'] as const;
const fields = [...priceFields, 'tvol'] as const;

type Observation = {
  id: string;
  securityId: string;
  date: string;
  field: (typeof fields)[number];
  value: string;
  requestedAt: string;
  source: string;
};

export class CompletedDailyBars {
  readonly #record;
  #referenceClose?: Observation;
  readonly #observations = new Map<string, Observation>();

  constructor(
    daily: Awaited<ReturnType<typeof queryKis>>,
    security: { exchange: string; symbol: string; rsym?: string },
    historyDates: readonly string[],
    dataSession: string,
  ) {
    const { rsym } = security;
    if (daily.summary.rsym !== undefined && daily.summary.rsym !== rsym)
      throw new Error('IDENTITY_AMBIGUOUS');
    const rows = new Map<string, Record<string, string>>();
    for (const row of daily.rows) {
      if (!/^\d{8}$/.test(row.xymd ?? '')) throw new Error('DATA_NOT_READY');
      const date = `${row.xymd.slice(0, 4)}-${row.xymd.slice(4, 6)}-${row.xymd.slice(6, 8)}`;
      if (
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        rows.has(date)
      )
        throw new Error('DATA_NOT_READY');
      rows.set(date, row);
    }
    const requiredRows = historyDates.map((date) => {
      const row = rows.get(date);
      if (!row) throw new Error('DATA_NOT_READY');
      const number = (field: string) => {
        if (!/^\d+(?:\.\d+)?$/.test(row[field] ?? '') || !Number.isFinite(Number(row[field])))
          throw new Error('DATA_NOT_READY');
        return Number(row[field]);
      };
      const [open, high, low, close] = priceFields.map(number);
      if (
        Math.min(open, high, low, close) <= 0 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        low > high ||
        number('tvol') < 0
      )
        throw new Error('DATA_NOT_READY');
      return row;
    });
    this.#record = {
      ...daily,
      rows: requiredRows,
      rowCount: requiredRows.length,
      dataSession,
      validation: 'runtime-required-dates-and-fields',
      adjustment: 'unadjusted (MODP=0); KIS field definitions used as an operating assumption',
      units: 'provider values preserved; unverified unit or scale conversion not applied',
    };
    const securityId = `${security.exchange}:${security.symbol}`;
    for (const [index, date] of historyDates.entries()) {
      const row = requiredRows[index];
      for (const field of fields) {
        const id = `${securityId}:${date}:${field}`;
        const observation = {
          id,
          securityId,
          date,
          field,
          value: row[field],
          requestedAt: daily.requestedAt,
          source: daily.source,
        };
        this.#observations.set(id, observation);
        if (date === dataSession && field === 'clos') this.#referenceClose = observation;
      }
    }
  }

  get rowCount() {
    return this.#record.rowCount;
  }

  toJSON() {
    return this.#record;
  }

  read() {
    return {
      adjustment: this.#record.adjustment,
      units: this.#record.units,
      observations: this.observations(),
    };
  }

  observations() {
    return [...this.#observations.values()];
  }

  observation(id: string) {
    return this.#observations.get(id);
  }

  referenceClose() {
    return this.#referenceClose;
  }
}
