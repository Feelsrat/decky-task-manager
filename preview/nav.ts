/**
 * A small model of Steam's gamepad navigation, driven by the arrow keys.
 *
 * Like Steam, containers flow vertically unless marked flow-children="horizontal", so
 * Left/Right only work inside rows that opt in. Enter = A, Escape/Backspace = B.
 */
type Dir = "up" | "down" | "left" | "right";

let current: HTMLElement | null = null;
const focusStack: (HTMLElement | null)[] = [];

function navRoot(): HTMLElement {
  const modals = document.querySelectorAll<HTMLElement>(".mock-modal-layer");
  return modals.length ? modals[modals.length - 1] : (document.getElementById("qam-content") as HTMLElement);
}

const isLeaf = (el: Element) => el.hasAttribute("data-nav-leaf");
const isFlow = (el: Element) => el.hasAttribute("data-nav-flow");

function navParent(el: HTMLElement, root: HTMLElement): HTMLElement {
  let node = el.parentElement;
  while (node && node !== root) {
    if (isFlow(node)) return node;
    node = node.parentElement;
  }
  return root;
}

function navChildren(container: HTMLElement, root: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-nav-leaf], [data-nav-flow]")).filter(
    (el) => navParent(el, root) === container && (isLeaf(el) || leavesIn(el).length > 0),
  );
}

function leavesIn(el: HTMLElement): HTMLElement[] {
  if (isLeaf(el)) return [el];
  return Array.from(el.querySelectorAll<HTMLElement>("[data-nav-leaf]"));
}

function centerX(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

function pickLeaf(node: HTMLElement, dir: Dir): HTMLElement | null {
  const leaves = leavesIn(node);
  if (leaves.length === 0) return null;
  if (dir === "right") return leaves[0];
  if (dir === "left") return leaves[leaves.length - 1];

  const x = current ? centerX(current) : 0;
  const edge = (el: HTMLElement) => (dir === "down" ? el.getBoundingClientRect().top : -el.getBoundingClientRect().bottom);
  const best = Math.min(...leaves.map(edge));
  const row = leaves.filter((el) => Math.abs(edge(el) - best) < 4);
  return row.sort((a, b) => Math.abs(centerX(a) - x) - Math.abs(centerX(b) - x))[0];
}

export function focus(el: HTMLElement | null) {
  current?.classList.remove("gpfocus");
  current = el;
  if (!el) return;
  el.classList.add("gpfocus");
  el.scrollIntoView({ block: "nearest" });
}

function ensureCurrent(): boolean {
  const root = navRoot();
  if (current && current.isConnected && root.contains(current) && isLeaf(current)) return true;
  focus(leavesIn(root)[0] || null);
  return false;
}

export function move(dir: Dir) {
  if (!ensureCurrent() || !current) return;
  const root = navRoot();
  const axis = dir === "up" || dir === "down" ? "vertical" : "horizontal";
  const step = dir === "up" || dir === "left" ? -1 : 1;

  let node: HTMLElement = current;
  while (node !== root) {
    const parent = navParent(node, root);
    const flow = parent === root ? "vertical" : parent.getAttribute("data-nav-flow");
    if (flow === axis) {
      const siblings = navChildren(parent, root);
      for (let i = siblings.indexOf(node) + step; i >= 0 && i < siblings.length; i += step) {
        const target = pickLeaf(siblings[i], dir);
        if (target) {
          focus(target);
          return;
        }
      }
    }
    node = parent;
  }
}

export function activate() {
  if (!ensureCurrent() || !current) return;
  current.click();
}

export function onModalOpened() {
  focusStack.push(current);
  requestAnimationFrame(() => focus(leavesIn(navRoot())[0] || null));
}

export function onModalClosed() {
  const previous = focusStack.pop() || null;
  requestAnimationFrame(() => focus(previous && previous.isConnected ? previous : leavesIn(navRoot())[0] || null));
}

/** Focus the first focusable element whose text contains `text` (used by screenshot scripts). */
export function focusText(text: string) {
  const match = leavesIn(navRoot()).find((el) => el.textContent?.includes(text));
  focus(match || null);
  return !!match;
}

export function currentLabel() {
  return current?.textContent?.trim() || current?.getAttribute("aria-label") || "";
}

export function installKeyboard(onBack: () => void) {
  window.addEventListener("keydown", (event) => {
    const keys: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (keys[event.key]) {
      event.preventDefault();
      move(keys[event.key]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    } else if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      onBack();
    }
  });
}
