import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutlined';
import DashboardIcon from '@mui/icons-material/DashboardOutlined';
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
export const NAVIGATION: ShellNavigation<'chat' | 'overview' | 'inbox' | 'tasks' | 'runs' | 'kgraph' | 'fleet' | 'settings' | 'console'> = {
  destinations: [
    // Chat is the home (#713): `/` is a new chat, and every chat is under `/chat`.
    { key: 'chat', label: 'Chat', compactLabel: 'Chat', Icon: ChatBubbleOutlineIcon, path: '/', permission: 'chat:read' },
    { key: 'inbox', label: 'Inbox', compactLabel: 'Inbox', Icon: InboxOutlinedIcon, path: '/inbox', permission: 'runs:read', badge: useInboxBadge },
    // The dashboard of runs that was the home page until #713.
    { key: 'overview', label: 'Overview', compactLabel: 'Overview', Icon: DashboardIcon, path: '/overview' },
    { key: 'tasks', label: 'Tasks', compactLabel: 'Tasks', Icon: AssignmentOutlinedIcon, path: '/tasks', permission: 'tasks:read' },
    { key: 'runs', label: 'Runs', compactLabel: 'Runs', Icon: PlayCircleOutlineIcon, path: '/runs', permission: 'runs:read' },
    // The Knowledge Graph (E46.20): only while the deployment's and the viewer's own switch are on (the `kgraph` feature, App.tsx).
    { key: 'kgraph', label: 'Knowledge Graph', compactLabel: 'Learned', Icon: AccountTreeOutlinedIcon, path: '/kgraph', permission: 'kgraph:read', feature: 'kgraph' },
    { key: 'fleet', label: 'Fleet', compactLabel: 'Fleet', Icon: DnsOutlinedIcon, path: '/fleet', permission: 'fleet:read' },
    { key: 'settings', label: 'Settings', compactLabel: 'Settings', Icon: SettingsIcon, path: '/settings' },
    {
      key: 'console',
      label: 'Administration',
      compactLabel: 'Admin',
      Icon: AdminPanelSettingsIcon,
      path: '/admin/settings',
      anyPermission: ['system_settings:read', 'fabric_config:read', 'users:read', 'org_members:read', 'organizations:read', 'jobs:read', 'kgraph:admin', ...sliceConsolePermissions],
      pinned: true,
    },
  ],
  destinationRoutes: { chat: ['/', '/chat'], overview: ['/overview'], inbox: ['/inbox'], tasks: ['/tasks'], runs: ['/runs'], kgraph: ['/kgraph'], fleet: ['/fleet'], settings: ['/settings'], console: ['/admin'] },
  settingsSurfaces: [
    { sections: ADMIN_SECTIONS, hubPath: '/admin/settings', hubTitle: 'Administration' },
    { sections: USER_SETTINGS_SECTIONS, hubPath: '/settings', hubTitle: 'Settings' },
  ],
  console: { prefix: '/admin', sections: ADMIN_SECTIONS },
};

/** The daily destinations of the phone bottom bar (below `sm`), in this order: the first three are tabs, the rest are under "More". */
export const PHONE_BAR_KEYS = ['chat', 'inbox', 'overview', 'tasks', 'runs'] as const;

/**
 * What the phone bottom bar draws: Chat, Inbox, Overview and "More" (#486,
 * #713). The shell's bar shows `maxItems` (4) destinations, and with more than
 * that it draws the first three and a "More" tab that lists the others: Tasks
 * and Runs. Chat comes first because it is the home: where a job starts and
 * where the agent's requests for that job are answered. Fleet, Settings and
 * Administration stay reachable on a phone from the user menu, which lists
 * every destination of `NAVIGATION`. The routes table is the full one, so on
 * `/fleet` no tab is marked active.
 */
export const PHONE_NAVIGATION: typeof NAVIGATION = {
  ...NAVIGATION,
  // In the order of `PHONE_BAR_KEYS`, which is not the rail's order.
  destinations: PHONE_BAR_KEYS.flatMap((key) => NAVIGATION.destinations.filter((destination) => destination.key === key)),
};
