import type { AgentEvent } from './types';

/**
 * ModelRouter — routes each event to either the cheap model or the full model
 * based on its significance score.
 *
 * Significance scoring rules (additive, capped at 100):
 *   - trade / buy / sell type:   +50
 *   - new_token_launch:          +40
 *   - bundle_activity:           +40
 *   - wallet_activity:           +30
 *   - token_price:               +20
 *   - numeric priceChangePct >= 10 in data: +20
 *   - unknown event type:        +10 (safe default)
 *
 * Threshold: score < 60 → cheapModel, score >= 60 → fullModel.
 */

export interface ModelRouterConfig {
  cheapModel: string;
  fullModel: string;
}

export class ModelRouter {
  private readonly cheapModel: string;
  private readonly fullModel: string;

  constructor(config: ModelRouterConfig) {
    this.cheapModel = config.cheapModel;
    this.fullModel = config.fullModel;
  }

  /**
   * Returns the model name to use for this event.
   */
  selectModel(event: AgentEvent): string {
    const score = this.score(event);
    return score >= 60 ? this.fullModel : this.cheapModel;
  }

  /**
   * Compute a significance score (0-100) for an event.
   * Exposed for testing.
   */
  score(event: AgentEvent): number {
    let points = 0;

    const type = (event.type ?? '').toLowerCase();

    if (type.includes('trade') || type.includes('buy') || type.includes('sell')) {
      points += 50;
    } else if (type === 'new_token_launch') {
      points += 40;
    } else if (type === 'bundle_activity') {
      points += 40;
    } else if (type === 'wallet_activity') {
      points += 30;
    } else if (type === 'token_price') {
      points += 20;
    } else {
      points += 10;
    }

    // Boost for large price moves
    const data = event.data as Record<string, unknown> | null | undefined;
    if (data && typeof data === 'object') {
      const pct = data['priceChangePct'];
      if (typeof pct === 'number' && Math.abs(pct) >= 10) {
        points += 20;
      }
    }

    return Math.min(100, points);
  }
}
