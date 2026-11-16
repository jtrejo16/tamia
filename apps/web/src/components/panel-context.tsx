"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface PanelInfo {
  userId: string;
  userName: string;
  role: "owner" | "agent" | "viewer";
  tenantName: string;
  timezone: string;
  llmMode: "free" | "paid";
}

const Ctx = createContext<PanelInfo | null>(null);

export function PanelProvider({ value, children }: { value: PanelInfo; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanel(): PanelInfo {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePanel debe usarse dentro de PanelProvider");
  return v;
}

export const canAct = (role: PanelInfo["role"]) => role === "owner" || role === "agent";
