import { ApiError } from "@cadence/screen-ui";
import { useEffect,useRef,useSyncExternalStore } from "react";
import { exact } from "./channel";
import { OPERATIONS,type Section } from "./services";
export interface DisplayScope { installId: string; contextId: string }
export interface Route { section: Section; view: "list" | "new"; record_id: string | null; segment_id: string | null }
export interface ScopeSnapshot { scope: DisplayScope; digest: string; actions: string[]; route: Route }
let snapshot: ScopeSnapshot | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
export const subscribeScope = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getScope = () => snapshot;
export function useScope() { return useSyncExternalStore(subscribeScope, getScope); }
// Counts accepted host pushes. A page re-reads in the background on each one.
let pushes = 0;
const getPushes = () => pushes;
/** Runs `refresh` after every accepted host push (never on mount), one at a
 *  time: a push that lands while a refresh is in flight is skipped. */
export function useOnPush(refresh: () => Promise<unknown>): void {
  const count = useSyncExternalStore(subscribeScope, getPushes);
  const seen = useRef(count), latest = useRef(refresh), running = useRef(false);
  latest.current = refresh;
  useEffect(() => {
    if (count === seen.current || running.current) return;
    seen.current = count; running.current = true;
    void latest.current().finally(() => { running.current = false; });
  }, [count]);
}
export function scopeError() { return error; }
export function clearScope(reason: string): void { snapshot = null; error = reason; notify(); }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A selector the daemon's route fence admits (`proto::identifier`: 1–64
 *  lowercase letters, digits or hyphens). Other ids stay a local selection. */
export const routable = (v: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
export const routeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
function invalid(): never { throw new ApiError("Invalid WhatsApp scope projection", 502); }
export function parseRoute(v: unknown): Route {
  if (!obj(v) || !exact(v, ["section", "view", "record_id", "segment_id"]) || !["connection", "inbox", "templates", "broadcasts", "ai"].includes(v.section as string) || !["list", "new"].includes(v.view as string) || (v.record_id !== null && !routeId(v.record_id)) || (v.segment_id !== null && !routeId(v.segment_id))) invalid();
  return v as unknown as Route;
}
export function acceptPush(p: Record<string, unknown>): void {
  if (!exact(p, ["v", "op", "install_id", "context_id", "digest", "tag", "installation", "contexts", "runs", "outbox", "publish_intents", "sources", "defaults", "readiness", "actions", "now", "resume", "route", "read_observations", "presentation_locale"]) || p.tag !== "waba" || !routeId(p.install_id) || !(p.context_id === "" || routeId(p.context_id)) || !digest(p.digest) || !Array.isArray(p.actions) || !p.actions.every(a => typeof a === "string" && OPERATIONS.includes(a)) || new Set(p.actions).size !== p.actions.length) invalid();
  if (!obj(p.installation) || !exact(p.installation, ["install_id", "name", "title", "version", "digest", "summary"]) || p.installation.install_id !== p.install_id || p.installation.digest !== p.digest || p.installation.name !== "waba" || !["title", "version", "summary"].every(k => typeof (p.installation as Record<string, unknown>)[k] === "string") || !Array.isArray(p.contexts) || !p.contexts.every(c => obj(c) && exact(c, ["id", "label"]) && routeId(c.id) && typeof c.label === "string")) invalid();
  if (p.read_observations !== undefined && (!Array.isArray(p.read_observations) || p.read_observations.length > 16)) invalid();
  if (snapshot && (snapshot.scope.installId !== p.install_id || snapshot.scope.contextId !== p.context_id || snapshot.digest !== p.digest)) invalid();
  snapshot = { scope: { installId: p.install_id as string, contextId: p.context_id as string }, digest: p.digest as string, actions: p.actions as string[], route: parseRoute(p.route) };
  pushes++; error = null; notify();
}
export function assertCurrentScope(scope: DisplayScope): void {
  if (!snapshot || scope.installId !== snapshot.scope.installId || scope.contextId !== snapshot.scope.contextId) throw new ApiError("WhatsApp scope is absent or retired", 403);
}
export function requireOperation(verb: string): void {
  if (!snapshot || !OPERATIONS.includes(verb) || !snapshot.actions.includes(verb)) throw new ApiError("WhatsApp operation is unavailable on this mount", 403);
}
