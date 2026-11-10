export type RouteEffect = (install: () => () => void, label: string) => unknown
export declare function createRouteRegistry(): <Route>(
  effect: RouteEffect,
  register: (route: Route) => () => void,
  routes: () => Iterable<Route>,
  label: (route: Route) => string,
) => void
