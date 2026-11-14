import { useMemo } from "react";
import type { UiProfile } from "../api";

export interface UseProfileMetricsResult {
  profilesById: Map<string, UiProfile>;
  runningCount: number;
  selectedMobileCount: number;
  selectedProfilesSupportChromeExtensions: boolean;
  selectedPendingCount: number;
  selectedReadyCount: number;
}

/**
 * Computes derived profile counts and O(1) lookup maps so selection checks
 * never scan the full roster per selected row.
 */
export function useProfileMetrics(
  profiles: readonly UiProfile[],
  selected: ReadonlySet<string>,
): UseProfileMetricsResult {
  const profilesById = useMemo(() => {
    const map = new Map<string, UiProfile>();
    for (const profile of profiles) {
      map.set(profile.id, profile);
    }
    return map;
  }, [profiles]);

  const runningCount = useMemo(() => {
    let count = 0;
    for (const profile of profiles) {
      if (profile.running) count += 1;
    }
    return count;
  }, [profiles]);

  return useMemo(() => {
    let selectedMobileCount = 0;
    let selectedPendingCount = 0;
    let selectedReadyCount = 0;
    let selectedProfilesSupportChromeExtensions = true;

    for (const id of selected) {
      const profile = profilesById.get(id);
      if (!profile) {
        selectedProfilesSupportChromeExtensions = false;
        continue;
      }
      if (profile.mobilePersona) selectedMobileCount += 1;
      if (profile.engine !== "chromium") {
        selectedProfilesSupportChromeExtensions = false;
      }
      if (profile.running) selectedReadyCount += 1;
      else if ((profile.pendingCookieCount ?? 0) > 0) selectedPendingCount += 1;
    }

    return {
      profilesById,
      runningCount,
      selectedMobileCount,
      selectedProfilesSupportChromeExtensions,
      selectedPendingCount,
      selectedReadyCount,
    };
  }, [profilesById, runningCount, selected]);
}
