export type BehaviorRulesConfig = Record<string, unknown>;

export function buildWizardBehaviorRules(input: {
  preset: string;
  naturalLanguageRules?: string;
  maxTradeSol?: number;
  maxTradeUsd?: number;
}): BehaviorRulesConfig {
  const rules: BehaviorRulesConfig = {
    version: "1",
    preset: input.preset,
  };

  if (input.naturalLanguageRules?.trim()) {
    rules.rules = input.naturalLanguageRules.trim();
  }
  if (typeof input.maxTradeSol === 'number' && input.maxTradeSol > 0) {
    rules.maxTradeSol = input.maxTradeSol;
  }
  if (typeof input.maxTradeUsd === 'number' && input.maxTradeUsd > 0) {
    rules.maxTradeUsd = input.maxTradeUsd;
  }

  return rules;
}
