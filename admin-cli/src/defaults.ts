export const DEFAULT_PLATFORM = {
  name: "bench",
  userPlatformFeeBp: 50,
  userRewardPoolFeeBp: 0,
  userCreatorFeeBp: 50,
  sponsorPlatformFeeBp: 0,
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
