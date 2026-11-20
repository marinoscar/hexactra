// The outcome of a request the agent made of the owner (E40.1, E40.3), in a
// few words and a chip colour: never the value that was given.
import type { Question } from "./questions";

/** The chip of a request's outcome, from the server's words (`meta.outcome`) or the loaded question. */
export function outcomeChip(outcome: string | undefined): {
  label: string;
  color: "success" | "warning" | "default" | "info";
} {
  switch (outcome) {
    case "provided":
      return { label: "Provided", color: "success" };
    case "allowed":
      return { label: "Allowed", color: "success" };
    case "done by the owner":
      return { label: "Done", color: "success" };
    case "declined":
      return { label: "Declined", color: "default" };
    case "denied":
      return { label: "Denied", color: "default" };
    case "expired without an answer":
      return { label: "Expired", color: "warning" };
    case "waiting for the owner":
      return { label: "Waiting for you", color: "info" };
    default:
      return { label: "No longer kept", color: "default" };
  }
}

/** A question's outcome in the server's words (`requestOutcomeWords` in apps/api/src/questions/chat-request-record.ts). */
export const outcomeOf = (
  q: Pick<Question, "status" | "input" | "response">,
): string => {
  if (q.status === "pending") return "waiting for the owner";
  if (q.status === "expired") return "expired without an answer";
  if (q.status === "cancelled" || q.response?.outcome === "cancelled")
    return q.input === "confirm" ? "denied" : "declined";
  if (q.input === "confirm") return "allowed";
  if (q.input === "takeover" || q.input === "none") return "done by the owner";
  return "provided";
};
