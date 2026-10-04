import type { ReactNode } from "react";

type Modal = { id: number; render: (close: () => void) => ReactNode };
type Toast = { id: number; title: ReactNode; body: ReactNode; critical?: boolean };

let modals: Modal[] = [];
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getModals = () => modals;
export const getToasts = () => toasts;

export function openModal(render: Modal["render"]) {
  const id = nextId++;
  modals = [...modals, { id, render }];
  emit();
  return id;
}

export function closeTopModal(id?: number) {
  modals = id === undefined ? modals.slice(0, -1) : modals.filter((modal) => modal.id !== id);
  emit();
}

export function pushToast(toast: Omit<Toast, "id">) {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }].slice(-3);
  emit();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 4000);
}
