import { useCallback,useEffect,useRef,useState } from "react";
import type { DisplayScope } from "../../bridge/scope";
import { listFollowUps,listNamedThreads,type ThreadWork } from "./inboxWork";

type Page = { key: string; rows: ThreadWork[]; cursor: string | null; state: "loading" | "ok" | "failed" };

export function useWorkBrowse(scope: DisplayScope, inboxScope: string | null, mode: "due" | "names" | null, value: string) {
  const key = inboxScope && mode ? `${inboxScope}:${mode}:${value}` : null;
  const [page, setPage] = useState<Page | null>(null);
  const requests = useRef(0);
  const load = useCallback(async (cursor: string | null = null) => {
    if (!key || !inboxScope || !mode) return;
    const request = ++requests.current;
    setPage(previous => cursor && previous?.key === key ? { ...previous, state: "loading" } : { key, state: "loading", rows: [], cursor: null });
    try {
      const next = await (mode === "due" ? listFollowUps : listNamedThreads)(scope, inboxScope, value, cursor);
      if (request !== requests.current) return;
      setPage(previous => {
        const seen = cursor && previous?.key === key ? previous.rows : [];
        return { key, state: "ok", cursor: next.cursor, rows: [...seen, ...next.rows.filter(n => !seen.some(row => row.ref === n.ref))] };
      });
    } catch {
      if (request === requests.current) setPage(previous => previous?.key === key ? { ...previous, state: "failed" } : previous);
    }
  }, [scope, inboxScope, mode, key, value]);
  useEffect(() => {
    if (!key) { setPage(null); return; }
    if (mode === "due") void load();
    const timer = mode === "names" ? setTimeout(() => { void load(); }, 200) : undefined;
    return () => { requests.current++; clearTimeout(timer); };
  }, [key, mode, load]);
  const shown = key ? page?.key === key ? page : { key, rows: [], cursor: null, state: "loading" as const } : null;
  return { page: shown, load };
}
