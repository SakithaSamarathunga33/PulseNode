"use client"

import { useCallback, useEffect, useRef } from "react"

/** `setTimeout` that is cancelled automatically when the component unmounts. */
export function useTimeouts() {
  const ids = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const live = ids.current
    return () => { live.forEach(clearTimeout); live.clear() }
  }, [])
  return useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => { ids.current.delete(id); fn() }, ms)
    ids.current.add(id)
    return id
  }, [])
}
