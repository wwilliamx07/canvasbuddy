import { useEffect, useState } from 'react';
import type { AppSettings } from '../settings';
import { accessOriginsFor } from '../providers/registry';
import type { ProviderAccessModel } from './model';

/**
 * Whether the extension may reach the chosen local or custom provider (`accessOriginsFor`). The
 * permission can only be requested from a click, so Settings shows a button while it is missing.
 */
export function useProviderAccess(settings: AppSettings): ProviderAccessModel {
  const origins = accessOriginsFor(settings);
  const key = origins.join(' ');
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    if (!origins.length) {
      setGranted(true);
      return;
    }
    let cancelled = false;
    setGranted(null);
    chrome.permissions
      .contains({ origins })
      .then((ok) => !cancelled && setGranted(ok))
      .catch(() => !cancelled && setGranted(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const grant = () => {
    chrome.permissions
      .request({ origins })
      .then(setGranted)
      .catch(() => setGranted(false));
  };

  return { origins, granted, grant };
}
