import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlined';
import HomeIcon from '@mui/icons-material/Home';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import SettingsIcon from '@mui/icons-material/Settings';
import type { ShellNavigation } from '@marinoscar/platform-web/shell/headless';

import { useInboxBadge } from '../components/InboxCountProvider';
import { sliceConsolePermissions } from '../slices/manifest';
import { ADMIN_SECTIONS } from './adminSections';
import { USER_SETTINGS_SECTIONS } from './userSettingsSections';

/**
 * The app's navigation, declared once: the platform shell's rail and user menu
 * draw these (the phone bottom bar draws `PHONE_NAVIGATION`), the compact AppBar
 * drills into the two settings hubs, and the rail lists the admin cards on
 * `/admin/*` (Console mode). Every `permission` is the exact string the API
 * enforces; the Console shows for anyone who can open one of its cards.
 */
export const NAVIGATION: ShellNavigation<'home' | 'chat' | 'inbox' | 'tasks' | 'runs' | 'fleet' | 'settings' | 'console'> = {
  destinations: [
    { key: 'home', label: 'Home', compactLabel: 'Home', Icon: HomeIcon, path: '/' },
    { key: 'chat', label: 'Chat', compactLabel: 'Chat', Icon: ChatBubbleOutlineIcon, path: '/chat', permission: 'chat:read' },
    { key: 'inbox', label: 'Inbox', compactLabel: 'Inbox', Icon: InboxOutlinedIcon, path: '/inbox', permission: 'runs:read', badge: useInboxBadge },
    { key: 'tasks', label: 'Tasks', compactLabel: 'Tasks', Icon: AssignmentOutlinedIcon, path: '/tasks', permission: 'tasks:read' },
    { key: 'runs', label: 'Runs', compactLabel: 'Runs', Icon: PlayCircleOutlineIcon, path: '/runs', permission: 'runs:read' },
    { key: 'fleet', label: 'Fleet', compactLabel: 'Fleet', Icon: DnsOutlinedIcon, path: '/fleet', permission: 'fleet:read' },
    { key: 'settings', label: 'Settings', compactLabel: 'Settings', Icon: SettingsIcon, path: '/settings' },
    {
      key: 'console',
      label: 'Administration',
      compactLabel: 'Admin',
      Icon: AdminPanelSettingsIcon,
      path: '/admin/settings',
      anyPermission: ['system_settings:read', 'fabric_config:read', 'users:read', 'org_members:read', 'organizations:read', 'jobs:read', ...sliceConsolePermissions],
      pinned: true,
    },
  ],
  destinationRoutes: { home: ['/'], chat: ['/chat'], inbox: ['/inbox'], tasks: ['/tasks'], runs: ['/runs'], fleet: ['/fleet'], settings: ['/settings'], console: ['/admin'] },
  settingsSurfaces: [
    { sections: ADMIN_SECTIONS, hubPath: '/admin/settings', hubTitle: 'Administration' },
    { sections: USER_SETTINGS_SECTIONS, hubPath: '/settings', hubTitle: 'Settings' },
  ],
  console: { prefix: '/admin', sections: ADMIN_SECTIONS },
};

/** The daily destinations of the phone bottom bar (below `sm`), in this order: the first three are tabs, the rest are under "More". */
export const PHONE_BAR_KEYS = ['home', 'chat', 'inbox', 'tasks', 'runs'] as const;

/**
 * What the phone bottom bar draws: Home, Chat, Inbox and "More" (#486). The
 * shell's bar shows `maxItems` (4) destinations, and with more than that it
 * draws the first three and a "More" tab that lists the others: Tasks and
 * Runs. Chat takes a tab because it is where a job starts and where the
 * agent's requests for that job are answered. Fleet, Settings and
 * Administration stay reachable on a phone from the user menu, which lists
 * every destination of `NAVIGATION`. The routes table is the full one, so on
 * `/fleet` no tab is marked active.
 */
export const PHONE_NAVIGATION: typeof NAVIGATION = {
  ...NAVIGATION,
  // In the order of `PHONE_BAR_KEYS`, which is not the rail's order.
  destinations: PHONE_BAR_KEYS.flatMap((key) => NAVIGATION.destinations.filter((destination) => destination.key === key)),
};
