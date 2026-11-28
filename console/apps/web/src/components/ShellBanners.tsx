import { sliceBanners } from '../slices/manifest';

/**
 * What the enabled slices show above a page (the notification permission
 * banner, the Android app's update banner and its push registration). The
 * shell draws them above every padded page; a page that fills the window
 * (`useShellMainVariant('full-bleed')`) is given none, so the chat, which is
 * the home, draws them itself.
 */
export function ShellBanners() {
  return (
    <>
      {sliceBanners.map((Banner, index) => (
        <Banner key={index} />
      ))}
    </>
  );
}
