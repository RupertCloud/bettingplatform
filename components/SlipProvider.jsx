'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isSignedIn, onAuthChange } from '../lib/api';

const SlipContext = createContext(null);
const MAX_LEGS = 30;

export function SlipProvider({ children }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(isSignedIn());
    return onAuthChange(setSignedIn);
  }, []);

  /** Adds a selection, replacing any other pick from the same market; tapping the same pick removes it. */
  const toggle = useCallback((pick) => {
    setItems((cur) => {
      if (cur.some((i) => i.selectionId === pick.selectionId)) return cur.filter((i) => i.selectionId !== pick.selectionId);
      const rest = cur.filter((i) => i.marketId !== pick.marketId);
      if (rest.length >= MAX_LEGS) return cur;
      return [...rest, pick];
    });
  }, []);
  const remove = useCallback((selectionId) => setItems((cur) => cur.filter((i) => i.selectionId !== selectionId)), []);
  const updateOdds = useCallback(
    (selectionId, odds) => setItems((cur) => cur.map((i) => (i.selectionId === selectionId ? { ...i, odds } : i))),
    [],
  );
  const clear = useCallback(() => setItems([]), []);

  const value = useMemo(
    () => ({ items, toggle, remove, updateOdds, clear, open, setOpen, signedIn, setSignedIn }),
    [items, toggle, remove, updateOdds, clear, open, signedIn],
  );
  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export const useSlip = () => useContext(SlipContext);
