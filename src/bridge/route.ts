import { ApiError } from "@cadence/screen-ui";
import { getScope } from "./scope";
import { serviceCall,type CallArgs } from "./services";
/** The host owns the URL; the frame only asks it to move. */
export function patchRoute(patch: CallArgs["screen.route.patch"]): Promise<unknown> {
  const s = getScope();
  if (!s) return Promise.reject(new ApiError("WhatsApp route is unavailable", 403));
  return serviceCall(s.scope, "screen.route.patch", patch);
}
