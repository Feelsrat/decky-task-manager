/**
 * Steam fires onActivate for the A button and onClick for touch/mouse, and some builds fire
 * both for one press. Pass the returned handler to both props; repeat calls within a short
 * window are dropped so one press acts once.
 */
export function activateHandlers(action: () => void) {
  let last = 0;
  const handler = () => {
    const now = Date.now();
    if (now - last < 300) return;
    last = now;
    action();
  };
  return { onActivate: handler, onClick: handler };
}
