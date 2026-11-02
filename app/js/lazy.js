// Views that only some visitors need load the first time they open:
// friends never see the editor or the meal plan, and most visits never
// start cook mode or share a recipe.
//
// Each loader returns a promise of the module; `.now` is the module once it
// has loaded (null before), for code that only has to act when it is there,
// like taking a wake lock back or redrawing a plan on screen.

function lazy(load) {
  const get = () => (get.now ? Promise.resolve(get.now) : load().then((m) => (get.now = m)));
  get.now = null;
  return get;
}

export const cookView = lazy(() => import('./cook.js'));
export const editorView = lazy(() => import('./editor.js'));
export const shareView = lazy(() => import('./share.js'));
export const planView = lazy(() => import('./planner-view.js'));
