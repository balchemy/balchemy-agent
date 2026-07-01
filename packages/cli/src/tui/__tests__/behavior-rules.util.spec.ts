import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWizardBehaviorRules } from '../../behavior-rules.util.js';

test('buildWizardBehaviorRules includes hard limits at top level for SDK loop', () => {
  const rules = buildWizardBehaviorRules({
    preset: 'memecoin_sniper',
    naturalLanguageRules: 'Max 0.05 SOL per trade',
    maxTradeSol: 0.05,
    maxTradeUsd: 10,
  });

  assert.equal(rules.preset, 'memecoin_sniper');
  assert.equal(rules.rules, 'Max 0.05 SOL per trade');
  assert.equal(rules.maxTradeSol, 0.05);
  assert.equal(rules.maxTradeUsd, 10);
});
