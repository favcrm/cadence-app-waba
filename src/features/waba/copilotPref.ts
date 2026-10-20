/** The per-install copilot preference. The screen frame is opaque-origin, so
 *  browser storage may be refused: the choice then lasts this session only,
 *  and `persisted` says so. The host has no app-preference store (CAD-1636). */
export type CopilotMode = "copilot" | "human-only";
const memory = new Map<string, CopilotMode>();
const key = (installId: string) => `waba.copilot.${installId}`;
export function readMode(installId: string): { mode: CopilotMode; persisted: boolean } {
  try {
    const v = localStorage.getItem(key(installId));
    if (v === "copilot" || v === "human-only") return { mode: v, persisted: true };
    return { mode: memory.get(installId) ?? "copilot", persisted: true };
  } catch { return { mode: memory.get(installId) ?? "copilot", persisted: false }; }
}
export function writeMode(installId: string, mode: CopilotMode): boolean {
  memory.set(installId, mode);
  try { localStorage.setItem(key(installId), mode); return true; } catch { return false; }
}
