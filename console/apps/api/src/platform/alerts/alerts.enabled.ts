import { isSliceEnabled } from '../slices/manifest';

/** Whether the alerts slice is mounted: incidents notify, so it needs the notifications and email slices. */
export function alertsMounted(): boolean {
  return isSliceEnabled('notifications') && isSliceEnabled('email');
}
