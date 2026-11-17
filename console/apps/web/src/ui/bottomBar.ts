// The one place that knows how tall the phone bottom bar is. Every element the
// app pins to the bottom of the window (a sticky action bar, a floating button)
// takes its offset from here, so none of them carries its own magic number.

/**
 * The height of the shell's bottom bar in CSS pixels. The platform's
 * `ShellBottomNav` is a MUI `BottomNavigation` (56 px) fixed at the bottom of
 * the window below `sm`; from `sm` up there is no bar.
 */
export const BOTTOM_BAR_HEIGHT = 56;

/** The device's bottom safe area (the home indicator), `0px` where there is none. */
export const SAFE_AREA_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

/**
 * The `bottom` of an element pinned above the bottom bar (`position: sticky`
 * or `fixed`), as a responsive `sx` value: clear of the bar and the safe area
 * on a phone, of the safe area alone from `sm` up.
 *
 * @param gap - extra space above the bar, in pixels.
 */
export function aboveBottomBar(gap = 0): { xs: string; sm: string } {
  return {
    xs: `calc(${BOTTOM_BAR_HEIGHT + gap}px + ${SAFE_AREA_BOTTOM})`,
    sm: `calc(${gap}px + ${SAFE_AREA_BOTTOM})`,
  };
}
