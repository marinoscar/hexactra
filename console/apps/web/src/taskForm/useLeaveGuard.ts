import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

/**
 * Asks before leaving a page with unsaved changes.
 *
 * - In-app navigation (a link, `navigate()`): `ask()` decides; the navigation
 *   runs only when it resolves true.
 * - Closing or reloading the tab: the browser's own `beforeunload` prompt.
 *
 * The app runs on `<BrowserRouter>`, where react-router's `useBlocker` is not
 * available (it needs a data router), so this guards the router's navigator
 * instead. The browser's Back button is not intercepted.
 *
 * @returns `allow()`: call it before a navigation that must not ask (after a save).
 */
export function useLeaveGuard(when: boolean, ask: () => Promise<boolean>): () => void {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const askRef = useRef(ask);
  askRef.current = ask;
  const allowed = useRef(false);
  const asking = useRef(false);

  useEffect(() => {
    if (!when) return;
    const { push, replace } = navigator;
    const restore = () => {
      navigator.push = push;
      navigator.replace = replace;
    };
    const guard = (proceed: () => void) => {
      if (allowed.current) return proceed();
      if (asking.current) return;
      asking.current = true;
      void askRef.current().then((leave) => {
        asking.current = false;
        if (!leave) return;
        allowed.current = true;
        restore();
        proceed();
      });
    };
    navigator.push = (...args) => guard(() => push.apply(navigator, args));
    navigator.replace = (...args) => guard(() => replace.apply(navigator, args));
    return restore;
  }, [when, navigator]);

  useEffect(() => {
    if (!when) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (allowed.current) return;
      event.preventDefault();
      // Chrome shows its prompt only when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);

  return useCallback(() => {
    allowed.current = true;
  }, []);
}
