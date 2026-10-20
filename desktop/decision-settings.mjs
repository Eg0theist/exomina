// Settings of the local decision layer and the always-on agent, shared by the main
// process (validation) and the renderer (display defaults).

export const DEFAULT_DECISION_SETTINGS = {
  enabled: true,      // local decisions (Tier 1 learning, Tier 2, Tier 3); off = nothing recorded or decided
  makeWay: true,      // "Make way for demanding apps": Tier 3 waits while a game, render or export runs
};

export const DEFAULT_AGENT_SETTINGS = {
  enabled: false,     // the always-on agent is opt-in
  dailyBudget: 10,    // most automatic runs per day, across all triggers
};

export const AGENT_BUDGET_MAX = 100;

export function normalizeDecisionSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {enabled: input.enabled !== false, makeWay: input.makeWay !== false};
}

export function normalizeAgentSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const budget = Number(input.dailyBudget);
  return {
    enabled: input.enabled === true,
    dailyBudget: Number.isInteger(budget) && budget >= 1 ? Math.min(AGENT_BUDGET_MAX, budget) : DEFAULT_AGENT_SETTINGS.dailyBudget,
  };
}
