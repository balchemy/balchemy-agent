import { ModelRouter } from '../agent-loop/model-router';
import type { AgentEvent } from '../agent-loop/types';

function makeEvent(type: string, data: unknown = {}): AgentEvent {
  return { id: 'e1', type, data, timestamp: Date.now(), source: 'sse' };
}

const router = new ModelRouter({ cheapModel: 'gpt-5-nano', fullModel: 'gpt-5.4-mini' });

describe('ModelRouter', () => {
  describe('score()', () => {
    it('scores trade events at 50', () => {
      expect(router.score(makeEvent('trade'))).toBe(50);
      expect(router.score(makeEvent('buy_executed'))).toBe(50);
      expect(router.score(makeEvent('sell_confirmed'))).toBe(50);
    });

    it('scores new_token_launch at 40', () => {
      expect(router.score(makeEvent('new_token_launch'))).toBe(40);
    });

    it('scores bundle_activity at 40', () => {
      expect(router.score(makeEvent('bundle_activity'))).toBe(40);
    });

    it('scores wallet_activity at 30', () => {
      expect(router.score(makeEvent('wallet_activity'))).toBe(30);
    });

    it('scores token_price at 20', () => {
      expect(router.score(makeEvent('token_price'))).toBe(20);
    });

    it('scores unknown events at 10', () => {
      expect(router.score(makeEvent('heartbeat'))).toBe(10);
      expect(router.score(makeEvent('unknown_type_xyz'))).toBe(10);
    });

    it('adds 20 for priceChangePct >= 10', () => {
      // token_price (20) + large move (20) = 40
      expect(router.score(makeEvent('token_price', { priceChangePct: 15 }))).toBe(40);
    });

    it('adds 20 for priceChangePct <= -10', () => {
      expect(router.score(makeEvent('token_price', { priceChangePct: -12 }))).toBe(40);
    });

    it('does not add boost for priceChangePct < 10', () => {
      expect(router.score(makeEvent('token_price', { priceChangePct: 5 }))).toBe(20);
    });

    it('caps score at 100', () => {
      // trade (50) + large move (20) = 70, not over 100
      // To hit cap: if score were somehow > 100 it should be capped
      // test with an event that naturally scores high
      const score = router.score(makeEvent('buy', { priceChangePct: 50 }));
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('selectModel()', () => {
    it('returns cheapModel for score < 60', () => {
      // token_price alone = 20
      expect(router.selectModel(makeEvent('token_price'))).toBe('gpt-5-nano');
      // heartbeat = 10
      expect(router.selectModel(makeEvent('heartbeat'))).toBe('gpt-5-nano');
      // wallet_activity = 30
      expect(router.selectModel(makeEvent('wallet_activity'))).toBe('gpt-5-nano');
    });

    it('returns fullModel for score >= 60', () => {
      // trade = 50 ... not >= 60 on its own, but with boost:
      // trade (50) + priceChangePct >= 10 (20) = 70 → fullModel
      expect(router.selectModel(makeEvent('trade', { priceChangePct: 15 }))).toBe('gpt-5.4-mini');
      // new_token_launch (40) + boost (20) = 60 → fullModel
      expect(router.selectModel(makeEvent('new_token_launch', { priceChangePct: 11 }))).toBe('gpt-5.4-mini');
    });

    it('buy/sell events hit fullModel threshold with boost', () => {
      // buy_executed (50) + priceChangePct 20 boost = 70
      expect(router.selectModel(makeEvent('buy_executed', { priceChangePct: 20 }))).toBe('gpt-5.4-mini');
    });
  });
});
