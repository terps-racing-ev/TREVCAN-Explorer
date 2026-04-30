import { useEffect, useState } from 'react';

/**
 * Returns true when the viewport is at or below the given breakpoint (px).
 * Defaults to 768px which matches our mobile/tablet breakpoint in CSS.
 */
export function useIsMobile(breakpointPx = 768) {
  const getMatch = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(`(max-width: ${breakpointPx}px)`).matches;
  };

  const [isMobile, setIsMobile] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const handler = (e) => setIsMobile(e.matches);
    // Safari < 14 uses addListener
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else mql.addListener(handler);
    setIsMobile(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else mql.removeListener(handler);
    };
  }, [breakpointPx]);

  return isMobile;
}

export default useIsMobile;
