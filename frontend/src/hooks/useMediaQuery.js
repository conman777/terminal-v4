import { useEffect, useState } from 'react';

function matches(query) {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true;
}

// Whether a CSS media query currently matches; true when the browser cannot evaluate it.
export function useMediaQuery(query) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return value;
}
