import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, Button, IconButton, Link, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { useId, useState, type ElementType, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useBreakpoint } from './useBreakpoint';

/** One action of a page (a header button, a menu item, an empty state's button). */
export interface PageAction {
  key: string;
  label: string;
  /** An icon component, for example one of `@mui/icons-material`. */
  Icon?: ElementType;
  /** What the action does. Give `onClick` or `to`. */
  onClick?: () => void;
  /** Where the action goes, as a router link. */
  to?: string;
  color?: 'primary' | 'secondary' | 'inherit' | 'error' | 'warning' | 'success' | 'info';
  disabled?: boolean;
  /** A hidden action is not rendered (a permission the viewer lacks). */
  hidden?: boolean;
}

export interface PageHeaderProps {
  /** The page's `h1`. It wraps and never truncates. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** A link above the title, to the page this one belongs to. */
  back?: { to: string; label: string };
  /** Secondary actions: buttons from `sm` up, one "More" menu on a phone. */
  actions?: PageAction[];
  /** The page's main action: a contained button, always visible. */
  primary?: PageAction;
  /** The title's size; `h4` unless the title is long text (a run's goal). */
  variant?: 'h4' | 'h5' | 'h6';
  /** Rendered under the title and subtitle: chips, a status line. */
  children?: ReactNode;
}

/** A primary label longer than this gets a full-width button on a phone; a shorter one an icon button. */
export const PRIMARY_ICON_MAX_LABEL = 12;

/** The props that make a button or menu item a click target or a router link. */
function target(action: PageAction): Record<string, unknown> {
  return action.to !== undefined ? { component: RouterLink, to: action.to, onClick: action.onClick } : { onClick: action.onClick };
}

/**
 * The top of every page: an optional back link, the title, and the page's
 * actions. On a phone (below `sm`) the secondary actions collapse into one
 * "More" menu and the primary stays visible.
 */
export function PageHeader({ title, subtitle, back, actions, primary, variant = 'h4', children }: PageHeaderProps) {
  const { isPhone } = useBreakpoint();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const secondary = (actions ?? []).filter((a) => !a.hidden);
  const main = primary && !primary.hidden ? primary : null;
  const PrimaryIcon = main?.Icon;
  // On a phone a short primary is an icon button beside the title; a long one (or one without an icon) is a full-width button under it.
  const primaryAsIcon = isPhone && main !== null && PrimaryIcon !== undefined && main.label.length <= PRIMARY_ICON_MAX_LABEL;
  const primaryBelow = isPhone && main !== null && !primaryAsIcon;

  return (
    <Box component="header" sx={{ mb: { xs: 2, sm: 3 } }}>
      {back && (
        <Link component={RouterLink} to={back.to} variant="body2" underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', minHeight: { xs: 44, sm: 'auto' }, mb: { xs: 0, sm: 1 } }}>
          ← {back.label}
        </Link>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Typography variant={variant} component="h1" sx={{ flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: variant === 'h4' ? { xs: '1.625rem', sm: '2.125rem' } : undefined }}>
          {title}
        </Typography>
        {!isPhone && (secondary.length > 0 || main) && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', maxWidth: '60%' }}>
            {secondary.map((a) => {
              const Icon = a.Icon;
              return (
                <Button key={a.key} variant="outlined" color={a.color ?? 'primary'} disabled={a.disabled} startIcon={Icon ? <Icon /> : undefined} {...target(a)}>
                  {a.label}
                </Button>
              );
            })}
            {main && (
              <Button variant="contained" color={main.color ?? 'primary'} disabled={main.disabled} startIcon={PrimaryIcon ? <PrimaryIcon /> : undefined} {...target(main)}>
                {main.label}
              </Button>
            )}
          </Stack>
        )}
        {isPhone && (primaryAsIcon || secondary.length > 0) && (
          <Stack direction="row" sx={{ flexShrink: 0, alignItems: 'center' }}>
            {primaryAsIcon && main && PrimaryIcon && (
              <IconButton aria-label={main.label} color={main.color ?? 'primary'} disabled={main.disabled} sx={{ width: 44, height: 44 }} {...target(main)}>
                <PrimaryIcon />
              </IconButton>
            )}
            {secondary.length > 0 && (
              <IconButton
                aria-label="More"
                aria-haspopup="menu"
                aria-controls={anchor ? menuId : undefined}
                aria-expanded={anchor ? 'true' : undefined}
                sx={{ width: 44, height: 44 }}
                onClick={(e) => setAnchor(e.currentTarget)}
              >
                <MoreVertIcon />
              </IconButton>
            )}
          </Stack>
        )}
      </Stack>
      {subtitle && (
        <Typography color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
          {subtitle}
        </Typography>
      )}
      {children && <Box sx={{ mt: 1 }}>{children}</Box>}
      {primaryBelow && main && (
        <Button fullWidth variant="contained" color={main.color ?? 'primary'} disabled={main.disabled} startIcon={PrimaryIcon ? <PrimaryIcon /> : undefined} sx={{ mt: 2, minHeight: 44 }} {...target(main)}>
          {main.label}
        </Button>
      )}
      <Menu id={menuId} anchorEl={anchor} open={isPhone && Boolean(anchor)} onClose={() => setAnchor(null)}>
        {secondary.map((a) => {
          const Icon = a.Icon;
          return (
            <MenuItem
              key={a.key}
              disabled={a.disabled}
              sx={{ minHeight: 44, color: a.color === 'error' ? 'error.main' : undefined }}
              {...target(a)}
              onClick={() => {
                setAnchor(null);
                a.onClick?.();
              }}
            >
              {Icon && (
                <ListItemIcon sx={{ color: 'inherit' }}>
                  <Icon fontSize="small" />
                </ListItemIcon>
              )}
              <ListItemText>{a.label}</ListItemText>
            </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
}
