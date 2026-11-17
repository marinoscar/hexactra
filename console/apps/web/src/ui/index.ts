// The console's own UI kit. Pages compose these; nothing here goes into a
// platform package. A new destructive action asks through `useConfirm()`.
export { PageContainer, type PageContainerProps, type PageWidth } from './PageContainer';
export { PageHeader, PRIMARY_ICON_MAX_LABEL, type PageAction, type PageHeaderProps } from './PageHeader';
export {
  StatusChip,
  STATUS_COLOR,
  STATUS_ICON,
  STOP_REASON_LABEL,
  isLive,
  isTerminal,
  showsStopReason,
  statusLabel,
  stopReasonLabel,
  type StatusChipProps,
  type StatusColor,
} from './StatusChip';
export { ConfirmDialog, ConfirmProvider, useConfirm, type Confirm, type ConfirmDialogProps, type ConfirmOptions } from './ConfirmDialog';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorBanner, type ErrorBannerProps } from './ErrorBanner';
export { CardSkeleton, ListSkeleton, type SkeletonProps } from './Skeletons';
export { ResponsiveList, type Column, type ListSelection, type ResponsiveListProps } from './ResponsiveList';
export { useBreakpoint, type Breakpoint } from './useBreakpoint';
export { NO_DATE, formatDateTime, formatRelative, formatTime, useProfileTimeZone, type FormatDateTimeOptions, type FormatRelativeOptions } from './time';
export { RelativeTime, type RelativeTimeProps } from './RelativeTime';
export { useApiAction, type ApiAction } from './useApiAction';
export { formatCost } from './formatCost';
