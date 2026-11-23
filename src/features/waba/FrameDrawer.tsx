import { DrawerShell, type DrawerShellProps } from "@cadence/screen-ui";
import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]';

/**
 * In-frame contact detail drawer wrapping `@cadence/screen-ui` DrawerShell as a
 * full-height right drawer over a frame-wide scrim while locking root scroll and
 * trapping Tab inside `.crm-drawer-shell`.
 */
export default function FrameDrawer(props: Omit<DrawerShellProps, "geometry" | "scrim">) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous; };
  }, []);
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      const panel = layer.current?.querySelector<HTMLElement>(".crm-drawer-shell");
      if (event.key !== "Tab" || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(node => node.getClientRects().length > 0);
      const first = nodes[0];
      const last = nodes.at(-1);
      const active = document.activeElement;
      const atStart = active === first || active === panel.querySelector(".crm-drawer-title") || !panel.contains(active);
      if (event.shiftKey && atStart) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, []);
  return <div className="waba-frame-drawer" ref={layer}><DrawerShell {...props} geometry={{ left: 0 }} /></div>;
}
