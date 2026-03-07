import { ErrorCodes, errorShape } from "../protocol/index.js";
import { getActiveWebListener, resolveWebAccountId } from "../../web/active-listener.js";
import type { GatewayRequestHandlers } from "./types.js";

export const whatsappHandlers: GatewayRequestHandlers = {
  "groups.fetchAll": async ({ params, respond }) => {
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
    const resolved = resolveWebAccountId(accountId);
    const listener = getActiveWebListener(resolved);

    if (!listener?.fetchAllGroups) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "WhatsApp not connected or groups fetch not available. Is the gateway running with an active WA session?",
        ),
      );
      return;
    }

    try {
      const groups = await listener.fetchAllGroups();
      // Convert map to array sorted by subject
      const list = Object.values(groups).sort((a, b) =>
        a.subject.localeCompare(b.subject),
      );
      respond(true, { ts: Date.now(), groups: list }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL, `groups.fetchAll failed: ${String(err)}`),
      );
    }
  },
};
