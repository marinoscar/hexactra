import { Chip, Link, Paper, Stack, Typography } from "@mui/material";
import { usePlatformHost } from "@marinoscar/platform-web/core";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";

import type { ChatMessage } from "../types/chat";
import { requestTitle } from "./ChatRequest";
import { answerText, type Question } from "./questions";
import { outcomeChip, outcomeOf } from "./requestOutcome";

const CARD_MAX = { xs: "100%", sm: 480 } as const;
const WRAP = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  minWidth: 0,
} as const;
/** How often a waiting request is checked again, so the thread shows its outcome without a reload. */
export const REQUEST_RECHECK_MS = 5_000;

interface RequestMeta {
  questionId: string;
  input: Question["input"];
  questionKind: string;
  outcome?: string;
}

/** The request a `request` message records (E40.1), or null for a malformed one. */
export function requestMeta(
  message: Pick<ChatMessage, "kind" | "meta">,
): RequestMeta | null {
  if (message.kind !== "request") return null;
  const m = message.meta as Partial<RequestMeta> | null;
  return m && typeof m.questionId === "string"
    ? {
        questionId: m.questionId,
        input: (m.input ?? "text") as Question["input"],
        questionKind: String(m.questionKind ?? "other"),
        outcome: m.outcome,
      }
    : null;
}

/**
 * What a run asked the owner in this chat and how it ended (E40.1): kept in
 * the thread after it is answered, declined or expired. A secret or a sign-in
 * is never shown, only that it was provided. While it waits it is checked
 * again every few seconds; the card that answers it is the live request card.
 */
export function ChatRequestRecord({ message }: { message: ChatMessage }) {
  const { api } = usePlatformHost();
  const meta = requestMeta(message);
  const [q, setQ] = useState<Question | null>(null);
  const waiting = q
    ? q.status === "pending"
    : meta?.outcome === "waiting for the owner";

  useEffect(() => {
    if (!meta || !waiting) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await api.get<Question>(
          `/questions/${encodeURIComponent(meta.questionId)}`,
        );
        if (alive) setQ(next);
      } catch {
        // Gone (purged) or offline: keep what the thread said.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REQUEST_RECHECK_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [api, meta?.questionId, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meta) return null;
  const chip = outcomeChip(q ? outcomeOf(q) : meta.outcome);
  const detail = q && q.status !== "pending" ? answerText(q) : null;
  return (
    <Paper
      variant="outlined"
      component="article"
      aria-label="Request"
      data-request={meta.questionId}
      sx={{
        px: 1.5,
        py: 1,
        width: "100%",
        maxWidth: CARD_MAX,
        borderRadius: 3,
        my: 0.75,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Typography variant="subtitle2" component="p" sx={{ flex: 1, ...WRAP }}>
          {requestTitle({
            input: meta.input,
            kind: meta.questionKind as Question["kind"],
          })}
        </Typography>
        <Chip
          size="small"
          label={chip.label}
          color={chip.color}
          variant={chip.color === "default" ? "outlined" : "filled"}
          data-outcome={chip.label}
          sx={{ flexShrink: 0 }}
        />
      </Stack>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, ...WRAP }}
      >
        {message.text}
      </Typography>
      {detail && (
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 0.5, ...WRAP }}
        >
          {detail}
        </Typography>
      )}
      <Link
        component={RouterLink}
        to={`/inbox/q/${encodeURIComponent(meta.questionId)}`}
        variant="caption"
      >
        Details
      </Link>
    </Paper>
  );
}
