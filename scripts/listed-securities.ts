import type { KisExchange } from './kis-query.ts';
import type { Security } from './security-type-assessment.ts';

type RankingObservation = {
  exchange: KisExchange;
  kind: 'volume' | 'amount';
  requestedAt: string;
  receivedAt: string;
  source: string;
  request: unknown;
  rowCount: number;
  continuation: string;
  selectedCount?: number;
  scope?: string;
};
type RankingEntry = {
  symbol: string;
  rsym: string;
  rank: number;
  row?: Record<string, string>;
};

export class ListedSecurities {
  private securities = new Map<string, Security>();
  private identities = new Map<string, string>();
  private observations: RankingObservation[] = [];

  addRanking(
    observation: RankingObservation,
    visit: (include: (entry: RankingEntry) => void) => void,
  ) {
    const securities = new Map(this.securities);
    const identities = new Map(this.identities);
    const provenance = structuredClone(observation);
    visit(({ symbol, rsym, rank, row }) => {
      const key = `${provenance.exchange}:${symbol}`;
      const existing = securities.get(key);
      if (
        (existing && existing.rsym !== rsym) ||
        (identities.has(rsym) && identities.get(rsym) !== key)
      )
        throw new Error('IDENTITY_AMBIGUOUS');
      identities.set(rsym, key);
      securities.set(key, {
        exchange: provenance.exchange,
        symbol,
        rsym,
        rankings: [
          ...(existing?.rankings ?? []),
          {
            kind: provenance.kind,
            rank,
            requestedAt: provenance.requestedAt,
            source: provenance.source,
            ...(row ? { row: structuredClone(row) } : {}),
          },
        ],
      });
    });
    this.securities = securities;
    this.identities = identities;
    this.observations.push(provenance);
  }

  snapshot() {
    return structuredClone({
      securities: [...this.securities.values()],
      observations: this.observations,
    });
  }
}
