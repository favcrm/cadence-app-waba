import { ApiError } from "@cadence/screen-ui";
import type { DisplayScope } from "../../bridge/scope";
import { serviceCall } from "../../bridge/services";

export type Provider = "official" | "linked";
export type CopilotMode = "copilot" | "human-only";
export type Preferences = { provider: Provider; reply_mode: CopilotMode };
export type SavedPreferences = { profile: Preferences; revision: number };
const record_id = "waba_settings";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function receipt(value: unknown, installId: string): SavedPreferences {
  const record = object(object(value)?.record);
  const profile = object(record?.profile);
  const provider = profile?.provider, reply_mode = profile?.reply_mode, revision = record?.revision;
  if (record?.id !== record_id || record.install_id !== installId || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
      (provider !== "official" && provider !== "linked") || (reply_mode !== "copilot" && reply_mode !== "human-only")) {
    throw new ApiError("Invalid WhatsApp settings receipt", 502);
  }
  return { profile: { provider, reply_mode }, revision };
}

export async function readPreferences(scope: DisplayScope): Promise<SavedPreferences | null> {
  try { return receipt(await serviceCall(scope, "records.show", { record_id }), scope.installId); }
  catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}

export async function savePreferences(scope: DisplayScope, profile: Preferences, revision: number | null): Promise<SavedPreferences> {
  const result = receipt(revision === null
    ? await serviceCall(scope, "records.create", { record_id, profile })
    : await serviceCall(scope, "records.update", { record_id, profile, expected_revision: revision }), scope.installId);
  if (result.profile.provider !== profile.provider || result.profile.reply_mode !== profile.reply_mode || result.revision !== (revision ?? 0) + 1) {
    throw new ApiError("WhatsApp settings save could not be confirmed", 502);
  }
  return result;
}
