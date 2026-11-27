import { ApiError } from "@cadence/screen-ui";
import { useEffect,useRef,useSyncExternalStore } from "react";
import { exact } from "./channel";
import { OPERATIONS,type Section } from "./services";
export interface DisplayScope { installId: string; digest: string; provider?: "linked" }
export interface Route { section: Section; view: "list" | "new"; record_id: string | null; segment_id: string | null; params?: Record<string, string> }
export interface ScopeSnapshot { scope: DisplayScope; digest: string; actions: string[]; route: Route; presentationLocale: "en" | "zh-TW" }
let snapshot: ScopeSnapshot | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
export const subscribeScope = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getScope = () => snapshot;
export function useScope() { return useSyncExternalStore(subscribeScope, getScope); }
let hostDirty = false;
export function useHostDirty() { return useSyncExternalStore(subscribeScope, () => hostDirty); }
export function acceptComposeState(dirty: boolean, refresh: boolean): void {
  hostDirty = dirty;
  if (refresh) pushes++;
  notify();
}
// Counts accepted host pushes. A page re-reads in the background on each one.
let pushes = 0;
const getPushes = () => pushes;
/** Never run on mount. Coalesce pushes received during a refresh into one
 * more read so the last inbound change is not lost. */
export function useOnPush(refresh: () => Promise<unknown>): void {
  const count = useSyncExternalStore(subscribeScope, getPushes);
  const seen = useRef(count), latest = useRef(refresh), running = useRef(false), mounted = useRef(false);
  latest.current = refresh;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (count === seen.current || running.current) return;
    running.current = true;
    void (async () => {
      try {
        while (mounted.current && seen.current !== getPushes()) {
          seen.current = getPushes();
          await latest.current().catch(() => undefined);
        }
      } finally { running.current = false; }
    })();
  }, [count]);
}
export function scopeError() { return error; }
export function clearScope(reason: string): void { snapshot = null; hostDirty = false; error = reason; notify(); }
/** Set when the host never pushed a screen in time; a late push still wins. */
export function markUnreachable(): void { if (!snapshot) { error = "The WhatsApp host is unreachable. Reopen this screen from FavCRM."; notify(); } }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A selector the daemon's route fence admits (host #1189: 1–64 lowercase
 *  letters, digits, underscores or hyphens). Other ids, and any id an older
 *  host still refuses, stay a local selection. */
export const routable = (v: string) => /^[a-z0-9_-]{1,64}$/.test(v);
export const routeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
function invalid(): never { throw new ApiError("Invalid WhatsApp scope projection", 502); }
const PARAM_NAME = /^[a-z_]{1,24}$/;
const NO_CONTROLS = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/;
function parseRouteParams(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!obj(v)) invalid();
  const entries = Object.entries(v);
  if (entries.length > 6) invalid();
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (!PARAM_NAME.test(key) || typeof val !== "string" || val.length < 1 || val.length > 200 || !NO_CONTROLS.test(val)) invalid();
    out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
export function parseRoute(v: unknown): Route {
  if (!obj(v) || !exact(v, ["section", "view", "record_id", "segment_id", "params"]) || (v.section !== "connection" && v.section !== "inbox") || (v.view !== "list" && v.view !== "new") || (v.record_id !== null && !routeId(v.record_id)) || (v.segment_id !== null && !routeId(v.segment_id))) invalid();
  const params = parseRouteParams(v.params);
  return {
    section: v.section as Section,
    view: v.view as "list" | "new",
    record_id: v.record_id as string | null,
    segment_id: v.segment_id as string | null,
    ...(params ? { params } : {}),
  };
}
export function acceptPush(p: Record<string, unknown>): void {
  if (!exact(p, ["v", "op", "install_id", "context_id", "digest", "tag", "installation", "contexts", "runs", "outbox", "publish_intents", "sources", "defaults", "readiness", "actions", "now", "resume", "route", "read_observations", "presentation_locale"]) || p.tag !== "waba" || !routeId(p.install_id) || !(p.context_id === undefined || p.context_id === "" || routeId(p.context_id)) || !digest(p.digest) || !Array.isArray(p.actions) || !p.actions.every(a => typeof a === "string" && OPERATIONS.includes(a)) || new Set(p.actions).size !== p.actions.length) invalid();
  if (!obj(p.installation) || !exact(p.installation, ["install_id", "name", "title", "version", "digest", "summary"]) || p.installation.install_id !== p.install_id || p.installation.digest !== p.digest || p.installation.name !== "waba" || !["title", "version", "summary"].every(k => typeof (p.installation as Record<string, unknown>)[k] === "string") || (p.contexts !== undefined && (!Array.isArray(p.contexts) || !p.contexts.every(c => obj(c) && exact(c, ["id", "label"]) && routeId(c.id) && typeof c.label === "string")))) invalid();
  if (p.read_observations !== undefined && (!Array.isArray(p.read_observations) || p.read_observations.length > 16)) invalid();
  if (snapshot && (snapshot.scope.installId !== p.install_id || snapshot.digest !== p.digest)) invalid();
  // Preserve DisplayScope object identity across pushes for the same mount
  // so [scope] mount effects do not re-run non-quietly on host pushes.
  const scope = snapshot ? snapshot.scope : { installId: p.install_id as string, digest: p.digest as string };
  snapshot = { scope, digest: p.digest as string, actions: p.actions as string[], route: parseRoute(p.route), presentationLocale: p.presentation_locale === "zh-TW" ? "zh-TW" : "en" };
  pushes++; error = null; notify();
}
export function assertCurrentScope(scope: DisplayScope): void {
  if (!snapshot || scope.installId !== snapshot.scope.installId || scope.digest !== snapshot.digest) throw new ApiError("WhatsApp scope is absent or retired", 403);
}
export function requireOperation(verb: string): void {
  if (!snapshot || !OPERATIONS.includes(verb) || !snapshot.actions.includes(verb)) throw new ApiError("WhatsApp operation is unavailable on this mount", 403);
}
