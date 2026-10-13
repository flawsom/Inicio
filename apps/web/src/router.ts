/**
 * Navigation.
 *
 * This lives on its own, not in landing.tsx, for one reason: both the landing page
 * and the console need to move between routes, and importing `navigate` from the
 * landing module would drag the landing's stylesheet and every symbol in it into
 * the console's bundle. A route change should not cost a reader the marketing page.
 *
 * The URL is the state and `popstate` is the transition, which is the whole router:
 * six paths and one event do not need a dependency.
 */
export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  // pushState does not fire popstate, and the app reads the route from it, so the
  // navigation is announced with the same event the back button produces.
  window.dispatchEvent(new PopStateEvent('popstate'));
}
