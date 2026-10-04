import type { ReactNode } from "react";
import { backend } from "../mockBackend";
import { pushToast } from "../modalHost";

const LATENCY_MS = Number(new URLSearchParams(location.search).get("latency") ?? 120);

export function callable<Args extends unknown[], Result>(name: string) {
  return async (...args: Args): Promise<Result> => {
    const handler = (backend as Record<string, (...a: unknown[]) => unknown>)[name];
    if (!handler) throw new Error(`Mock backend has no method ${name}`);
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    const result = await handler(...args);
    // Round-trip through JSON like the real Python bridge
    return JSON.parse(JSON.stringify(result)) as Result;
  };
}

export const toaster = {
  toast: (toast: { title: ReactNode; body: ReactNode; critical?: boolean }) => pushToast(toast),
};

export function definePlugin<T>(factory: () => T): T {
  return factory();
}
