import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Gates a route behind a flag listed in `FEATURES` (comma-separated env var),
 * e.g. `FEATURES=EXTRAS_ENABLED`. Enforced by `FeatureFlagGuard`.
 */
export const FeatureFlag = (flag: string) => SetMetadata(FEATURE_FLAG_KEY, flag);
