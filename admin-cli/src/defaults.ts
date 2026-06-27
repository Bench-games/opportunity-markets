export const DEFAULT_PLATFORM = {
  name: "bench",
  platformFeeBp: 50,
  rewardPoolFeeBp: 0,
  creatorFeeBp: 50,
  minTimeToVouchSeconds: 86_400n,
  revealPeriodSeconds: 2_592_000n,
  marketResolutionDeadlineSeconds: 604_800n,
};

export const DEFAULT_MARKET = {
  marketIndex: 0n,
  earlinessCutoffSeconds: 7_200n,
  earlinessMultiplier: 10_000,
  minVouchAmount: 1n,
};

export const DEFAULT_ARCIUM_CLUSTER_OFFSET = 456;
