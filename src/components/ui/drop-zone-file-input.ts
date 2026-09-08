/**
 * Classes for an `<input type="file">` that covers a drop zone.
 *
 * The input is the affordance: it fills the zone, so a click anywhere opens the
 * picker and Tab lands on it. It is made invisible by hiding its file-selector
 * button and its filename text rather than with `opacity-0`, because opacity
 * would also erase the global `:focus-visible` outline — which is what draws
 * the zone's focus indicator (#1573).
 *
 * The zone itself must be `relative`, and its contents `pointer-events-none` so
 * clicks reach the input underneath.
 */
export const DROP_ZONE_FILE_INPUT_CLASSES =
  "absolute inset-0 h-full w-full cursor-pointer bg-transparent text-transparent file:hidden";
