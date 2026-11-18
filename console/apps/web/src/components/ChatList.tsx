import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, Button, IconButton, List, ListItem, ListItemButton, ListItemText, Menu, MenuItem, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useState, type MouseEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { ChatListItem, ChatStatus } from '../types/chat';
import { EmptyState, ErrorBanner, ListSkeleton, RelativeTime } from '../ui';
import { chatPaths, chatTitle, previewLine } from './chatThread';
import type { ChatListState } from './useChatList';

export type ChatRowAction = 'rename' | 'archive' | 'unarchive' | 'delete';

export interface ChatListProps {
  list: ChatListState;
  status: ChatStatus;
  onStatus: (status: ChatStatus) => void;
  /** The open chat, marked in the list. */
  selectedId: string | null;
  canWrite: boolean;
  onAction: (action: ChatRowAction, chat: ChatListItem) => void;
  /** Called when a row or "New chat" is followed (a drawer closes itself). */
  onNavigate?: () => void;
}

/** A green dot with words for a screen reader: the chat has a run that is live. */
function LiveDot() {
  return <Box component="span" role="img" aria-label="A run is live" sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', mr: 0.75, flex: 'none' }} />;
}

/** The user's chats: New chat, Active / Archived, and a row per chat with its menu. */
export function ChatList({ list, status, onStatus, selectedId, canWrite, onAction, onNavigate }: ChatListProps) {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; chat: ChatListItem } | null>(null);
  const open = (e: MouseEvent<HTMLElement>, chat: ChatListItem) => setMenu({ anchor: e.currentTarget, chat });
  const pick = (action: ChatRowAction) => {
    const chat = menu?.chat;
    setMenu(null);
    if (chat) onAction(action, chat);
  };

  return (
    <Box component="nav" aria-label="Chats" sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack spacing={1.5} sx={{ p: 1.5, pb: 1 }}>
        {canWrite && (
          <Button component={RouterLink} to={chatPaths.new} onClick={onNavigate} variant="contained" startIcon={<AddIcon />} fullWidth sx={{ minHeight: 44 }}>
            New chat
          </Button>
        )}
        <ToggleButtonGroup exclusive fullWidth size="small" value={status} onChange={(_e, next: ChatStatus | null) => next && onStatus(next)} aria-label="Which chats">
          <ToggleButton value="active" sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Active
          </ToggleButton>
          <ToggleButton value="archived" sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            Archived
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {list.error && (
        <Box sx={{ px: 1.5 }}>
          <ErrorBanner error={list.error} onRetry={() => void list.reload()} />
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {list.items === null ? (
          !list.error && (
            <Box sx={{ px: 1.5 }}>
              <ListSkeleton rows={4} />
            </Box>
          )
        ) : list.items.length === 0 ? (
          <EmptyState title={status === 'archived' ? 'No archived chats' : 'No chats yet'} body={status === 'archived' ? 'A chat you archive is kept here, read-only.' : 'Start one: say what you want done.'} />
        ) : (
          <List disablePadding>
            {list.items.map((chat) => (
              <ListItem
                key={chat.id}
                disablePadding
                secondaryAction={
                  canWrite ? (
                    <IconButton edge="end" aria-label={`Actions for ${chatTitle(chat)}`} onClick={(e) => open(e, chat)} sx={{ width: 44, height: 44 }}>
                      <MoreVertIcon />
                    </IconButton>
                  ) : undefined
                }
              >
                <ListItemButton component={RouterLink} to={chatPaths.chat(chat.id)} onClick={onNavigate} selected={chat.id === selectedId} aria-current={chat.id === selectedId ? 'page' : undefined} sx={{ minHeight: 64, pr: canWrite ? 7 : 2 }}>
                  <ListItemText
                    primary={
                      <Box component="span" sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                        {chat.liveRun && <LiveDot />}
                        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                          {chatTitle(chat)}
                        </Box>
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1, flex: 'none' }}>
                          <RelativeTime iso={chat.lastMessageAt} />
                        </Typography>
                      </Box>
                    }
                    secondary={previewLine(chat)}
                    slotProps={{ secondary: { noWrap: true } }}
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
        {list.hasMore && (
          <Box sx={{ p: 1.5 }}>
            <Button fullWidth onClick={() => void list.loadMore()} disabled={list.loadingMore} sx={{ minHeight: 44 }}>
              {list.loadingMore ? 'Loading…' : 'Show older chats'}
            </Button>
          </Box>
        )}
      </Box>
      <Menu anchorEl={menu?.anchor} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => pick('rename')}>Rename</MenuItem>
        {menu?.chat.status === 'archived' ? <MenuItem onClick={() => pick('unarchive')}>Unarchive</MenuItem> : <MenuItem onClick={() => pick('archive')}>Archive</MenuItem>}
        <MenuItem onClick={() => pick('delete')} sx={{ color: 'error.main' }}>
          Delete
        </MenuItem>
      </Menu>
    </Box>
  );
}
