import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import { Box, Button, Chip, Link, Stack, Typography } from "@mui/material";
import { usePlatformHost } from "@marinoscar/platform-web/core";
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";

import { chatPaths } from "./chatThread";
import { requestTitle } from "./ChatRequest";
import type { Question, QuestionInput } from "./questions";
import { outcomeChip } from "./requestOutcome";
import {
  CardSkeleton,
  EmptyState,
  ErrorBanner,
  RelativeTime,
  ResponsiveList,
  type Column,
} from "../ui";

/** A request that is over (`GET /api/inbox/history`, E40.3). Masked; a secret's value is never here. */
export interface InboxHistoryItem {
  questionId: string;
  runId: string | null;
  conversationId: string | null;
  goal: string;
  askedBy: string;
  kind: string;
  input: QuestionInput;
  prompt: string;
  status: "answered" | "cancelled" | "expired";
  outcome: string;
  answer: {
    outcome: string;
    value?: string;
    valueWithheld: boolean;
    channel: string | null;
    answeredAt: string | null;
    fields?: { key: string; label: string; value?: string }[];
  } | null;
  createdAt: string;
  settledAt: string | null;
}

interface HistoryPage {
  items: InboxHistoryItem[];
  nextCursor: string | null;
}

const WRAP = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  minWidth: 0,
} as const;

/** What was given, in words: "Provided (not shown)" for a secret, the masked value or the form's fields otherwise. */
export function historyAnswerText(
  i: Pick<InboxHistoryItem, "answer" | "status" | "input">,
): string | null {
  const a = i.answer;
  if (!a || i.status !== "answered" || a.outcome === "cancelled") return null;
  if (a.valueWithheld) return "Provided (not shown)";
  if (a.fields?.length)
    return a.fields
      .map((f) => `${f.label}: ${f.value ?? "provided"}`)
      .join(" · ");
  return a.value ? a.value : null;
}

/** Where the request came from: its chat, its run, or nothing for a free-standing question. */
function sourceLink(i: InboxHistoryItem): { to: string; label: string } | null {
  if (i.conversationId)
    return { to: chatPaths.chat(i.conversationId), label: "Open the chat" };
  if (i.runId) return { to: `/runs/${i.runId}`, label: "Open the run" };
  return null;
}

function Outcome({ item }: { item: InboxHistoryItem }) {
  const chip = outcomeChip(item.outcome);
  return (
    <Chip
      size="small"
      label={chip.label}
      color={chip.color}
      variant={chip.color === "default" ? "outlined" : "filled"}
      data-outcome={chip.label}
      sx={{ flexShrink: 0 }}
    />
  );
}

const titleOf = (i: InboxHistoryItem) =>
  requestTitle({ input: i.input, kind: i.kind as Question["kind"] });

/**
 * The Inbox's History (E40.3): what agents asked and how each request ended,
 * newest first, so the owner can see later that information was provided,
 * declined or missed. A secret or a sign-in shows only that it was provided.
 */
export function InboxHistory() {
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxHistoryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      try {
        const page = await api.get<HistoryPage>(
          `/inbox/history${after ? `?cursor=${encodeURIComponent(after)}` : ""}`,
        );
        setItems((prev) =>
          after && prev ? [...prev, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the history");
      }
    },
    [api],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  const more = async () => {
    setLoadingMore(true);
    await load(cursor);
    setLoadingMore(false);
  };

  const columns: Column<InboxHistoryItem>[] = [
    {
      key: "request",
      header: "Request",
      render: (i) => (
        <Box sx={WRAP}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {titleOf(i)}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={WRAP}>
            {i.prompt}
          </Typography>
        </Box>
      ),
    },
    {
      key: "outcome",
      header: "Outcome",
      width: 140,
      render: (i) => <Outcome item={i} />,
    },
    {
      key: "answer",
      header: "What was given",
      hideBelow: "lg",
      render: (i) => (
        <Typography variant="body2" sx={WRAP}>
          {historyAnswerText(i) ?? "—"}
        </Typography>
      ),
    },
    {
      key: "when",
      header: "When",
      width: 140,
      render: (i) => <RelativeTime iso={i.settledAt ?? i.createdAt} />,
    },
  ];

  const card = (i: InboxHistoryItem) => {
    const link = sourceLink(i);
    const given = historyAnswerText(i);
    return (
      <Box sx={{ py: 1.5 }} data-history={i.questionId}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography
            variant="subtitle2"
            component="p"
            sx={{ flex: 1, ...WRAP }}
          >
            {titleOf(i)}
          </Typography>
          <Outcome item={i} />
        </Stack>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.5, ...WRAP }}
        >
          {i.prompt}
        </Typography>
        {given && (
          <Typography variant="body2" sx={{ mt: 0.5, ...WRAP }}>
            {given}
          </Typography>
        )}
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ mt: 0.5, alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}
        >
          <Typography variant="caption" color="text.secondary">
            <RelativeTime iso={i.settledAt ?? i.createdAt} />
          </Typography>
          <Link
            component={RouterLink}
            to={`/inbox/q/${i.questionId}`}
            variant="caption"
          >
            Details
          </Link>
          {link && (
            <Link component={RouterLink} to={link.to} variant="caption">
              {link.label}
            </Link>
          )}
        </Stack>
      </Box>
    );
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      <ErrorBanner error={error} />
      {items === null && !error && <CardSkeleton rows={2} />}
      {items?.length === 0 && (
        <EmptyState
          Icon={HistoryOutlinedIcon}
          title="No past requests"
          body="Requests you answered, declined or missed are listed here for a while, then deleted."
        />
      )}
      {items && items.length > 0 && (
        <ResponsiveList
          aria-label="Past requests"
          items={items}
          columns={columns}
          renderCard={card}
          getKey={(i) => i.questionId}
          getLabel={(i) => titleOf(i)}
          onRowClick={(i) => navigate(`/inbox/q/${i.questionId}`)}
          footer={
            cursor ? (
              <Button
                variant="outlined"
                onClick={() => void more()}
                disabled={loadingMore}
                sx={{ minHeight: { xs: 44, md: "auto" } }}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : undefined
          }
        />
      )}
    </Box>
  );
}
